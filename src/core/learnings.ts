/**
 * Project experience stores:
 *   - learnings.md    — `## success|failure: Title` + 1-2 line takeaway (pi-compatible)
 *   - guardrails.jsonl — auto-captured failure records (state file, capped, one JSON per line)
 *   - issues.md       — long-running issue threads with areas + notes
 *
 * Pure transforms + thin atomic IO. All records carry lifecycle states with
 * explicit transition tables (PAT-07 / DOM-03) and validated writes.
 */
import { contentId } from "./audit.ts"
import { MemoryError } from "./errors.ts"
import { atomicWrite, readText } from "./paths.ts"

// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

export type LearningOutcome = "success" | "failure"

export interface Learning {
  outcome: LearningOutcome
  title: string
  content: string
}

export const LEARNING_TITLE_LIMIT = 80
export const LEARNING_CONTENT_LIMIT = 240
export const LEARNING_CONTENT_MAX_LINES = 3

const LEARNING_HEADER = /^##\s+(success|failure):\s*(.+?)\s*$/

export function parseLearnings(text: string | null): Learning[] {
  if (!text) return []
  const learnings: Learning[] = []
  let current: Learning | null = null
  for (const line of text.split(/\r?\n/)) {
    const header = LEARNING_HEADER.exec(line)
    if (header) {
      if (current) learnings.push(current)
      current = { outcome: header[1] as LearningOutcome, title: header[2] ?? "", content: "" }
      continue
    }
    if (!current) continue
    const trimmed = line.trim()
    if (trimmed === "" && current.content === "") continue
    current.content = current.content === "" ? trimmed : `${current.content}\n${trimmed}`
  }
  if (current) learnings.push(current)
  return learnings.map((learning) => ({ ...learning, content: learning.content.trim() }))
}

export function serializeLearnings(learnings: Learning[]): string {
  if (learnings.length === 0) return ""
  return `${learnings.map((learning) => `## ${learning.outcome}: ${learning.title}\n${learning.content}`).join("\n\n")}\n`
}

export function learningTitles(learnings: Learning[]): string[] {
  return learnings.map((learning) => learning.title).filter((title) => title !== "")
}

/** Stable audit/jit ref for a lesson (`l:ab12cd34`). */
export function lessonRef(learning: Learning): string {
  return contentId("l", `${learning.outcome}: ${learning.title}`)
}

/** Validate + normalize a learning; throws `MemoryError`. */
export function normalizeLearning(learning: Learning): Learning {
  const title = learning.title.replace(/\s+/g, " ").trim()
  if (title === "") throw new MemoryError("invalid_content", "learning title must be non-empty", { label: "learning title" })
  if (title.length > LEARNING_TITLE_LIMIT) {
    throw new MemoryError("entry_too_long", `learning title is ${title.length} chars (> ${LEARNING_TITLE_LIMIT})`, {
      label: "learning title",
      length: title.length,
      max: LEARNING_TITLE_LIMIT,
    })
  }
  const content = learning.content.replace(/\r\n/g, "\n").trim()
  if (content === "") {
    throw new MemoryError("invalid_content", "learning content must be non-empty — a 1-2 line takeaway", {
      label: "learning content",
    })
  }
  const lines = content.split("\n")
  if (lines.length > LEARNING_CONTENT_MAX_LINES) {
    throw new MemoryError("too_many_lines", `learning content is ${lines.length} lines (> ${LEARNING_CONTENT_MAX_LINES})`, {
      label: "learning content",
      lines: lines.length,
      max: LEARNING_CONTENT_MAX_LINES,
    })
  }
  if (content.length > LEARNING_CONTENT_LIMIT) {
    throw new MemoryError("entry_too_long", `learning content is ${content.length} chars (> ${LEARNING_CONTENT_LIMIT})`, {
      label: "learning content",
      length: content.length,
      max: LEARNING_CONTENT_LIMIT,
    })
  }
  return { outcome: learning.outcome, title, content }
}

/** Append a learning to existing learnings.md text; returns the new full text. */
export function appendLearningText(text: string | null, learning: Learning): string {
  const normalized = normalizeLearning(learning)
  const existing = (text ?? "").trim()
  const section = `## ${normalized.outcome}: ${normalized.title}\n${normalized.content}`
  return existing === "" ? `${section}\n` : `${existing}\n\n${section}\n`
}

