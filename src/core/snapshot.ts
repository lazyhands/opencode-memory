/**
 * Snapshot builder: the injected MEMORY block.
 *
 * Deterministic: the same stores + config + turn context produce a
 * byte-identical block (no timestamps) — safe for provider prompt caching.
 * Sections render in priority order:
 *
 *   1 [GUARDRAILS]  2 [PERSONALITY]  3 [OPEN THREADS]  4 [CORRECTIONS]
 *   5 [PROJECT]     6 [LESSONS]      7 [RELEVANT THIS TURN]  8 [DISTILL]
 *   9 [MEMORY PROTOCOL]
 *
 * Packing reserves the small, high-value sections first (guardrails,
 * corrections, open threads), then the bounded stores, then turn relevance;
 * the static protocol text absorbs the squeeze (full → short → omitted).
 * Every omission is recorded in `truncations` for the audit log.
 */
import { contentId, entryRef } from "./audit.ts"
import type { MemoryConfig, ProtocolMode } from "./config.ts"
import type { JitMatch } from "./jit.ts"
import type { Guardrail, Issue, Learning } from "./learnings.ts"
import { ACTIVE_ISSUE_STATUSES, lessonRef, learningTitles } from "./learnings.ts"
import type { Entry } from "./store.ts"
import { charCount, displayEntry } from "./store.ts"

export type SectionName =
  | "GUARDRAILS"
  | "PERSONALITY"
  | "OPEN THREADS"
  | "CORRECTIONS"
  | "PROJECT"
  | "LESSONS"
  | "RELEVANT THIS TURN"
  | "DISTILL"
  | "MEMORY PROTOCOL"

/** Render order of sections inside the block. */
export const SECTION_RENDER_ORDER: readonly SectionName[] = [
  "GUARDRAILS",
  "PERSONALITY",
  "OPEN THREADS",
  "CORRECTIONS",
  "PROJECT",
  "LESSONS",
  "RELEVANT THIS TURN",
  "DISTILL",
  "MEMORY PROTOCOL",
]

/** Budget packing order — small critical sections first, protocol last. */
export const PACK_ORDER: readonly SectionName[] = [
  "GUARDRAILS",
  "CORRECTIONS",
  "OPEN THREADS",
  "DISTILL",
  "PERSONALITY",
  "PROJECT",
  "RELEVANT THIS TURN",
  "LESSONS",
  "MEMORY PROTOCOL",
]

export const MAX_GUARDRAIL_LINES = 6
export const MAX_THREAD_LINES = 6
export const MAX_CORRECTION_LINES = 3
export const LESSON_INDEX_CHAR_BUDGET = 320

export const PROTOCOL_FULL = `[MEMORY PROTOCOL] — binding for this session
- The MEMORY block above is BINDING context: follow its guardrails, open threads and corrections. A correction overrides your priors/training — never emit its "wrong:" variant.
- Unsure about a command, API, or past decision? Run memory_search first (free, tool-only) instead of guessing.
- Routing: personality = cross-project (rule | machine); project = fact | pref | decision | correction. Project-specific content never goes to personality.
- Failures are captured automatically — never repeat a recorded failure. When verified reality contradicts your priors, record a correction (about / wrong / use / verified) before continuing.
- Multi-turn work: open an issue thread with areas (memory_issue); at fix time set status + what to verify; on regression update status=regressed with a note.
- Distill brief lessons after successes AND failures via memory_learn (title + 1-2 line takeaway).
- Memory full → consolidate (replace/merge/forget) in the same turn, then retry. Update stale entries the same turn you learn better ones. After a big fix, run memory_audit and act on its recommendations.`

export const PROTOCOL_SHORT = `[MEMORY PROTOCOL] Binding: follow the MEMORY block — corrections override priors; never repeat recorded failures. Search before guessing; keep entries brief; open/update issue threads for multi-turn work; record corrections and lessons; consolidate or update stale entries in the same turn.`

export interface SnapshotPin {
  ref: string
  text: string
  reason: string
}

export interface SnapshotInputs {
  config: MemoryConfig
  personality: Entry[]
  project: Entry[]
  lessons: Learning[]
  threads: Issue[]
  guardrails: Guardrail[]
  /** Defaults to project entries with kind=correction. */
  corrections?: Entry[] | undefined
  jit?: JitMatch[] | undefined
  /** Pre-flight/coach pins — always rendered first in RELEVANT. */
  pins?: SnapshotPin[] | undefined
  /** One-line distillation request after a context compaction. */
  distill?: boolean | undefined
}

