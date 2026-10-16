/**
 * Entry stores: `personality.md` and `project.md` (kind-tagged markdown bullets).
 *
 * Format (one entry per bullet; continuations indented two spaces):
 *
 *   ---
 *   type: project
 *   version: 1
 *   ---
 *   - [fact] The API base URL is http://localhost:3000
 *
 * Parse is tolerant (hand-edited files, legacy untagged bullets); serialize is
 * canonical, so a rewrite normalizes the file. All mutations are pure — they
 * return new entry arrays and throw `MemoryError` for expected failures
 * (not_found, ambiguous_match, overflow, …). IO lives in `paths.ts` (atomic).
 */
import { join } from "node:path"
import { MemoryError } from "./errors.ts"
import { atomicWrite, listFiles, readText, removeFile } from "./paths.ts"

export type Scope = "personality" | "project"

export const PERSONALITY_KINDS = ["rule", "machine"] as const
export const PROJECT_KINDS = ["fact", "pref", "decision", "correction"] as const
export type PersonalityKind = (typeof PERSONALITY_KINDS)[number]
export type ProjectKind = (typeof PROJECT_KINDS)[number]
/** `unknown` never appears in new writes — it preserves hand-edited tags on parse. */
export type EntryKind = PersonalityKind | ProjectKind | "unknown"

export interface Entry {
  kind: EntryKind
  text: string
}

export const STORE_HEADER_VERSION = 1

export function writableKinds(scope: Scope): readonly string[] {
  return scope === "personality" ? PERSONALITY_KINDS : PROJECT_KINDS
}

export function defaultKind(scope: Scope): EntryKind {
  return scope === "personality" ? "rule" : "fact"
}

/** Validate + resolve an (optional) kind for a scope. Throws `invalid_kind`. */
export function resolveKind(scope: Scope, kind?: string | undefined): EntryKind {
  if (kind === undefined || kind === "") return defaultKind(scope)
  const allowed = writableKinds(scope)
  if (kind !== "unknown" && allowed.includes(kind)) return kind as EntryKind
  throw new MemoryError(
    "invalid_kind",
    `kind "${kind}" is not valid for ${scope} scope — use one of: ${allowed.join(", ")}`,
    { scope, kind, allowed },
  )
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

const KNOWN_KINDS = new Set<string>([...PERSONALITY_KINDS, ...PROJECT_KINDS])

export function parseEntries(text: string | null, scope: Scope): Entry[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)

  // Skip YAML-ish frontmatter.
  let i = 0
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++
  if (i < lines.length && (lines[i] ?? "").trim() === "---") {
    i++
    while (i < lines.length && (lines[i] ?? "").trim() !== "---") i++
    i++
  }

  const entries: Entry[] = []
  let current: { kind: EntryKind; text: string } | null = null

  const flush = (): void => {
    if (!current) return
    const body = current.text.trim()
    if (body !== "") entries.push({ kind: current.kind, text: body })
    current = null
  }

  for (; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.trim() === "") continue
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      const body = (bullet[1] ?? "").trimEnd()
      const tag = /^\[([A-Za-z][A-Za-z-]{0,31})\]\s*(.*)$/.exec(body)
      if (tag) {
        const name = (tag[1] ?? "").toLowerCase()
        const rest = tag[2] ?? ""
        current = KNOWN_KINDS.has(name)
          ? { kind: name as EntryKind, text: rest }
          : { kind: "unknown", text: `[${tag[1] ?? ""}] ${rest}`.trimEnd() }
      } else {
        current = { kind: defaultKind(scope), text: body }
      }
    } else if (current) {
      // Continuation: indented lines are ours; unindented prose is treated as
      // continuation too so hand-edited files keep their content.
      const continuation = /^[ \t]+\S/.test(line) ? line.replace(/^[ \t]+/, "") : line.trim()
      current = { kind: current.kind, text: `${current.text}\n${continuation}` }
    }
  }
  flush()
  return entries
}

export function serializeEntries(entries: Entry[], scope: Scope): string {
  const header = `---\ntype: ${scope}\nversion: ${STORE_HEADER_VERSION}\n---\n`
  if (entries.length === 0) return header
  const body = entries
    .map((entry) => {
      const display = displayEntry(entry)
      const [first, ...rest] = display.split("\n")
      const continuation = rest.map((line) => `  ${line.trim()}`)
      return `- ${first}${continuation.length ? `\n${continuation.join("\n")}` : ""}`
    })
    .join("\n")
  return `${header}\n${body}\n`
}