export function readLearnings(path: string): Learning[] {
  return parseLearnings(readText(path))
}

export function writeLearnings(path: string, learnings: Learning[]): void {
  atomicWrite(path, serializeLearnings(learnings))
}

// ---------------------------------------------------------------------------
// Guardrails (auto-captured failures)
// ---------------------------------------------------------------------------

export type GuardrailState = "open" | "resolved" | "dismissed"
/** Per-guardrail override; `inherit` uses config.guardrails.mode. */
export type GuardrailModeSetting = "inherit" | "warn" | "block"

export interface GuardrailFix {
  input: string
  at: string
}

export interface Guardrail {
  id: string
  sig: string
  tool: string
  fingerprint: string
  errorSample: string
  count: number
  firstSeen: string
  lastSeen: string
  sessions: string[]
  state: GuardrailState
  fix?: GuardrailFix
  mode: GuardrailModeSetting
}

export const GUARDRAIL_TRANSITIONS: Record<GuardrailState, readonly GuardrailState[]> = {
  open: ["resolved", "dismissed"],
  resolved: ["open", "resolved", "dismissed"], // open = reoccurred
  dismissed: ["open", "resolved"],
}

export const GUARDRAIL_SESSION_MEMORY = 10

function assertGuardrailTransition(from: GuardrailState, to: GuardrailState): void {
  if (!GUARDRAIL_TRANSITIONS[from].includes(to)) {
    throw new MemoryError("invalid_status", `guardrail cannot move ${from} → ${to}`, {
      from,
      to,
      allowed: GUARDRAIL_TRANSITIONS[from],
    })
  }
}

export function parseGuardrails(text: string | null): Guardrail[] {
  if (!text) return []
  const records: Guardrail[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    try {
      const record = JSON.parse(line) as Guardrail
      if (
        record &&
        typeof record.id === "string" &&
        typeof record.sig === "string" &&
        typeof record.tool === "string" &&
        typeof record.state === "string"
      ) {
        records.push(record)
      }
    } catch {
      /* skip malformed line — state file, not user content */
    }
  }
  return records
}

