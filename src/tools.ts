/**
 * The nine `memory_*` tools (server side).
 *
 * Inputs are plain JSON Schema (the schema informs the model; these functions
 * validate again — schemas are not a trust boundary). Results are text plus
 * tiny metadata (PAT-06). Every expected failure throws a `MemoryError`
 * wrapped as `[code] message` so the model sees the shared error vocabulary
 * and can correct course in the same turn.
 *
 * All mutations go through the runtime, which keeps the single-writer rule and
 * settle-on-write (epoch bump + `changed` event) in one place.
 */
import { MemoryError, isMemoryError } from "./core/errors.ts"
import {
  appendLearningText,
  normalizeLearning,
  openIssue,
  readLearnings,
  serializeIssues,
  updateIssue,
} from "./core/learnings.ts"
import type { IssueStatus } from "./core/learnings.ts"
import { atomicWrite, readText } from "./core/paths.ts"
import {
  addEntry,
  charCount,
  defaultKind,
  displayEntry,
  normalizeEntryContent,
  parseEntries,
  readEntries,
  removeEntry,
  replaceEntry,
  resolveKind,
  validateRouting,
  writeEntries,
} from "./core/store.ts"
import type { Entry, Scope } from "./core/store.ts"
import { deleteRecovery, readRecovery, writeRecovery } from "./core/store.ts"
import type { MemoryConfig } from "./core/config.ts"
import { projectTermsFor } from "./runtime.ts"
import type { ConfigView, LoadedWorkspace, MemoryRuntime, SearchTarget, StatusData } from "./runtime.ts"

// ---------------------------------------------------------------------------
// Tool contract (consumed by index.ts → ctx.tool.transform)
// ---------------------------------------------------------------------------

export interface MemoryToolResult {
  content: string
  metadata?: Record<string, unknown>
}

export interface MemoryToolContext {
  sessionID: string
}

export interface MemoryToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: unknown, context: MemoryToolContext) => Promise<MemoryToolResult>
}

type ToolInput = Record<string, unknown>

function asRecord(input: unknown): ToolInput {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as ToolInput) : {}
}

function strField(input: ToolInput, key: string): string | undefined {
  const value = input[key]
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function requireField(input: ToolInput, key: string): string {
  const value = strField(input, key)
  if (value === undefined || value.trim() === "") {
    throw new MemoryError("invalid_content", `"${key}" is required`, { field: key })
  }
  return value
}

function enumField<T extends string>(input: ToolInput, key: string, allowed: readonly T[], fallback?: T): T {
  const value = strField(input, key)
  if (value === undefined || value.trim() === "") {
    if (fallback !== undefined) return fallback
    throw new MemoryError("invalid_content", `"${key}" is required (one of: ${allowed.join(", ")})`, {
      field: key,
      allowed,
    })
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new MemoryError("invalid_content", `"${key}" must be one of: ${allowed.join(", ")} (got "${value}")`, {
      field: key,
      allowed,
      value,
    })
  }
  return value as T
}

function intField(input: ToolInput, key: string, fallback: number, max: number): number {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.trunc(parsed), max)
}