/** Canonical single-string form of an entry ("[kind] text"; raw text for unknown tags). */
export function displayEntry(entry: Entry): string {
  return entry.kind === "unknown" ? entry.text : `[${entry.kind}] ${entry.text}`
}

export function entryLength(entry: Entry): number {
  return displayEntry(entry).length
}

export function charCount(entries: Entry[]): number {
  return entries.reduce((sum, entry) => sum + entryLength(entry), 0)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface EntryLimits {
  perEntryCharLimit: number
  maxEntryLines: number
}

/** Trim + validate entry content; returns the normalized text or throws. */
export function normalizeEntryContent(content: string, limits: EntryLimits, label = "memory entry"): string {
  const trimmed = content.replace(/\r\n/g, "\n").trim()
  if (trimmed === "") {
    throw new MemoryError("invalid_content", `${label} must be non-empty`, { label })
  }
  const lines = trimmed.split("\n")
  if (lines.length > limits.maxEntryLines) {
    throw new MemoryError(
      "too_many_lines",
      `${label} is ${lines.length} lines (> ${limits.maxEntryLines}) — keep it brief (prefer one line)`,
      { label, lines: lines.length, max: limits.maxEntryLines },
    )
  }
  if (trimmed.length > limits.perEntryCharLimit) {
    throw new MemoryError(
      "entry_too_long",
      `${label} is ${trimmed.length} chars (> ${limits.perEntryCharLimit}) — shorten it`,
      { label, length: trimmed.length, max: limits.perEntryCharLimit },
    )
  }
  return trimmed
}

function overflowError(entries: Entry[], cap: number, attempted?: string): MemoryError {
  const used = charCount(entries)
  return new MemoryError("overflow", `memory is over its ${cap}-char cap (${used} > ${cap})`, {
    used,
    cap,
    attempted,
    entries: entries.map(displayEntry),
  })
}

// ---------------------------------------------------------------------------
// Mutations (pure — new arrays out, MemoryError for expected failures)
// ---------------------------------------------------------------------------

export interface AddResult {
  entries: Entry[]
  duplicate: boolean
}

export function addEntry(entries: Entry[], entry: Entry, cap: number): AddResult {
  if (entries.some((existing) => displayEntry(existing) === displayEntry(entry))) {
    return { entries: [...entries], duplicate: true }
  }
  const next = [...entries, entry]
  if (charCount(next) > cap) throw overflowError(next, cap, displayEntry(entry))
  return { entries: next, duplicate: false }
}

export interface ReplaceResult {
  entries: Entry[]
  index: number
}

export function replaceEntry(
  entries: Entry[],
  oldText: string,
  content: string,
  cap: number,
  kind?: EntryKind | undefined,
): ReplaceResult {
  const index = findUniqueIndex(entries, oldText)
  const previous = entries[index]
  if (!previous) throw new MemoryError("not_found", `no memory entry contains "${oldText}"`, { needle: oldText })
  const replacement: Entry = { kind: kind ?? previous.kind, text: content }
  const next = entries.map((entry, i) => (i === index ? replacement : entry))
  if (charCount(next) > cap) throw overflowError(next, cap, displayEntry(replacement))
  return { entries: next, index }
}

export interface RemoveResult {
  entries: Entry[]
  removed: Entry
  index: number
}

export function removeEntry(entries: Entry[], oldText: string): RemoveResult {
  const index = findUniqueIndex(entries, oldText)
  const removed = entries[index]
  if (!removed) throw new MemoryError("not_found", `no memory entry contains "${oldText}"`, { needle: oldText })
  return { entries: entries.filter((_, i) => i !== index), removed, index }
}

/** Index of the single entry whose display text contains `needle`. Throws not_found / ambiguous_match. */
export function findUniqueIndex(entries: Entry[], needle: string): number {
  const matches: number[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry && displayEntry(entry).includes(needle)) matches.push(i)
  }
  if (matches.length === 0) {
    throw new MemoryError("not_found", `no memory entry contains "${needle}"`, { needle })
  }
  if (matches.length > 1) {
    throw new MemoryError(
      "ambiguous_match",
      `"${needle}" matches ${matches.length} entries (${matches.map((i) => `#${i + 1}`).join(", ")}) — use a more specific substring`,
      { needle, matches: matches.map((i) => i + 1) },
    )
  }
  const index = matches[0]
  if (index === undefined) throw new MemoryError("not_found", `no memory entry contains "${needle}"`, { needle })
  return index
}

