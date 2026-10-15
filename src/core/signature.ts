/**
 * Failure fingerprinting (req 5: a zero-context model never repeats a failure).
 *
 * A guardrail is deduplicated on `sig` = tool + canonicalized input fingerprint
 * + normalized error class. Volatile fragments (ids, hashes, versions, dates,
 * numbers, absolute temp paths, quoted strings) are replaced with placeholders
 * so the same failure maps to the same signature across sessions and machines.
 */
import type { Guardrail } from "./learnings.ts"

export const GUARDRAIL_MATCH_THRESHOLD = 0.6
const LONG_VALUE_THRESHOLD = 64

// ---------------------------------------------------------------------------
// Volatile normalization
// ---------------------------------------------------------------------------

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/")
}

/** Replace volatile fragments with stable placeholders (order matters). */
export function normalizeVolatile(input: string): string {
  let text = stripAnsi(input).replace(/\r?\n/g, " ")
  text = text.replace(/0x[0-9a-f]+/gi, "<hex>")
  text = text.replace(/\b[0-9a-f]{7,64}\b/gi, "<hash>")
  text = text.replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, "<date>")
  text = text.replace(/\b\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?\b/g, "<ver>")
  text = text.replace(
    /(?:\/Users\/[^\s:"')\]]*|\/home\/[^\s:"')\]]*|\/private\/[^\s:"')\]]*|\/var\/folders\/[^\s:"')\]]*|\/tmp\/[^\s:"')\]]*)/g,
    "<path>",
  )
  text = text.replace(/(?:'[^'\n]{1,80}'|`[^`\n]{1,80}`|"[^"\n]{1,80}")/g, "<str>")
  text = text.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|minutes?|hours?)\b/gi, "<dur>")
  text = text.replace(/\b\d+\b/g, "<n>")
  return collapseWhitespace(text)
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

// ---------------------------------------------------------------------------
// Call + error normalization
// ---------------------------------------------------------------------------

export interface NormalizedCall {
  /** Stable identity of the call (what was attempted). */
  fingerprint: string
  /** Human display of the call, for guardrail fix lines. */
  display: string
}

const PATH_KEYS = ["filePath", "file_path", "path", "file", "filename"] as const

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return undefined
}

function stableValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return value.length > LONG_VALUE_THRESHOLD ? `<${value.length} chars>` : value
  if (depth <= 0) return "<deep>"
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => stableValue(item, depth - 1))
  if (typeof value === "object") {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = stableValue(source[key], depth - 1)
    return out
  }
  return undefined
}

/** Deterministic JSON: sorted keys, long strings collapsed, bounded depth. */
export function stableStringify(value: unknown, maxDepth = 4): string {
  return JSON.stringify(stableValue(value, maxDepth)) ?? String(value)
}

export function normalizeCall(tool: string, input: unknown): NormalizedCall {
  if (typeof input === "string") {
    const text = collapseWhitespace(input)
    return { fingerprint: truncate(normalizeVolatile(text), 120), display: truncate(text, 80) }
  }
  const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const command = firstString(record, ["command", "cmd"])
  if (command) {
    const text = collapseWhitespace(command)
    return { fingerprint: truncate(normalizeVolatile(text), 120), display: truncate(text, 80) }
  }
  const path = firstString(record, PATH_KEYS)
  if (path) {
    const text = normalizeSlashes(path)
    return { fingerprint: truncate(text, 120), display: truncate(text, 80) }
  }
  const stable = stableStringify(record)
  return { fingerprint: truncate(stable, 120), display: truncate(`${tool} ${stable}`, 80) }
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message || error.name
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export interface FailureSignature {
  sig: string
  tool: string
  fingerprint: string
  errorSample: string
}

export function signatureFor(tool: string, input: unknown, error: unknown): FailureSignature {
  const call = normalizeCall(tool, input)
  const errorSample = truncate(normalizeVolatile(errorText(error)), 160)
  return {
    sig: truncate(`${tool}::${call.fingerprint}::${errorSample}`, 400),
    tool,
    fingerprint: call.fingerprint,
    errorSample,
  }
}

// ---------------------------------------------------------------------------
// Matching (pre-flight / coaching / resolve correlation)
// ---------------------------------------------------------------------------

export interface CallLike {
  tool: string
  input: unknown
}

export function tokenSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 1))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}

export interface GuardrailMatch {
  match: boolean
  exact: boolean
  score: number
}

/** Does a planned call look like the recorded failure? */
export function matchGuardrail(record: Guardrail, call: CallLike): GuardrailMatch {
  if (record.tool !== call.tool) return { match: false, exact: false, score: 0 }
  const normalized = normalizeCall(call.tool, call.input)
  if (normalized.fingerprint === record.fingerprint) return { match: true, exact: true, score: 1 }
  const score = jaccard(tokenSet(normalized.fingerprint), tokenSet(record.fingerprint))
  return { match: score >= GUARDRAIL_MATCH_THRESHOLD, exact: false, score }
}

/**
 * Is a *successful* call a candidate fix for a guardrail? True when the tool
 * matches and the successful input differs from the failing one. Callers add
 * the "was surfaced in this session" condition (server, Phase 3).
 */
export function canResolveWith(record: Guardrail, call: CallLike): boolean {
  if (record.tool !== call.tool) return false
  return normalizeCall(call.tool, call.input).fingerprint !== record.fingerprint
}