export interface SnapshotSectionInfo {
  name: SectionName
  chars: number
  refs: string[]
}

export interface Snapshot {
  block: string
  sections: SnapshotSectionInfo[]
  refs: string[]
  truncations: string[]
  chars: number
  hash: string
}

interface SectionItem {
  lines: string[]
  refs: string[]
}

interface SectionBlock {
  name: SectionName
  header: string | null
  items: SectionItem[]
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function entryItem(entry: Entry, ref: string, bullet = "• "): SectionItem {
  const lines = displayEntry(entry).split("\n")
  const rendered = lines.map((line, i) => (i === 0 ? `${bullet}${line}` : `  ${line}`))
  return { lines: rendered, refs: [ref] }
}

function storeBlock(name: "PERSONALITY" | "PROJECT", entries: Entry[], cap: number, prefix: "p" | "j"): SectionBlock {
  if (entries.length === 0) return { name, header: `[${name}] (empty)`, items: [] }
  return {
    name,
    header: `[${name}] ${charCount(entries)}/${cap} chars · ${entries.length} entries`,
    items: entries.map((entry) => entryItem(entry, entryRef(prefix, displayEntry(entry)))),
  }
}

export function guardrailLine(record: Guardrail): string {
  const fingerprint = truncateLine(record.fingerprint, 60)
  if (record.state === "resolved" && record.fix) {
    return `- \`${fingerprint}\` failed → use \`${record.fix.input}\``
  }
  const seen = record.count > 1 ? ` ×${record.count}` : ""
  return `- \`${fingerprint}\` fails${seen}: ${truncateLine(record.errorSample, 80)}`
}

function guardrailsBlock(records: Guardrail[]): SectionBlock | null {
  const resolved = records
    .filter((record) => record.state === "resolved")
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  const open = records
    .filter((record) => record.state === "open")
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.id.localeCompare(b.id))
  const total = resolved.length + open.length
  const shown = [...resolved, ...open].slice(0, MAX_GUARDRAIL_LINES)
  if (shown.length === 0) return null
  const items: SectionItem[] = shown.map((record) => ({ lines: [guardrailLine(record)], refs: [`g:${record.id}`] }))
  if (total > shown.length) {
    items.push({ lines: [`… ${total - shown.length} more failure record(s) — memory_status`], refs: [] })
  }
  return {
    name: "GUARDRAILS",
    header: `[GUARDRAILS] ${resolved.length} resolved · ${open.length} open`,
    items,
  }
}

const THREAD_STATUS_RANK: Record<string, number> = { regressed: 0, open: 1, verifying: 2 }

function threadLine(issue: Issue): string {
  const latest = issue.notes[issue.notes.length - 1]
  const note = latest ? ` — ${truncateLine(latest.text, 80)}` : ""
  return `- #${issue.id} ${issue.status}: ${issue.title}${note}`
}

function threadsBlock(threads: Issue[]): SectionBlock | null {
  const active = threads
    .filter((issue) => ACTIVE_ISSUE_STATUSES.includes(issue.status))
    .sort(
      (a, b) =>
        (THREAD_STATUS_RANK[a.status] ?? 9) - (THREAD_STATUS_RANK[b.status] ?? 9) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    )
  const shown = active.slice(0, MAX_THREAD_LINES)
  if (shown.length === 0) return null
  const items: SectionItem[] = shown.map((issue) => ({ lines: [threadLine(issue)], refs: [`t:${issue.id}`] }))
  if (active.length > shown.length) {
    items.push({ lines: [`… ${active.length - shown.length} more open thread(s) — memory_status`], refs: [] })
  }
  return { name: "OPEN THREADS", header: `[OPEN THREADS] ${active.length}`, items }
}

function correctionsBlock(corrections: Entry[]): SectionBlock | null {
  const recent = corrections.slice(-MAX_CORRECTION_LINES)
  if (recent.length === 0) return null
  const items: SectionItem[] = recent.map((entry) => entryItem(entry, entryRef("j", displayEntry(entry)), "- "))
  if (corrections.length > recent.length) {
    items.push({ lines: [`… ${corrections.length - recent.length} older correction(s) — memory_search`], refs: [] })
  }
  return { name: "CORRECTIONS", header: "[CORRECTIONS]", items }
}