// ---------------------------------------------------------------------------
// Routing validation + lint (personality vs project)
// ---------------------------------------------------------------------------

export interface RoutingCheckInput {
  scope: Scope
  kind: EntryKind
  content: string
  /** Project name / root path / aliases — any project-specific identifier. */
  projectTerms: string[]
}

/** Hard check for personality writes: project-specific content is rejected. */
export function validateRouting(input: RoutingCheckInput): void {
  if (input.scope !== "personality") return
  const lower = input.content.toLowerCase()
  for (const term of input.projectTerms) {
    const needle = term.trim().toLowerCase()
    if (needle.length < 3) continue
    if (lower.includes(needle)) {
      throw new MemoryError(
        "routing_violation",
        `personality memory references "${term}" — project-specific content belongs in target=project`,
        { term, scope: input.scope },
      )
    }
  }
}

export interface RoutingLintItem {
  scope: Scope
  index: number
  text: string
  suggestion: string
}

/** Soft lint for `memory_status`: suspected misplacements, fixable in the same turn. */
export function routingLint(personality: Entry[], project: Entry[], projectTerms: string[]): RoutingLintItem[] {
  const items: RoutingLintItem[] = []

  personality.forEach((entry, i) => {
    const lower = entry.text.toLowerCase()
    for (const term of projectTerms) {
      const needle = term.trim().toLowerCase()
      if (needle.length >= 3 && lower.includes(needle)) {
        items.push({
          scope: "personality",
          index: i,
          text: entry.text,
          suggestion: `references "${term}" — move to target=project`,
        })
        break
      }
    }
  })

  project.forEach((entry, i) => {
    if (entry.kind === "unknown") {
      items.push({ scope: "project", index: i, text: entry.text, suggestion: "unrecognized kind tag — rewrite via memory_set" })
      return
    }
    if (/^(always|never)\b/i.test(entry.text)) {
      items.push({
        scope: "project",
        index: i,
        text: entry.text,
        suggestion: "cross-project operating rule — consider target=personality",
      })
      return
    }
    if (entry.kind === "correction") {
      const warning = correctionShapeWarning(entry.text)
      if (warning) items.push({ scope: "project", index: i, text: entry.text, suggestion: warning })
      return
    }
    if (entry.kind === "fact" && /(\s→\s|\bbecause\b)/.test(entry.text)) {
      items.push({
        scope: "project",
        index: i,
        text: entry.text,
        suggestion: 'lesson-shaped prose — consider memory_learn for "what works & how"',
      })
    }
  })

  return items
}

/** Soft check for the correction shape: `about: …; wrong: …; use: …; verified: …`. */
export function correctionShapeWarning(content: string): string | null {
  const lower = content.toLowerCase()
  const missing: string[] = []
  if (!lower.includes("wrong")) missing.push("wrong:")
  if (!lower.includes("use")) missing.push("use:")
  if (missing.length === 0) return null
  return `correction is missing ${missing.join(" and ")} — format: about: …; wrong: …; use: …; verified: <date/source>`
}

// ---------------------------------------------------------------------------
// IO + recovery (forget/restore)
// ---------------------------------------------------------------------------

export function readEntries(path: string, scope: Scope): Entry[] {
  return parseEntries(readText(path), scope)
}

export function writeEntries(path: string, entries: Entry[], scope: Scope): void {
  atomicWrite(path, serializeEntries(entries, scope))
}

export interface RecoveryRecord {
  target: Scope
  removed: string[]
  at: string
  reason?: string
}

const RECOVERY_ID_RE = /^r[0-9a-z]+-[0-9a-z]{1,8}$/

export function newRecoveryId(now: number = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
  return `r${now.toString(36)}-${rand}`
}

/** Write a recovery record into `dir` (the memory dir's `recovery/`). Returns its id. */
export function writeRecovery(dir: string, record: RecoveryRecord): string {
  const id = newRecoveryId()
  atomicWrite(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return id
}

export function readRecovery(dir: string, id: string): RecoveryRecord | null {
  if (!RECOVERY_ID_RE.test(id)) return null
  const text = readText(join(dir, `${id}.json`))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as RecoveryRecord
    if (!parsed || !Array.isArray(parsed.removed)) return null
    return parsed
  } catch {
    return null
  }
}

export function deleteRecovery(dir: string, id: string): void {
  if (!RECOVERY_ID_RE.test(id)) return
  removeFile(join(dir, `${id}.json`))
}

export function listRecoveries(dir: string): string[] {
  return listFiles(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => RECOVERY_ID_RE.test(id))
}
