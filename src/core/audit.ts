/**
 * Audit log + effectiveness scoring (req 2 + "improve over time").
 *
 * `audit.jsonl` is append-only: one event per line. Derived stats answer
 * "did injecting this entry change anything?" — reoccurrence after injection,
 * never-matched corrections/lessons, guardrails that stayed silent — and feed
 * `memory_audit` (the model's self-evaluation loop) and the TUI dashboard.
 */
import { createHash } from "node:crypto"
import { atomicWrite, readText } from "./paths.ts"

export const AUDIT_EVENT_TYPES = ["inject", "preflight", "fail", "reoccur", "resolve", "search", "review"] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export const AUDIT_EVENT_VERSION = 1

export interface AuditEvent {
  v: 1
  ts: string
  type: AuditEventType
  projectID?: string
  sessionID?: string
  [key: string]: unknown
}

/** Stable short content id — `p:ab12cd34` style refs used by injections, jit and stats. */
export function contentId(prefix: string, text: string): string {
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 8)
  return `${prefix}:${hash}`
}

/** Refs for entry stores: `p` personality, `j` project, `l` lesson. */
export function entryRef(prefix: "p" | "j" | "l", text: string): string {
  return contentId(prefix, text)
}

export function createAuditEvent(
  type: AuditEventType,
  ts: string,
  fields: Record<string, unknown> = {},
): AuditEvent {
  return { v: AUDIT_EVENT_VERSION, ts, type, ...fields }
}

// ---------------------------------------------------------------------------
// JSONL parse/serialize (tolerant — a corrupt line never breaks the log)
// ---------------------------------------------------------------------------

export function parseEvents(text: string | null): AuditEvent[] {
  if (!text) return []
  const events: AuditEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    try {
      const event = JSON.parse(line) as AuditEvent
      if (event && typeof event.ts === "string" && typeof event.type === "string") events.push(event)
    } catch {
      /* skip malformed line */
    }
  }
  return events
}

export function serializeEvents(events: AuditEvent[]): string {
  if (events.length === 0) return ""
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
}

export function appendEventText(text: string | null, event: AuditEvent): string {
  const base = text ?? ""
  const separator = base !== "" && !base.endsWith("\n") ? "\n" : ""
  return `${base}${separator}${JSON.stringify(event)}\n`
}

export function readEvents(path: string): AuditEvent[] {
  return parseEvents(readText(path))
}

export function writeEvents(path: string, events: AuditEvent[]): void {
  atomicWrite(path, serializeEvents(events))
}

export function pruneEvents(events: AuditEvent[], options: { retentionDays: number; now: Date }): AuditEvent[] {
  const cutoff = options.now.getTime() - options.retentionDays * 86_400_000
  return events.filter((event) => {
    const parsed = Date.parse(event.ts)
    return Number.isFinite(parsed) && parsed >= cutoff
  })
}

// ---------------------------------------------------------------------------
// Effectiveness stats
// ---------------------------------------------------------------------------

export interface AuditEntryStat {
  ref: string
  injected: number
  reoccurred: number
  firstInjectedAt?: string
  lastInjectedAt?: string
}

export interface AuditStats {
  events: number
  sessions: number
  injections: number
  failures: number
  resolves: number
  preflights: number
  blocked: number
  searches: number
  entries: AuditEntryStat[]
}

export function computeStats(events: AuditEvent[]): AuditStats {
  const sessions = new Set<string>()
  const entryMap = new Map<string, AuditEntryStat>()
  const injectedRefs = new Set<string>()
  let injections = 0
  let failures = 0
  let resolves = 0
  let preflights = 0
  let blocked = 0
  let searches = 0

  for (const event of events) {
    if (typeof event.sessionID === "string") sessions.add(event.sessionID)
    switch (event.type) {
      case "inject": {
        injections++
        const refs = Array.isArray(event["refs"]) ? (event["refs"] as unknown[]) : []
        for (const ref of refs) {
          if (typeof ref !== "string") continue
          injectedRefs.add(ref)
          const stat = entryMap.get(ref) ?? { ref, injected: 0, reoccurred: 0 }
          stat.injected++
          stat.firstInjectedAt ??= event.ts
          stat.lastInjectedAt = event.ts
          entryMap.set(ref, stat)
        }
        break
      }
      case "reoccur": {
        const ref = event["ref"]
        if (typeof ref === "string" && injectedRefs.has(ref)) {
          const stat = entryMap.get(ref) ?? { ref, injected: 0, reoccurred: 0 }
          stat.reoccurred++
          entryMap.set(ref, stat)
        }
        break
      }
      case "fail":
        failures++
        break
      case "resolve":
        resolves++
        break
      case "preflight":
        preflights++
        if (event["blocked"] === true) blocked++
        break
      case "search":
        searches++
        break
      case "review":
        break
    }
  }

  return {
    events: events.length,
    sessions: sessions.size,
    injections,
    failures,
    resolves,
    preflights,
    blocked,
    searches,
    entries: [...entryMap.values()],
  }
}

export interface RecommendationOptions {
  /** Reoccurrences after injection before "reword/block" is suggested (default 2). */
  reoccurThreshold?: number
  /** Injections without reoccurrence before "effective" (default 5). */
  effectiveInjections?: number
  /** Sessions without a match before "consider deleting" (default 10). */
  unusedSessions?: number
  /** Current corpus refs (e.g. corrections/lessons) to flag as never-matched. */
  corpus?: { ref: string; label: string }[]
}

export function buildRecommendations(stats: AuditStats, options: RecommendationOptions = {}): string[] {
  const reoccurThreshold = options.reoccurThreshold ?? 2
  const effectiveInjections = options.effectiveInjections ?? 5
  const unusedSessions = options.unusedSessions ?? 10
  const recommendations: string[] = []

  for (const entry of stats.entries) {
    if (entry.reoccurred >= reoccurThreshold) {
      recommendations.push(
        `${entry.ref} reoccurred ${entry.reoccurred}× after injection — reword it, merge it, or enable block mode`,
      )
    }
  }
  for (const entry of stats.entries) {
    if (entry.ref.startsWith("g:") && entry.reoccurred === 0 && entry.injected >= effectiveInjections) {
      recommendations.push(`${entry.ref} never reoccurred in ${entry.injected} injections — effective, keep it`)
    }
  }
  if (options.corpus && stats.sessions >= unusedSessions) {
    const injected = new Set(stats.entries.map((entry) => entry.ref))
    for (const item of options.corpus) {
      if (!injected.has(item.ref)) {
        recommendations.push(`${item.label} (${item.ref}) never matched a turn in ${stats.sessions} sessions — consider deleting or rewording`)
      }
    }
  }
  return recommendations
}