export function serializeGuardrails(records: Guardrail[]): string {
  if (records.length === 0) return ""
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

export function readGuardrails(path: string): Guardrail[] {
  return parseGuardrails(readText(path))
}

export function writeGuardrails(path: string, records: Guardrail[]): void {
  atomicWrite(path, serializeGuardrails(records))
}

function guardrailNumber(id: string): number {
  const match = /^g(\d+)$/.exec(id)
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0
}

export function nextGuardrailId(records: Guardrail[]): string {
  let max = 0
  for (const record of records) max = Math.max(max, guardrailNumber(record.id))
  return `g${max + 1}`
}

export function findGuardrail(records: Guardrail[], ref: string): Guardrail | undefined {
  return records.find((record) => record.id === ref || record.sig === ref)
}

export interface GuardrailObservation {
  tool: string
  sig: string
  fingerprint: string
  errorSample: string
  sessionID?: string | undefined
}

export interface UpsertGuardrailResult {
  records: Guardrail[]
  record: Guardrail
  isNew: boolean
  /** True when a previously resolved guardrail failed again. */
  reoccurred: boolean
}

export function upsertGuardrail(records: Guardrail[], observation: GuardrailObservation, now: string): UpsertGuardrailResult {
  const existing = records.find((record) => record.sig === observation.sig)
  if (!existing) {
    const record: Guardrail = {
      id: nextGuardrailId(records),
      sig: observation.sig,
      tool: observation.tool,
      fingerprint: observation.fingerprint,
      errorSample: observation.errorSample,
      count: 1,
      firstSeen: now,
      lastSeen: now,
      sessions: observation.sessionID ? [observation.sessionID] : [],
      state: "open",
      mode: "inherit",
    }
    return { records: [...records, record], record, isNew: true, reoccurred: false }
  }

  const reoccurred = existing.state === "resolved"
  const sessions = observation.sessionID
    ? [...existing.sessions.filter((id) => id !== observation.sessionID), observation.sessionID].slice(-GUARDRAIL_SESSION_MEMORY)
    : existing.sessions
  const record: Guardrail = {
    ...existing,
    count: existing.count + 1,
    lastSeen: now,
    sessions,
    // resolved → reoccurred reopens it; dismissed stays dismissed (user chose to ignore it).
    state: reoccurred ? "open" : existing.state,
    errorSample: existing.errorSample || observation.errorSample,
    fingerprint: existing.fingerprint || observation.fingerprint,
  }
  return {
    records: records.map((item) => (item.id === record.id ? record : item)),
    record,
    isNew: false,
    reoccurred,
  }
}

export function resolveGuardrail(
  records: Guardrail[],
  ref: string,
  fix: { input: string },
  now: string,
): { records: Guardrail[]; record: Guardrail } {
  const existing = findGuardrail(records, ref)
  if (!existing) throw new MemoryError("not_found", `no guardrail "${ref}"`, { ref })
  assertGuardrailTransition(existing.state, "resolved")
  const record: Guardrail = { ...existing, state: "resolved", fix: { input: fix.input, at: now } }
  return { records: records.map((item) => (item.id === record.id ? record : item)), record }
}

export function dismissGuardrail(records: Guardrail[], ref: string, now: string): { records: Guardrail[]; record: Guardrail } {
  const existing = findGuardrail(records, ref)
  if (!existing) throw new MemoryError("not_found", `no guardrail "${ref}"`, { ref })
  assertGuardrailTransition(existing.state, "dismissed")
  const record: Guardrail = { ...existing, state: "dismissed" }
  return { records: records.map((item) => (item.id === record.id ? record : item)), record }
}

export function setGuardrailMode(
  records: Guardrail[],
  ref: string,
  mode: GuardrailModeSetting,
): { records: Guardrail[]; record: Guardrail } {
  if (mode !== "inherit" && mode !== "warn" && mode !== "block") {
    throw new MemoryError("invalid_config", `guardrail mode "${mode}" is invalid — use inherit | warn | block`, { mode })
  }
  const existing = findGuardrail(records, ref)
  if (!existing) throw new MemoryError("not_found", `no guardrail "${ref}"`, { ref })
  const record: Guardrail = { ...existing, mode }
  return { records: records.map((item) => (item.id === record.id ? record : item)), record }
}

/**
 * Keep the state file under its cap, deterministically: dismissed first
 * (oldest first), then resolved, then the oldest open records.
 */
export function capGuardrails(records: Guardrail[], max: number): Guardrail[] {
  if (records.length <= max) return records
  const rank = (state: GuardrailState): number => (state === "dismissed" ? 0 : state === "resolved" ? 1 : 2)
  const victims = records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const byRank = rank(a.record.state) - rank(b.record.state)
      if (byRank !== 0) return byRank
      return a.record.lastSeen.localeCompare(b.record.lastSeen) || a.index - b.index
    })
    .slice(0, records.length - max)
  const victimIds = new Set(victims.map((victim) => victim.record.id))
  return records.filter((record) => !victimIds.has(record.id))
}

// ---------------------------------------------------------------------------
// Issue threads
// ---------------------------------------------------------------------------

export const ISSUE_STATUSES = ["open", "fixed", "verifying", "regressed", "closed"] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

export interface IssueNote {
  at: string
  status: IssueStatus
  text: string
}

export interface Issue {
  id: string
  title: string
  status: IssueStatus
  areas: string[]
  createdAt: string
  updatedAt: string
  regressions: number
  verifyWith?: string
  notes: IssueNote[]
}

export const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ["open", "fixed", "verifying", "closed"],
  fixed: ["fixed", "verifying", "regressed", "closed"],
  verifying: ["verifying", "fixed", "regressed", "closed"],
  regressed: ["regressed", "fixed", "verifying", "closed"],
  closed: ["closed", "open"],
}

/** Statuses injected as active work. */
export const ACTIVE_ISSUE_STATUSES: readonly IssueStatus[] = ["open", "verifying", "regressed"]
/** Statuses watched for regression when their areas are touched again. */
export const REGRESSION_WATCH_STATUSES: readonly IssueStatus[] = ["fixed", "closed"]