function lessonsBlock(learnings: Learning[], config: MemoryConfig): SectionBlock | null {
  const total = learnings.length
  if (total === 0) return null
  const shown: Learning[] = []
  let used = 0
  for (const learning of learnings) {
    if (shown.length >= config.learnings.maxIndexTitles) break
    if (used + learning.title.length + 2 > LESSON_INDEX_CHAR_BUDGET && shown.length > 0) break
    shown.push(learning)
    used += learning.title.length + 2
  }
  const items: SectionItem[] = [
    { lines: [`titles: ${shown.map((learning) => learning.title).join("; ")}`], refs: shown.map(lessonRef) },
  ]
  const omitted = total - shown.length
  if (omitted > 0) items.push({ lines: [`… ${omitted} more — recall via memory_search`], refs: [] })
  return { name: "LESSONS", header: `[LESSONS] ${total} lesson(s)`, items }
}

function matchRef(match: JitMatch): string {
  return match.type === "thread" ? `t:${match.id}` : match.id
}

function jitMatchLine(match: JitMatch): string {
  const detail = match.detail ? ` — ${match.detail}` : ""
  switch (match.type) {
    case "thread": {
      const watch = match.regressionWatch ? " · regression watch" : ""
      return `- (thread #${match.id} ${match.status ?? ""}${watch}, ${match.reason}) ${match.title}${detail}`
    }
    case "correction":
      return `- (correction, ${match.reason}) ${match.title}`
    case "lesson":
      return `- (lesson, ${match.reason}) ${match.title}${detail}`
    case "guardrail":
      return `- (guardrail ${match.id}, ${match.reason}) \`${match.title}\`${detail}`
  }
}

function relevantBlock(
  matches: JitMatch[],
  pins: SnapshotPin[],
  coveredRefs: Set<string>,
): SectionBlock | null {
  const items: SectionItem[] = []
  for (const pin of pins) {
    items.push({ lines: [`- (pin ${pin.reason}) ${pin.text}`], refs: [pin.ref] })
  }
  for (const match of matches) {
    const ref = matchRef(match)
    if (coveredRefs.has(ref)) continue
    items.push({ lines: [jitMatchLine(match)], refs: [ref] })
  }
  if (items.length === 0) return null
  return { name: "RELEVANT THIS TURN", header: "[RELEVANT THIS TURN]", items }
}

function protocolBlock(mode: ProtocolMode): SectionBlock | null {
  if (mode === "off") return null
  const text = mode === "full" ? PROTOCOL_FULL : PROTOCOL_SHORT
  return { name: "MEMORY PROTOCOL", header: null, items: [{ lines: text.split("\n"), refs: [] }] }
}

const DISTILL_LINE =
  "Compaction ran — distill this session now: record each durable lesson via memory_learn (brief title + 1-2 line takeaway; failures → what prevents a repeat)."

function distillBlock(pending: boolean): SectionBlock | null {
  if (!pending) return null
  return { name: "DISTILL", header: "[DISTILL]", items: [{ lines: [DISTILL_LINE], refs: [] }] }
}

export function buildSections(inputs: SnapshotInputs): SectionBlock[] {
  const corrections = inputs.corrections ?? inputs.project.filter((entry) => entry.kind === "correction")
  const projectEntries = inputs.project.filter((entry) => entry.kind !== "correction")
  const blocks: Array<SectionBlock | null> = [
    guardrailsBlock(inputs.guardrails),
    storeBlock("PERSONALITY", inputs.personality, inputs.config.personalityCharLimit, "p"),
    threadsBlock(inputs.threads),
    correctionsBlock(corrections),
    storeBlock("PROJECT", projectEntries, inputs.config.projectCharLimit, "j"),
    lessonsBlock(inputs.lessons, inputs.config),
    relevantBlock(inputs.jit ?? [], inputs.pins ?? [], new Set()),
    distillBlock(inputs.distill ?? false),
    protocolBlock(inputs.config.protocol),
  ]
  return blocks.filter((block): block is SectionBlock => block !== null)
}