/** Wrap expected failures so the model sees `[code] message`. */
async function guarded(fn: () => Promise<string> | string): Promise<MemoryToolResult> {
  try {
    return { content: await fn() }
  } catch (error) {
    if (isMemoryError(error)) throw new Error(`[${error.code}] ${error.message}`)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

function capFor(config: MemoryConfig, scope: Scope): number {
  return scope === "personality" ? config.personalityCharLimit : config.projectCharLimit
}

function fileForScope(loaded: LoadedWorkspace, scope: Scope): string {
  return scope === "personality" ? loaded.files.personality : loaded.files.project
}

function entriesForScope(loaded: LoadedWorkspace, scope: Scope): Entry[] {
  return scope === "personality" ? loaded.personality : loaded.project
}

function recoveryDirForScope(loaded: LoadedWorkspace, scope: Scope): string {
  return scope === "personality" ? loaded.files.personalityRecoveryDir : loaded.files.projectRecoveryDir
}

function usageLine(entries: Entry[], cap: number): string {
  return `${entries.length} entries · ${charCount(entries)}/${cap} chars`
}

function checkRouting(loaded: LoadedWorkspace, scope: Scope, content: string): void {
  validateRouting({ scope, kind: "unknown", content, projectTerms: projectTermsFor(loaded.projectRoot) })
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function memoryTools(runtime: MemoryRuntime): MemoryToolDefinition[] {
  const today = (): string => runtime.now().toISOString().slice(0, 10)

  return [
    // -----------------------------------------------------------------------
    // memory_set
    // -----------------------------------------------------------------------
    {
      name: "memory_set",
      description:
        "Persist a durable entry to memory as a BRIEF line (prefer one line, max 3). " +
        "Routing: target=personality is for cross-project entries only — kind=rule (operating rules) or kind=machine (environment facts); " +
        "target=project is for this project — kind=fact|pref|decision|correction. Project names/paths/identifiers are rejected in personality. " +
        "A correction overrides stale training: use kind=correction with 'about: …; wrong: …; use: …; verified: <date/source>'. " +
        "action=add creates a new entry; action=replace edits an existing one (give a unique old_text substring). " +
        "If the store is over its cap the write fails with usage — consolidate (replace/forget) in the SAME turn, then retry.",
      input: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["personality", "project"], description: "personality = cross-project, project = this project" },
          kind: {
            type: "string",
            description: "personality: rule|machine · project: fact|pref|decision|correction (defaults: rule / fact)",
          },
          action: { type: "string", enum: ["add", "replace"], description: "add a new entry, or replace an existing one via old_text" },
          content: { type: "string", description: "Brief entry text (one line preferred; max 3 lines)" },
          old_text: { type: "string", description: "Unique substring of the entry to replace (required for action=replace)" },
        },
        required: ["target", "action", "content"],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const scope = enumField(input, "target", ["personality", "project"] as const)
          const action = enumField(input, "action", ["add", "replace"] as const)
          const content = requireField(input, "content")
          const oldText = strField(input, "old_text")
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const cap = capFor(loaded.config, scope)
          const file = fileForScope(loaded, scope)
          const entries = entriesForScope(loaded, scope)
          const kind = strField(input, "kind")

          if (action === "add") {
            const resolvedKind = resolveKind(scope, kind)
            checkRouting(loaded, scope, content)
            const normalized = normalizeEntryContent(content, {
              perEntryCharLimit: loaded.config.perEntryCharLimit,
              maxEntryLines: loaded.config.maxEntryLines,
            })
            const { entries: next, duplicate } = addEntry(entries, { kind: resolvedKind, text: normalized }, cap)
            if (duplicate) {
              return `= identical ${scope} entry already present — no change (${usageLine(entries, cap)})`
            }
            writeEntries(file, next, scope)
            runtime.commit(loaded, scope)
            return `✓ added ${scope}/${resolvedKind}: "${normalized}" (${usageLine(next, cap)})`
          }

          if (oldText === undefined || oldText.trim() === "") {
            throw new MemoryError("invalid_content", "replace requires old_text (a unique substring of the entry)", {
              field: "old_text",
            })
          }
          checkRouting(loaded, scope, content)
          const normalized = normalizeEntryContent(content, {
            perEntryCharLimit: loaded.config.perEntryCharLimit,
            maxEntryLines: loaded.config.maxEntryLines,
          })
          const { entries: next } = replaceEntry(entries, oldText, normalized, cap, kind ? resolveKind(scope, kind) : undefined)
          writeEntries(file, next, scope)
          runtime.commit(loaded, scope)
          return `✓ replaced 1 ${scope} entry — "${normalized}" (${usageLine(next, cap)})`
        }),
    },

    // -----------------------------------------------------------------------
    // memory_read
    // -----------------------------------------------------------------------
    {
      name: "memory_read",
      description:
        "Read the current memory entries for a scope (personality = cross-project, project = this project), " +
        "optionally filtered to one kind. Use when you need the full list; the injected MEMORY block already carries the essentials.",
      input: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["personality", "project"] },
          kind: { type: "string", description: "Optional filter: rule|machine|fact|pref|decision|correction" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const scope = enumField(input, "target", ["personality", "project"] as const)
          const kindFilter = strField(input, "kind")?.trim()
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const cap = capFor(loaded.config, scope)
          const all = entriesForScope(loaded, scope)
          const entries = kindFilter ? all.filter((entry) => entry.kind === kindFilter) : all
          if (entries.length === 0) {
            return kindFilter
              ? `no ${scope} entries of kind "${kindFilter}" (${usageLine(all, cap)})`
              : `${scope} memory is empty (0/${cap} chars) — add entries via memory_set`
          }
          const lines = entries.map((entry, index) => {
            const display = displayEntry(entry)
            return `#${index + 1} (${display.length}) ${display}`
          })
          return `${scope} (${usageLine(all, cap)})\n${lines.join("\n")}`
        }),
    },

    // -----------------------------------------------------------------------
    // memory_search
    // -----------------------------------------------------------------------
    {
      name: "memory_search",
      description:
        "Keyword recall (BM25-lite, no LLM) across memory entries, lessons, issue threads and guardrails. " +
        "Run this BEFORE guessing about past decisions, commands, failures or conventions — it is free. " +
        "target: project (default) | personality | all.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for" },
          target: { type: "string", enum: ["project", "personality", "all"], description: "Where to search (default project)" },
          limit: { type: "integer", description: "Max results (default 5, max 10)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const query = requireField(input, "query")
          const target = enumField<SearchTarget>(input, "target", ["project", "personality", "all"] as const, "project")
          const limit = intField(input, "limit", 5, 10)
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const hits = runtime.searchMemory(loaded, query, target, limit)
          runtime.writeAudit(loaded, "search", { query, target, hits: hits.length })
          if (hits.length === 0) return `no matches for "${query}" in ${target} memory`
          const lines = hits.map((hit, index) => {
            const ref = hit.ref ? ` ${hit.ref}` : ""
            return `[${index + 1}] ${hit.name}${ref} (score ${hit.score})\n    ${hit.snippet}`
          })
          return `${hits.length} match(es) for "${query}" in ${target} memory:\n${lines.join("\n")}`
        }),
    },

    // -----------------------------------------------------------------------
    // memory_learn
    // -----------------------------------------------------------------------
    {
      name: "memory_learn",
      description:
        "Distill a BRIEF lesson (short title + 1-2 line takeaway) from a success OR failure — failures become preventable next time. " +
        "Lessons are recalled on demand via memory_search and their titles are indexed in the injected MEMORY block.",
      input: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["success", "failure"], description: "Was this a success or a failure?" },
          title: { type: "string", description: "Brief lesson title (one line, max 80 chars)" },
          content: { type: "string", description: "The distilled takeaway (1-2 lines, max 240 chars)" },
        },
        required: ["outcome", "title", "content"],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const outcome = enumField(input, "outcome", ["success", "failure"] as const)
          const title = requireField(input, "title")
          const content = requireField(input, "content")
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const learning = normalizeLearning({ outcome, title, content })
          const existing = readLearnings(loaded.files.learnings)
          if (existing.some((item) => item.outcome === learning.outcome && item.title === learning.title && item.content === learning.content)) {
            return `= identical lesson already recorded — no change (${existing.length} lesson(s))`
          }
          atomicWrite(loaded.files.learnings, appendLearningText(readText(loaded.files.learnings), learning))
          runtime.commit(loaded, "learnings")
          return `✓ lesson recorded (${learning.outcome}): "${learning.title}" (${existing.length + 1} lesson(s))`
        }),
    },

    // -----------------------------------------------------------------------
    // memory_issue
    // -----------------------------------------------------------------------
    {
      name: "memory_issue",
      description:
        "Manage issue threads for multi-turn work. action=open(title, area/areas, note, verify_with) starts a thread; " +
        "its areas (file globs like src/auth/** or topics like auth) resurface it — including a REGRESSION WATCH after it is fixed/closed — " +
        "whenever those files/topics are touched again. action=update(id, status, note) moves it " +
        "(open → fixed|verifying → closed; status=regressed reopens regression tracking with a new note). action=list shows all threads.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["open", "update", "list"], description: "Default: list" },
          id: { type: "string", description: "Thread id like i3 or #i3 (update)" },
          title: { type: "string", description: "Issue title (open; max 100 chars)" },
          area: { type: "string", description: "Comma-separated areas (file globs/topics) — or use areas[]" },
          areas: { type: "array", items: { type: "string" }, description: "Areas for regression watch (glob like src/auth/** or topic like auth)" },
          note: { type: "string", description: "1-2 line note: root cause, what to watch, what changed (max 240 chars)" },
          status: { type: "string", enum: ["open", "fixed", "verifying", "regressed", "closed"], description: "New status (update)" },
          verify_with: { type: "string", description: "How to verify the fix (test command or check)" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const action = enumField(input, "action", ["open", "update", "list"] as const, "list")
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const issues = loaded.threads

          if (action === "open") {
            const title = requireField(input, "title")
            const areas = mergeAreas(input)
            const note = strField(input, "note")
            const verifyWith = strField(input, "verify_with")
            const { issues: next, issue } = openIssue(
              issues,
              {
                title,
                areas,
                ...(note !== undefined ? { note } : {}),
                ...(verifyWith !== undefined ? { verifyWith } : {}),
              },
              today(),
            )
            atomicWrite(loaded.files.issues, serializeIssues(next))
            runtime.commit(loaded, "issues")
            return `✓ opened #${issue.id} (${issue.status}) "${issue.title}" · areas: ${issue.areas.join(", ")}`
          }

          if (action === "update") {
            const id = requireField(input, "id")
            const status = strField(input, "status")
            const note = strField(input, "note")
            const verifyWith = strField(input, "verify_with")
            if (status === undefined && note === undefined && verifyWith === undefined) {
              throw new MemoryError("invalid_content", "update needs at least one of: status, note, verify_with", { id })
            }
            const { issues: next, issue, regressed } = updateIssue(
              issues,
              id,
              {
                ...(status !== undefined ? { status: status as IssueStatus } : {}),
                ...(note !== undefined ? { note } : {}),
                ...(verifyWith !== undefined ? { verifyWith } : {}),
              },
              today(),
            )
            atomicWrite(loaded.files.issues, serializeIssues(next))
            runtime.commit(loaded, "issues")
            const regressionNote = regressed ? ` ⚠ regressed (regression #${issue.regressions} recorded)` : ""
            return `✓ #${issue.id} → ${issue.status}${regressionNote} — "${issue.title}"${note ? ` · note: ${note}` : ""}`
          }

          if (issues.length === 0) return "no issue threads yet — open one with action=open when starting multi-turn work"
          const shown = [...issues]
            .sort((a, b) => {
              const rank = (status: IssueStatus): number =>
                status === "open" || status === "verifying" || status === "regressed" ? 0 : 1
              return rank(a.status) - rank(b.status) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
            })
            .slice(0, 20)
          const lines = shown.map((issue) => {
            const marker = issue.status === "open" || issue.status === "verifying" || issue.status === "regressed" ? "●" : "○"
            const latest = issue.notes[issue.notes.length - 1]
            const note = latest ? `\n    note: ${latest.text.replace(/\s+/g, " ").slice(0, 90)}` : ""
            const verify = issue.verifyWith ? ` · verify: ${issue.verifyWith}` : ""
            const regressions = issue.regressions > 0 ? ` · regressions: ${issue.regressions}` : ""
            return `${marker} #${issue.id} ${issue.status} — ${issue.title} · areas: ${issue.areas.join(", ")} · updated ${issue.updatedAt}${regressions}${verify}${note}`
          })
          const suffix = issues.length > shown.length ? `\n… ${issues.length - shown.length} more` : ""
          return `${issues.length} thread(s):\n${lines.join("\n")}${suffix}`
        }),
    },

    // -----------------------------------------------------------------------
    // memory_forget
    // -----------------------------------------------------------------------
    {
      name: "memory_forget",
      description:
        "Remove one memory entry (matched by a unique old_text substring) from personality or project memory. " +
        "Recoverable: the removal is recorded and returns a recovery id usable with memory_restore. Include a brief reason.",
      input: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["personality", "project"] },
          old_text: { type: "string", description: "Unique substring identifying the entry to remove" },
          reason: { type: "string", description: "Why it is no longer relevant" },
        },
        required: ["target", "old_text"],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const scope = enumField(input, "target", ["personality", "project"] as const)
          const oldText = requireField(input, "old_text")
          const reason = strField(input, "reason")
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const entries = entriesForScope(loaded, scope)
          const { entries: next, removed } = removeEntry(entries, oldText)
          const recoveryId = writeRecovery(recoveryDirForScope(loaded, scope), {
            target: scope,
            removed: [displayEntry(removed)],
            at: runtime.now().toISOString(),
            ...(reason !== undefined ? { reason } : {}),
          })
          writeEntries(fileForScope(loaded, scope), next, scope)
          runtime.commit(loaded, scope)
          return `✓ removed from ${scope}: "${displayEntry(removed)}" (${usageLine(next, capFor(loaded.config, scope))}) · recovery: ${recoveryId} (restore via memory_restore)`
        }),
    },

    // -----------------------------------------------------------------------
    // memory_restore
    // -----------------------------------------------------------------------
    {
      name: "memory_restore",
      description: "Restore entries removed by memory_forget, using the recovery id it returned. The recovery record is consumed on success.",
      input: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["personality", "project"] },
          recovery_id: { type: "string", description: "Recovery id returned by memory_forget" },
        },
        required: ["target", "recovery_id"],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const scope = enumField(input, "target", ["personality", "project"] as const)
          const recoveryId = requireField(input, "recovery_id")
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const dir = recoveryDirForScope(loaded, scope)
          const record = readRecovery(dir, recoveryId)
          if (!record) {
            throw new MemoryError("not_found", `no recovery record "${recoveryId}" for ${scope}`, { recovery_id: recoveryId })
          }
          const cap = capFor(loaded.config, scope)
          let next = entriesForScope(loaded, scope)
          let restored = 0
          let skipped = 0
          for (const display of record.removed) {
            if (next.some((entry) => displayEntry(entry) === display)) {
              skipped++
              continue
            }
            const parsed = parseEntries(`- ${display}`, scope)[0] ?? { kind: defaultKind(scope), text: display }
            const result = addEntry(next, parsed, cap)
            if (result.duplicate) {
              skipped++
              continue
            }
            next = result.entries
            restored++
          }
          if (restored > 0) writeEntries(fileForScope(loaded, scope), next, scope)
          deleteRecovery(dir, recoveryId)
          runtime.commit(loaded, scope)
          if (restored === 0) {
            return `= all ${skipped} entr${skipped === 1 ? "y was" : "ies were"} already present — recovery ${recoveryId} consumed`
          }
          const skipNote = skipped > 0 ? ` · skipped ${skipped} already present` : ""
          return `✓ restored ${restored} entr${restored === 1 ? "y" : "ies"} to ${scope} (${usageLine(next, cap)})${skipNote} · recovery ${recoveryId} consumed`
        }),
    },

    // -----------------------------------------------------------------------
    // memory_status
    // -----------------------------------------------------------------------
    {
      name: "memory_status",
      description:
        "Memory health report: store usage vs caps, lesson/thread/guardrail counts, injection totals, the effective config with per-field source, " +
        "warnings (malformed layers, invalid values) and routing lint (suspected personality↔project misplacements to fix in the same turn).",
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: (_rawInput, context) =>
        guarded(async () => {
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          return formatStatus(runtime.statusData(loaded), loaded)
        }),
    },

    // -----------------------------------------------------------------------
    // memory_audit
    // -----------------------------------------------------------------------
    {
      name: "memory_audit",
      description:
        "Self-evaluation over the injection audit log: injection history, per-entry effectiveness (injected N / reoccurred M), " +
        "never-matched corrections/lessons, and actionable recommendations (reword, merge, enable block, or delete). " +
        "Run it after big fixes and act on its recommendations.",
      input: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max entries in the effectiveness table (default 10)" },
        },
        required: [],
        additionalProperties: false,
      },
      execute: (rawInput, context) =>
        guarded(async () => {
          const input = asRecord(rawInput)
          const limit = intField(input, "limit", 10, 25)
          const loaded = runtime.load(await runtime.resolveWorkspace(context.sessionID))
          const events = runtime.auditEvents(loaded)
          const stats = runtime.auditStats(loaded)
          runtime.writeAudit(loaded, "review", { events: events.length })
          const lines: string[] = []
          lines.push(
            `memory audit — ${stats.sessions} session(s) · ${stats.injections} injection(s) · ${stats.failures} failure(s) · ${stats.resolves} resolve(s) · ${stats.preflights} preflight(s) (${stats.blocked} blocked) · ${stats.searches} search(es)`,
          )
          if (!loaded.config.audit.enabled) lines.push("(audit.enabled is false — new events are not being recorded)")

          const labels = runtime.labelsFor(loaded)
          const effective = [...stats.entries]
            .sort((a, b) => b.reoccurred - a.reoccurred || b.injected - a.injected || a.ref.localeCompare(b.ref))
            .slice(0, limit)
          if (effective.length > 0) {
            lines.push("", "effectiveness (worst first)")
            for (const entry of effective) {
              const label = labels.get(entry.ref) ?? ""
              lines.push(
                `  ${entry.ref} injected ${entry.injected}× · reoccurred ${entry.reoccurred}×${label ? ` — ${label}` : ""}`,
              )
            }
          }

          const recommendations = runtime.recommendations(loaded, stats)
          if (recommendations.length > 0) {
            lines.push("", "recommendations")
            for (const item of recommendations.slice(0, 12)) lines.push(`  - ${item}`)
          }

          const injections = events.filter((event) => event.type === "inject").slice(-5).reverse()
          if (injections.length > 0) {
            lines.push("", "recent injections")
            for (const event of injections) {
              const chars = typeof event["chars"] === "number" ? event["chars"] : 0
              const hash = typeof event["hash"] === "string" ? event["hash"] : "?"
              const sections = Array.isArray(event["sections"]) ? event["sections"].length : 0
              const truncations = Array.isArray(event["truncations"]) ? (event["truncations"] as unknown[]).length : 0
              lines.push(
                `  ${String(event.ts)} ${hash} · ${chars} chars · ${sections} section(s)${truncations > 0 ? ` · ${truncations} truncation(s)` : ""}`,
              )
            }
          }
          if (events.length === 0) lines.push("", "no audit events yet — they accumulate as memory is injected and used")
          return lines.join("\n")
        }),
    },
  ]
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function mergeAreas(input: ToolInput): string[] {
  const areas: string[] = []
  const single = strField(input, "area")
  if (single !== undefined) {
    for (const piece of single.split(",")) {
      const trimmed = piece.trim()
      if (trimmed !== "") areas.push(trimmed)
    }
  }
  const many = input["areas"]
  if (Array.isArray(many)) {
    for (const item of many) {
      if (typeof item === "string" && item.trim() !== "") areas.push(item.trim())
    }
  }
  return [...new Set(areas)]
}