export const ISSUE_TITLE_LIMIT = 100
export const ISSUE_NOTE_LIMIT = 240
export const ISSUE_MAX_AREAS = 8

function assertIssueTransition(from: IssueStatus, to: IssueStatus): void {
  if (!ISSUE_TRANSITIONS[from].includes(to)) {
    throw new MemoryError("invalid_status", `issue cannot move ${from} → ${to}`, {
      from,
      to,
      allowed: ISSUE_TRANSITIONS[from],
    })
  }
}

const ISSUE_HEADER = /^##\s+#?i(\d+)\s+(open|fixed|verifying|regressed|closed)\s+[—–:-]\s*(.+?)\s*$/
const ISSUE_AREAS = /^-\s*areas:\s*(.+?)\s*$/
const ISSUE_CREATED = /^-\s*created:\s*(\d{4}-\d{2}-\d{2})/
const ISSUE_UPDATED = /^-\s*updated:\s*(\d{4}-\d{2}-\d{2})/
const ISSUE_REGRESSIONS = /^-\s*regressions:\s*(\d+)/
const ISSUE_VERIFY = /^-\s*verify:\s*(.+?)\s*$/
const ISSUE_NOTE = /^-\s*note\s+(\d{4}-\d{2}-\d{2})\s+(open|fixed|verifying|regressed|closed):\s*(.*)$/

export function parseIssues(text: string | null): Issue[] {
  if (!text) return []
  const issues: Issue[] = []
  let current: Issue | null = null
  const flush = (): void => {
    if (current) issues.push(current)
    current = null
  }
  for (const line of text.split(/\r?\n/)) {
    const header = ISSUE_HEADER.exec(line)
    if (header) {
      flush()
      const [, number, status, title] = header
      current = {
        id: `i${number}`,
        title: (title ?? "").trim(),
        status: status as IssueStatus,
        areas: [],
        createdAt: "",
        updatedAt: "",
        regressions: 0,
        notes: [],
      }
      continue
    }
    if (!current) continue
    const areas = ISSUE_AREAS.exec(line)
    if (areas) {
      current.areas = (areas[1] ?? "")
        .split(",")
        .map((area) => area.trim())
        .filter((area) => area !== "")
      continue
    }
    const created = ISSUE_CREATED.exec(line)
    if (created) {
      current.createdAt = created[1] ?? ""
      continue
    }
    const updated = ISSUE_UPDATED.exec(line)
    if (updated) {
      current.updatedAt = updated[1] ?? ""
      continue
    }
    const regressions = ISSUE_REGRESSIONS.exec(line)
    if (regressions) {
      current.regressions = Number.parseInt(regressions[1] ?? "0", 10)
      continue
    }
    const verify = ISSUE_VERIFY.exec(line)
    if (verify) {
      current.verifyWith = verify[1]
      continue
    }
    const note = ISSUE_NOTE.exec(line)
    if (note) {
      current.notes.push({ at: note[1] ?? "", status: note[2] as IssueStatus, text: (note[3] ?? "").trim() })
    }
  }
  flush()
  return issues
}