// ---------------------------------------------------------------------------
// Packing + rendering
// ---------------------------------------------------------------------------

interface PackedSection {
  lines: string[]
  refs: string[]
}

function linesCost(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

function packSection(section: SectionBlock, budget: number): { packed: PackedSection; omitted: number } {
  const lines: string[] = []
  const refs: string[] = []
  let used = 0
  if (section.header) {
    if (section.header.length + 1 > budget) return { packed: { lines, refs }, omitted: section.items.length }
    lines.push(section.header)
    used += section.header.length + 1
  }
  let omitted = 0
  for (let i = 0; i < section.items.length; i++) {
    const item = section.items[i]
    if (!item) break
    const cost = linesCost(item.lines)
    if (used + cost > budget) {
      omitted = section.items.length - i
      break
    }
    lines.push(...item.lines)
    used += cost
    refs.push(...item.refs)
  }
  return { packed: { lines, refs }, omitted }
}

export function buildSnapshot(inputs: SnapshotInputs): Snapshot {
  const budget = inputs.config.maxInjectChars
  const sections = new Map(buildSections(inputs).map((section) => [section.name, section]))
  const packed = new Map<SectionName, PackedSection>()
  const truncations: string[] = []
  let remaining = budget
  let includedCount = 0

  for (const name of PACK_ORDER) {
    let section = sections.get(name)
    if (!section) continue
    if (name === "RELEVANT THIS TURN") {
      // Dedupe against sections that actually got packed, then repack.
      const covered = new Set<string>()
      for (const value of packed.values()) for (const ref of value.refs) covered.add(ref)
      section = relevantBlock(inputs.jit ?? [], inputs.pins ?? [], covered) ?? undefined
      if (!section) continue
    }
    const separator = includedCount > 0 ? 1 : 0
    const available = remaining - separator

    if (name === "MEMORY PROTOCOL") {
      const full = packSection(section, available)
      if (full.packed.lines.length > 0 && full.omitted === 0) {
        packed.set(name, full.packed)
        remaining -= separator + linesCost(full.packed.lines)
        includedCount++
        continue
      }
      // Squeezed: fall back to the short protocol, then omit.
      if (inputs.config.protocol === "full") {
        const shortSection = protocolBlock("short")
        const short = shortSection ? packSection(shortSection, available) : null
        if (short && short.packed.lines.length > 0 && short.omitted === 0) {
          packed.set(name, short.packed)
          remaining -= separator + linesCost(short.packed.lines)
          includedCount++
          truncations.push("MEMORY PROTOCOL: shortened (budget)")
          continue
        }
      }
      truncations.push("MEMORY PROTOCOL: omitted (budget)")
      continue
    }

    const { packed: sectionPacked, omitted } = packSection(section, available)
    if (sectionPacked.lines.length === 0) {
      truncations.push(`${name}: omitted (budget)`)
      continue
    }
    let used = linesCost(sectionPacked.lines)
    if (omitted > 0) {
      const marker = `… ${omitted} more — recall via memory_search`
      if (used + marker.length + 1 <= available) {
        sectionPacked.lines.push(marker)
        used += marker.length + 1
      }
      truncations.push(`${name}: ${omitted} item(s) omitted (budget)`)
    }
    packed.set(name, sectionPacked)
    remaining -= separator + used
    includedCount++
  }

  const blockLines: string[] = []
  const sectionInfos: SnapshotSectionInfo[] = []
  for (const name of SECTION_RENDER_ORDER) {
    const info = packed.get(name)
    if (!info || info.lines.length === 0) continue
    if (blockLines.length > 0) blockLines.push("")
    blockLines.push(...info.lines)
    sectionInfos.push({ name, chars: linesCost(info.lines), refs: [...new Set(info.refs)] })
  }

  const block = blockLines.join("\n")
  const refs = [...new Set(sectionInfos.flatMap((info) => info.refs))]
  return {
    block,
    sections: sectionInfos,
    refs,
    truncations,
    chars: block.length,
    hash: contentId("s", block),
  }
}

/** Lesson titles helper for callers that need the index outside the block. */
export function lessonIndexTitles(learnings: Learning[], config: MemoryConfig): string[] {
  return learningTitles(learnings).slice(0, config.learnings.maxIndexTitles)
}
