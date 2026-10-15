/**
 * Just-in-time relevance (req 3 + 5).
 *
 * Deterministic matching of the current turn — user-message keywords plus
 * file paths and commands from recent tool calls — against issue threads
 * (incl. regression watch for fixed/closed ones), corrections, lessons and
 * guardrails. No LLM, no dependencies; runs in the model-call path.
 */
import type { Entry } from "./store.ts"
import type { Guardrail, Issue, Learning } from "./learnings.ts"
import { lessonRef, REGRESSION_WATCH_STATUSES } from "./learnings.ts"
import { entryRef } from "./audit.ts"
import { tokenize } from "./search.ts"
import { normalizeSlashes, tokenSet } from "./signature.ts"

export const JIT_MAX_MATCHES = 6
export const JIT_GUARDRAIL_CMD_THRESHOLD = 0.5

export const JIT_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "you",
  "your",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "from",
  "into",
  "can",
  "could",
  "should",
  "would",
  "will",
  "just",
  "about",
  "please",
  "use",
  "using",
  "get",
  "got",
  "let",
  "its",
  "our",
  "how",
  "why",
  "what",
  "when",
  "does",
  "did",
  "doing",
  "make",
  "made",
  "need",
  "want",
  "is",
  "be",
  "been",
  "at",
  "by",
  "or",
  "if",
  "of",
  "to",
  "in",
  "it",
  "an",
  "as",
  "so",
])

export interface TurnContext {
  /** Current user message text (or the latest input). */
  text?: string | undefined
  /** File paths from recent tool calls. */
  files?: string[] | undefined
  /** Commands from recent tool calls. */
  commands?: string[] | undefined
}

export interface JitMatch {
  type: "thread" | "correction" | "guardrail" | "lesson"
  id: string
  title: string
  reason: string
  score: number
  /** One-line extra context (latest thread note, lesson takeaway, guardrail fix). */
  detail?: string
  status?: string
  regressionWatch?: boolean
}

export interface JitInputs {
  ctx: TurnContext
  threads: Issue[]
  corrections: Entry[]
  lessons: Learning[]
  guardrails: Guardrail[]
}

const TYPE_ORDER: Record<JitMatch["type"], number> = { thread: 0, correction: 1, guardrail: 2, lesson: 3 }

export function keywordSet(ctx: TurnContext): Set<string> {
  const keywords = new Set<string>()
  const add = (text: string): void => {
    for (const token of tokenize(text)) if (!JIT_STOPWORDS.has(token)) keywords.add(token)
  }
  if (ctx.text) add(ctx.text)
  for (const command of ctx.commands ?? []) add(command)
  return keywords
}

// ---------------------------------------------------------------------------
// Glob-lite area matching
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function globToRegExpSource(pattern: string): string {
  let out = ""
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 3
        } else {
          out += ".*"
          i += 2
        }
      } else {
        out += "[^/]*"
        i += 1
      }
    } else if (char === "?") {
      out += "[^/]"
      i += 1
    } else {
      out += escapeRegExp(char ?? "")
      i += 1
    }
  }
  return out
}

/**
 * Match a glob-ish or bare area against a path.
 * - `src/auth/**`, `** / *.ts`, `src/auth/session.ts` — glob/relative match (any directory prefix)
 * - `auth` — bare name: any path segment or substring
 */