export function serializeIssues(issues: Issue[]): string {
  if (issues.length === 0) return ""
  return `${issues
    .map((issue) => {
      const lines = [
        `## #${issue.id} ${issue.status} — ${issue.title}`,
        `- areas: ${issue.areas.join(", ")}`,
        `- created: ${issue.createdAt}`,
        `- updated: ${issue.updatedAt}`,
        `- regressions: ${issue.regressions}`,
      ]
      if (issue.verifyWith) lines.push(`- verify: ${issue.verifyWith}`)
      for (const note of issue.notes) lines.push(`- note ${note.at} ${note.status}: ${note.text}`)
      return lines.join("\n")
    })
    .join("\n\n")}\n`
}

export function readIssues(path: string): Issue[] {
  return parseIssues(readText(path))
}

export function writeIssues(path: string, issues: Issue[]): void {
  atomicWrite(path, serializeIssues(issues))
}

function issueNumber(id: string): number {
  const match = /^i?(\d+)$/.exec(id)
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0
}

export function nextIssueId(issues: Issue[]): string {
  let max = 0
  for (const issue of issues) max = Math.max(max, issueNumber(issue.id))
  return `i${max + 1}`
}

export function findIssue(issues: Issue[], ref: string): Issue | undefined {
  const normalized = ref.startsWith("#") ? ref.slice(1) : ref
  return issues.find((issue) => issue.id === normalized)
}

export function activeIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => ACTIVE_ISSUE_STATUSES.includes(issue.status))
}

export function regressionWatchIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => REGRESSION_WATCH_STATUSES.includes(issue.status))
}

export interface OpenIssueInput {
  title: string
  areas: string[]
  note?: string | undefined
  verifyWith?: string | undefined
}

export function openIssue(issues: Issue[], input: OpenIssueInput, now: string): { issues: Issue[]; issue: Issue } {
  const title = input.title.replace(/\s+/g, " ").trim()
  if (title === "") throw new MemoryError("invalid_content", "issue title must be non-empty", { label: "issue title" })
  if (title.length > ISSUE_TITLE_LIMIT) {
    throw new MemoryError("entry_too_long", `issue title is ${title.length} chars (> ${ISSUE_TITLE_LIMIT})`, {
      label: "issue title",
      length: title.length,
      max: ISSUE_TITLE_LIMIT,
    })
  }
  const areas = input.areas.map((area) => area.trim()).filter((area) => area !== "")
  if (areas.length === 0) {
    throw new MemoryError("invalid_content", "an issue needs at least one area (file glob or topic) for regression watch", {
      label: "issue areas",
    })
  }
  if (areas.length > ISSUE_MAX_AREAS) {
    throw new MemoryError("entry_too_long", `an issue accepts at most ${ISSUE_MAX_AREAS} areas (got ${areas.length})`, {
      label: "issue areas",
      max: ISSUE_MAX_AREAS,
    })
  }
  const note = input.note?.replace(/\r\n/g, "\n").trim()
  if (note && note.length > ISSUE_NOTE_LIMIT) {
    throw new MemoryError("entry_too_long", `issue note is ${note.length} chars (> ${ISSUE_NOTE_LIMIT})`, {
      label: "issue note",
      length: note.length,
      max: ISSUE_NOTE_LIMIT,
    })
  }
  const issue: Issue = {
    id: nextIssueId(issues),
    title,
    status: "open",
    areas,
    createdAt: now,
    updatedAt: now,
    regressions: 0,
    notes: note ? [{ at: now, status: "open", text: note }] : [],
  }
  if (input.verifyWith) issue.verifyWith = input.verifyWith.trim()
  return { issues: [...issues, issue], issue }
}

export interface UpdateIssueInput {
  status?: IssueStatus | undefined
  note?: string | undefined
  verifyWith?: string | undefined
}

export function updateIssue(
  issues: Issue[],
  ref: string,
  patch: UpdateIssueInput,
  now: string,
): { issues: Issue[]; issue: Issue; regressed: boolean } {
  const existing = findIssue(issues, ref)
  if (!existing) throw new MemoryError("not_found", `no issue "${ref}"`, { ref })

  const status = patch.status
  if (status !== undefined) {
    if (!ISSUE_STATUSES.includes(status)) {
      throw new MemoryError("invalid_status", `"${String(status)}" is not an issue status`, { status, allowed: ISSUE_STATUSES })
    }
    assertIssueTransition(existing.status, status)
  }

  const note = patch.note?.replace(/\r\n/g, "\n").trim()
  if (note && note.length > ISSUE_NOTE_LIMIT) {
    throw new MemoryError("entry_too_long", `issue note is ${note.length} chars (> ${ISSUE_NOTE_LIMIT})`, {
      label: "issue note",
      length: note.length,
      max: ISSUE_NOTE_LIMIT,
    })
  }

  const nextStatus = status ?? existing.status
  const regressed = status === "regressed" && existing.status !== "regressed"
  const issue: Issue = {
    ...existing,
    status: nextStatus,
    updatedAt: now,
    regressions: existing.regressions + (regressed ? 1 : 0),
    notes: note ? [...existing.notes, { at: now, status: nextStatus, text: note }] : existing.notes,
  }
  if (patch.verifyWith !== undefined) issue.verifyWith = patch.verifyWith.trim()
  return { issues: issues.map((item) => (item.id === issue.id ? issue : item)), issue, regressed }
}