function formatStatus(data: StatusData, loaded: LoadedWorkspace): string {
  const lines: string[] = []
  lines.push(`memory status — ${data.projectRoot}`)
  lines.push(
    `  personality ${data.usage.personality.chars}/${data.usage.personality.cap} chars · ${data.usage.personality.entries} entries`,
    `  project ${data.usage.project.chars}/${data.usage.project.cap} chars · ${data.usage.project.entries} entries`,
    `  lessons ${data.usage.lessons} · threads ${threadSummary(data)} · guardrails ${guardrailSummary(data)}`,
    `  audit: ${data.audit.injections} injection(s) across ${data.audit.sessions} session(s) · ${data.audit.failures} failure(s) · ${data.audit.resolves} resolve(s) · ${data.audit.searches} search(es)`,
  )
  lines.push("", "config (effective · source)")
  for (const [key, value] of Object.entries(data.config.values)) {
    lines.push(`  ${key} = ${formatValue(value)} (${sourceLabel(data.config.sources[key] ?? "default", loaded)})`)
  }
  if (data.config.warnings.length > 0) {
    lines.push("", "warnings")
    for (const warning of data.config.warnings) lines.push(`  - ${warning}`)
  }
  if (data.lint.length > 0) {
    lines.push("", "routing lint")
    for (const item of data.lint) lines.push(`  - ${item}`)
  }
  return lines.join("\n")
}

function threadSummary(data: StatusData): string {
  const threads = data.usage.threads
  const parts: string[] = []
  if (threads.open > 0) parts.push(`${threads.open} open`)
  if (threads.verifying > 0) parts.push(`${threads.verifying} verifying`)
  if (threads.regressed > 0) parts.push(`${threads.regressed} regressed`)
  if (threads.fixed > 0) parts.push(`${threads.fixed} fixed`)
  if (threads.closed > 0) parts.push(`${threads.closed} closed`)
  const active = threads.active.length > 0 ? ` (active: ${threads.active.join(", ")})` : ""
  return (parts.length > 0 ? parts.join(", ") : "none") + active
}

function guardrailSummary(data: StatusData): string {
  const guardrails = data.usage.guardrails
  return Object.entries(guardrails)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ") || "none"
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.join(", ")
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

function sourceLabel(source: string, loaded: LoadedWorkspace): string {
  if (source === loaded.files.globalConfig) return "global config"
  if (source === loaded.files.projectConfig) return "project config"
  return source
}