export function matchGlob(pattern: string, path: string): boolean {
  const source = normalizeSlashes(pattern).replace(/^\.\//, "").trim()
  const target = normalizeSlashes(path).replace(/^\.\//, "").trim()
  if (source === "" || target === "") return false
  const hasGlob = /[*?]/.test(source)
  if (!hasGlob && !source.includes("/")) {
    return target === source || target.includes(`/${source}`) || target.includes(source)
  }
  return new RegExp(`^(?:.*/)?${globToRegExpSource(source)}$`).test(target)
}

interface MatchReason {
  reason: string
  score: number
}

interface AreaContext {
  keywords: Set<string>
  files: string[]
  commands: string[]
}

function areaReason(area: string, context: AreaContext): MatchReason | null {
  const cleaned = area.trim()
  if (cleaned === "") return null
  const looksGlob = /[*?]/.test(cleaned) || cleaned.includes("/")
  if (looksGlob) {
    for (const file of context.files) {
      if (matchGlob(cleaned, file)) return { reason: `jit:file:${cleaned}`, score: 3 }
    }
    return null
  }
  const topic = cleaned.toLowerCase()
  if (context.keywords.has(topic)) return { reason: `jit:kw:${topic}`, score: 2 }
  for (const file of context.files) {
    if (normalizeSlashes(file).toLowerCase().split("/").includes(topic)) {
      return { reason: `jit:file:${topic}`, score: 2.5 }
    }
  }
  for (const command of context.commands) {
    if (tokenSet(command).has(topic)) return { reason: `jit:cmd:${topic}`, score: 2 }
  }
  return null
}

function sharedTokens(tokens: Set<string>, keywords: Set<string>): string[] {
  const shared: string[] = []
  for (const token of tokens) if (keywords.has(token)) shared.push(token)
  return shared.sort()
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function jitMatches(inputs: JitInputs, options: { max?: number } = {}): JitMatch[] {
  const max = options.max ?? JIT_MAX_MATCHES
  const keywords = keywordSet(inputs.ctx)
  const context: AreaContext = {
    keywords,
    files: inputs.ctx.files ?? [],
    commands: inputs.ctx.commands ?? [],
  }
  if (keywords.size === 0 && context.files.length === 0 && context.commands.length === 0) return []

  const matches: JitMatch[] = []

  for (const thread of inputs.threads) {
    const reasons = thread.areas
      .map((area) => areaReason(area, context))
      .filter((reason): reason is MatchReason => reason !== null)
      .sort((a, b) => b.score - a.score || a.reason.localeCompare(b.reason))
    const titleHits = sharedTokens(tokenSet(thread.title), keywords)
    const best = reasons[0] ?? (titleHits.length > 0 ? { reason: `jit:kw:${titleHits[0]}`, score: 1 } : null)
    if (!best) continue
    const watch = REGRESSION_WATCH_STATUSES.includes(thread.status)
    const latest = thread.notes[thread.notes.length - 1]
    matches.push({
      type: "thread",
      id: thread.id,
      title: thread.title,
      reason: best.reason,
      score: best.score + (watch ? 0.25 : 0),
      status: thread.status,
      ...(latest ? { detail: latest.text.replace(/\s+/g, " ").slice(0, 100) } : {}),
      ...(watch ? { regressionWatch: true } : {}),
    })
  }

  for (const correction of inputs.corrections) {
    const hits = sharedTokens(tokenSet(correction.text), keywords)
    if (hits.length === 0) continue
    matches.push({
      type: "correction",
      id: entryRef("j", correction.text),
      title: correction.text.replace(/\s+/g, " ").slice(0, 80),
      reason: `jit:kw:${hits[0]}`,
      score: Math.min(hits.length, 3),
    })
  }

  for (const learning of inputs.lessons) {
    const hits = sharedTokens(tokenSet(learning.title), keywords)
    if (hits.length === 0) continue
    const takeaway = learning.content.split("\n")[0] ?? ""
    matches.push({
      type: "lesson",
      id: lessonRef(learning),
      title: learning.title,
      reason: `jit:kw:${hits[0]}`,
      score: Math.min(hits.length, 2),
      ...(takeaway ? { detail: takeaway.replace(/\s+/g, " ").slice(0, 100) } : {}),
    })
  }

  for (const record of inputs.guardrails) {
    let reason: string | null = null
    let score = 0
    for (const command of context.commands) {
      if (record.tool !== "bash" && record.tool !== "shell") continue
      const overlap = jaccardLocal(tokenSet(command), tokenSet(record.fingerprint))
      if (overlap >= JIT_GUARDRAIL_CMD_THRESHOLD) {
        const first = [...tokenSet(command)][0]
        reason = `jit:cmd:${first ?? "command"}`
        score = 2
        break
      }
    }
    if (!reason) {
      for (const file of context.files) {
        if (file === record.fingerprint || record.fingerprint.includes(file)) {
          reason = `jit:file:${record.fingerprint.slice(0, 40)}`
          score = 2
          break
        }
      }
    }
    if (!reason) continue
    const detail = record.fix
      ? ` → use \`${record.fix.input}\``
      : record.errorSample
        ? `: ${record.errorSample.replace(/\s+/g, " ").slice(0, 80)}`
        : undefined
    matches.push({
      type: "guardrail",
      id: `g:${record.id}`,
      title: record.fingerprint,
      reason,
      score,
      status: record.state,
      ...(detail ? { detail } : {}),
    })
  }

  const deduped = new Map<string, JitMatch>()
  for (const match of matches) {
    const key = `${match.type}:${match.id}`
    const existing = deduped.get(key)
    if (!existing || match.score > existing.score) deduped.set(key, match)
  }

  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id.localeCompare(b.id))
    .slice(0, max)
}

function jaccardLocal(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}

// ---------------------------------------------------------------------------
// Tool-call extraction (defensive — part shapes vary by tool)
// ---------------------------------------------------------------------------

const PATH_KEYS = ["filePath", "file_path", "path", "file", "filename"] as const

export function pathsFromToolCall(_tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  const paths: string[] = []
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") paths.push(value)
  }
  return paths
}

export function commandsFromToolCall(_tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const command = (input as Record<string, unknown>)["command"]
  return typeof command === "string" && command.trim() !== "" ? [command] : []
}

export interface ToolCallLike {
  tool: string
  input: unknown
}

/** Collect deduplicated file paths + commands from a list of recent tool calls. */
export function collectPaths(calls: ToolCallLike[]): { files: string[]; commands: string[] } {
  const files: string[] = []
  const commands: string[] = []
  for (const call of calls) {
    for (const file of pathsFromToolCall(call.tool, call.input)) if (!files.includes(file)) files.push(file)
    for (const command of commandsFromToolCall(call.tool, call.input)) if (!commands.includes(command)) commands.push(command)
  }
  return { files, commands }
}
