/**
 * Server runtime: the adapter between OpenCode's plugin surface and the pure
 * `core/` modules (ARC-01 / PAT-05).
 *
 * Holds all per-instance state (epoch, per-session turn caches) and the
 * per-session resolution chain `sessionID → directory → canonical project
 * root`. Tools, hooks and RPC all call into this single runtime, so behaviour
 * never drifts between surfaces.
 *
 * Deliberately free of runtime imports from `@opencode/*` so `node --test` can
 * exercise it directly with fake deps.
 */
import { appendEventText, buildRecommendations, computeStats, contentId, createAuditEvent, entryRef, parseEvents, pruneEvents, serializeEvents } from "./core/audit.ts"
import type { AuditEvent, AuditEventType, AuditStats } from "./core/audit.ts"
import {
  CONFIG_FIELDS,
  CONFIG_FIELD_PATHS,
  loadConfig,
  readFieldValue,
  isConfigFieldPath,
  setRawField,
  validateFieldValue,
} from "./core/config.ts"
import type { ConfigFieldPath, MemoryConfig } from "./core/config.ts"
import { MemoryError } from "./core/errors.ts"
import { collectPaths, jitMatches } from "./core/jit.ts"
import type { JitMatch, TurnContext } from "./core/jit.ts"
import type { ToolCallLike } from "./core/jit.ts"
import {
  ACTIVE_ISSUE_STATUSES,
  capGuardrails,
  lessonRef,
  readGuardrails,
  readIssues,
  readLearnings,
  resolveGuardrail,
  serializeGuardrails,
  setGuardrailMode as setGuardrailModeCore,
  upsertGuardrail,
} from "./core/learnings.ts"
import type { Guardrail, GuardrailModeSetting, Issue, Learning } from "./core/learnings.ts"
import {
  atomicWrite,
  auditPath,
  canonicalProjectRoot,
  configPath,
  ensureMemoryDir,
  globalMemoryDir,
  guardrailsPath,
  issuesPath,
  learningsPath,
  personalityPath,
  projectEntriesPath,
  projectMemoryDir,
  readText,
  recoveryDirFor,
  type PathEnv,
} from "./core/paths.ts"
import { searchDocs } from "./core/search.ts"
import type { SearchDoc } from "./core/search.ts"
import { buildSnapshot, guardrailLine, SECTION_RENDER_ORDER } from "./core/snapshot.ts"
import type { SectionName, SnapshotPin, SnapshotSectionInfo } from "./core/snapshot.ts"
import {
  canResolveWith,
  jaccard,
  matchGuardrail,
  normalizeCall,
  signatureFor,
  stableStringify,
  tokenSet,
} from "./core/signature.ts"
import type { CallLike } from "./core/signature.ts"
import { charCount, displayEntry, readEntries, routingLint } from "./core/store.ts"
import type { Entry } from "./core/store.ts"
import { basename } from "node:path"

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/** A memory workspace: where the project lives and where its stores are. */
export interface Workspace {
  sessionID?: string | undefined
  /** Working directory of the session (or the plugin instance's location). */
  directory: string
  /** Canonical project root (git worktree main root; the directory otherwise). */
  projectRoot: string
  /** `<projectRoot>/.opencode/memory`. */
  projectDir: string
  /** `~/.config/opencode/memory`. */
  globalDir: string
}

/** Store/config file paths for a workspace (single place that computes them). */
export interface WorkspaceFiles {
  personality: string
  project: string
  learnings: string
  issues: string
  guardrails: string
  audit: string
  personalityRecoveryDir: string
  projectRecoveryDir: string
  globalConfig: string
  projectConfig: string
}

/** Workspace + everything currently on disk for it (fresh on every load). */
export interface LoadedWorkspace extends Workspace {
  files: WorkspaceFiles
  config: MemoryConfig
  sources: Record<ConfigFieldPath, string>
  warnings: string[]
  personality: Entry[]
  project: Entry[]
  lessons: Learning[]
  guardrails: Guardrail[]
  threads: Issue[]
}

export type ChangedScope = "personality" | "project" | "learnings" | "issues" | "guardrails" | "config"

export interface RuntimeDeps {
  /** Plugin `options` from opencode.json — the base config layer. */
  options?: Record<string, unknown> | undefined
  /**
   * Resolve the working directory for a session (uses `session.get` with the
   * plugin instance's location as fallback). `undefined` → instance location.
   */
  resolveDirectory: (sessionID?: string) => Promise<string>
  /** Overrides for home/config roots (tests). */
  env?: PathEnv | undefined
  /** RPC event sink. Failures are isolated (ARC-02) — publishers never break. */
  emit?: ((event: "changed" | "injected", data: Record<string, unknown>) => void) | undefined
  /** Clock override (tests). */
  now?: (() => Date) | undefined
  /** Optional debug sink (OPENCODE_MEMORY_DEBUG). */
  debug?: ((message: string) => void) | undefined
}

// ---------------------------------------------------------------------------
// Turn extraction (context hook messages → turn key + JIT context)
// ---------------------------------------------------------------------------

/** Flatten a message's text parts into one string (defensive about shapes). */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown } | undefined)?.text
    if ((part as { type?: unknown } | undefined)?.type === "text" && typeof text === "string") parts.push(text)
  }
  return parts.join("\n")
}

/**
 * Turn key = the last user message's id (stable across every model call of the
 * turn). Falls back to position + text hash when ids are absent.
 */
export function deriveTurnKey(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; id?: unknown } | undefined
    if (message?.role !== "user") continue
    if (typeof message.id === "string" && message.id !== "") return message.id
    return `u${i}:${contentId("t", messageText(message).slice(0, 240))}`
  }
  return "none"
}

export const TURN_TOOL_CALL_LIMIT = 24

/** Cap on guardrail ids remembered as surfaced per session. */
export const SURFACED_LIMIT = 32

/** Current turn's user text + file paths/commands from its tool calls. */
export function turnContextFromMessages(messages: readonly unknown[]): TurnContext {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown } | undefined)?.role === "user") {
      lastUser = i
      break
    }
  }
  const text = lastUser >= 0 ? messageText(messages[lastUser]) : ""
  const calls: ToolCallLike[] = []
  for (let i = lastUser + 1; i < messages.length; i++) {
    const content = (messages[i] as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const call = part as { type?: unknown; name?: unknown; input?: unknown } | undefined
      if (call?.type === "tool-call" && typeof call.name === "string") calls.push({ tool: call.name, input: call.input })
    }
  }
  const { files, commands } = collectPaths(calls.slice(-TURN_TOOL_CALL_LIMIT))
  return { text, files, commands }
}

// ---------------------------------------------------------------------------
// Injection state
// ---------------------------------------------------------------------------

const SECTION_REASON: Record<SectionName, string> = {
  GUARDRAILS: "always",
  PERSONALITY: "always",
  "OPEN THREADS": "always",
  CORRECTIONS: "always",
  PROJECT: "always",
  LESSONS: "always",
  "RELEVANT THIS TURN": "jit",
  DISTILL: "post-compaction",
  "MEMORY PROTOCOL": "always",
}

export interface InjectionResult {
  /** The block to append to system parts (undefined when there is nothing to inject). */
  block?: string | undefined
  rebuilt: boolean
  hash?: string | undefined
  chars?: number | undefined
}

/** Result of capturing a tool failure (`execute.after` → status error). */
export interface CaptureResult {
  /** Guardrail id that records the failure (undefined when capture is off). */
  guardrail?: string | undefined
  /** True when a previously resolved guardrail matched and its fix was pinned. */
  coached: boolean
}

/** Result of matching a planned call against guardrails (`execute.before`). */
export interface PreflightResult {
  blocked: boolean
  guardrail?: string | undefined
  /** Message for the aborted call (block mode only). */
  message?: string | undefined
}

/** Result of auto-resolving guardrails after a successful call. */
export interface AutoResolveResult {
  resolved: string[]
}

/** One tool outcome from `execute.after` (error or completed). */
export interface ToolOutcomeInput {
  sessionID: string
  tool: string
  input: unknown
  status: "completed" | "error"
  /** Present when the tool threw (`status: "error"`). */
  error?: unknown
  /** Present when the tool returned (`status: "completed"`). */
  result?: unknown
}

/** What `toolOutcome` did with one call. */
export interface ToolOutcomeResult {
  captured: boolean
  coached: boolean
  resolved: string[]
}

interface SessionState {
  turnKey?: string | undefined
  block?: string | undefined
  blockHash?: string | undefined
  blockSections: SnapshotSectionInfo[]
  blockTruncations: string[]
  blockEpoch: number
  blockConfigStamp?: string | undefined
  /** Last block written into a system array — lets us replace carried-over parts. */
  appliedBlock?: string | undefined
  pins: SnapshotPin[]
  pinsVersion: number
  blockPinsVersion: number
  /** A distillation pass was requested by the last compaction (opt-in). */
  pendingDistill: boolean
  /** Guardrail ids surfaced to the model this session (id → last surfaced at). */
  surfaced: Map<string, string>
  inFlight?: Promise<InjectionResult> | undefined
}

interface InjectionAuditSection {
  name: SectionName
  chars: number
  reason: string
  refs: string[]
  why?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Status DTO (PAT-06: tool/RPC contract, not internal records)
// ---------------------------------------------------------------------------

export interface StatusData {
  projectRoot: string
  projectDir: string
  globalDir: string
  sessionID?: string | undefined
  config: { values: Record<string, unknown>; sources: Record<string, string>; warnings: string[] }
  usage: {
    personality: { entries: number; chars: number; cap: number }
    project: { entries: number; chars: number; cap: number }
    lessons: number
    threads: { open: number; fixed: number; verifying: number; regressed: number; closed: number; active: string[] }
    guardrails: Record<string, number>
    /** Open guardrails that already failed again (unresolved reoccurrences). */
    reoccurring: number
  }
  audit: { injections: number; sessions: number; failures: number; resolves: number; searches: number }
  lint: string[]
}

export interface SearchHitDTO {
  name: string
  snippet: string
  score: number
  ref: string
}

/** One logged injection (for the TUI injections timeline). */
export interface InjectionLogEntry {
  ts: string
  sessionID?: string | undefined
  turnKey?: string | undefined
  hash: string
  chars: number
  refs: string[]
  sections: { name: string; chars: number; reason: string; refs: string[]; why?: Record<string, string> }[]
  truncations?: string[] | undefined
}

/** Effectiveness table + totals (for the TUI effectiveness tab). */
export interface EffectivenessData {
  totals: {
    sessions: number
    injections: number
    failures: number
    resolves: number
    preflights: number
    blocked: number
    searches: number
  }
  entries: {
    ref: string
    injected: number
    reoccurred: number
    firstInjectedAt?: string | undefined
    lastInjectedAt?: string | undefined
    label?: string | undefined
  }[]
  recommendations: string[]
}

export type SearchTarget = "project" | "personality" | "all"

export interface ConfigView {
  values: Record<string, unknown>
  sources: Record<string, string>
  warnings: string[]
  /** Field catalog (path/type/description) so clients can build editors. */
  fields: { path: string; type: string; description: string }[]
}

/** One guardrail record as seen by the TUI (full record minus internals). */
export interface GuardrailDTO {
  id: string
  fingerprint: string
  tool: string
  state: "open" | "resolved" | "dismissed"
  mode: "inherit" | "warn" | "block"
  count: number
  firstSeen: string
  lastSeen: string
  errorSample: string
  fix?: { input: string; at: string } | undefined
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface MemoryRuntime {
  readonly epoch: number
  /** Current time (tests control it through `deps.now`). */
  now(): Date
  resolveWorkspace(sessionID?: string): Promise<Workspace>
  load(workspace: Workspace): LoadedWorkspace
  commit(loaded: LoadedWorkspace, scope: ChangedScope): void
  writeAudit(loaded: LoadedWorkspace, type: AuditEventType, fields: Record<string, unknown>): void
  /** Build (or reuse) the turn-stable injection block. */
  inject(input: { sessionID: string; messages: readonly unknown[] }): Promise<InjectionResult>
  /** Append/replace the block in a system-parts array; returns true when changed. */
  applyToSystem(sessionID: string, system: Array<{ type?: string; text?: string }>, block: string): boolean
  /** Remove any applied block from the session's tracking (compaction safety). */
  invalidateApplied(sessionID: string): void
  /** Pin an item into this session's next injected block (pre-flight / coaching). */
  pin(sessionID: string, pin: SnapshotPin): void
  /** Drop pins (used on turn change and tests). */
  clearPins(sessionID: string): void
  /** Invalidate the cached block for a session (compaction). */
  invalidateBlock(sessionID: string): void
  /** Request a distillation pass in the next injected block (compaction, opt-in). */
  noteCompaction(sessionID: string): Promise<void>
  /** Failure capture + coaching (`execute.after` → status error). */
  captureFailure(input: { sessionID: string; tool: string; input: unknown; error: unknown }): Promise<CaptureResult>
  /** Pre-flight match (`execute.before`): warn pin or block message. */
  preflight(input: { sessionID: string; tool: string; input: unknown }): Promise<PreflightResult>
  /** Auto-resolve surfaced guardrails fixed by a successful call. */
  autoResolve(input: { sessionID: string; tool: string; input: unknown }): Promise<AutoResolveResult>
  /** Route one `execute.after` outcome (throw or completed call). */
  toolOutcome(input: ToolOutcomeInput): Promise<ToolOutcomeResult>
  statusData(loaded: LoadedWorkspace): StatusData
  configView(loaded: LoadedWorkspace): ConfigView
  setConfigValue(input: {
    scope: "global" | "project"
    key: string
    value: unknown
    sessionID?: string | undefined
  }): Promise<ConfigView>
  setGuardrailMode(input: {
    id: string
    mode: string
    sessionID?: string | undefined
  }): Promise<{ id: string; mode: string; state: string }>
  searchMemory(loaded: LoadedWorkspace, query: string, target?: SearchTarget, limit?: number): SearchHitDTO[]
  auditEvents(loaded: LoadedWorkspace): AuditEvent[]
  auditStats(loaded: LoadedWorkspace): AuditStats
  /** Recent injection log entries, newest first (TUI timeline). */
  injectionLog(loaded: LoadedWorkspace, options?: { sessionID?: string | undefined; limit?: number | undefined }): InjectionLogEntry[]
  /** Effectiveness table + recommendations, filtered by scope (TUI tab). */
  effectivenessData(loaded: LoadedWorkspace, scope?: "all" | "project" | "personality"): EffectivenessData
  /** All guardrail records as client DTOs (TUI guardrail actions). */
  guardrailList(loaded: LoadedWorkspace): GuardrailDTO[]
  labelsFor(loaded: LoadedWorkspace): Map<string, string>
  recommendations(loaded: LoadedWorkspace, stats: AuditStats): string[]
}

const DIRECTORY_TTL_MS = 5 * 60_000

/**
 * Project-specific identifiers for routing validation: the project directory
 * name and its canonical path. Anything matching these belongs in
 * `target=project`, never in personality memory.
 */
export function projectTermsFor(projectRoot: string): string[] {
  return [basename(projectRoot), projectRoot]
}

/**
 * Is this successful call a plausible fix for the guardrail? Core's
 * `canResolveWith` says "same tool, different input"; we add one precision
 * floor on top: the inputs must share a token, so an unrelated `ls` never
 * auto-resolves a recorded `npm test` failure.
 */
function fixCandidate(record: Guardrail, call: CallLike): boolean {
  if (!canResolveWith(record, call)) return false
  const callTokens = tokenSet(normalizeCall(call.tool, call.input).fingerprint)
  const recordTokens = tokenSet(record.fingerprint)
  if (callTokens.size === 0 || recordTokens.size === 0) return true
  return jaccard(callTokens, recordTokens) >= 0.2
}

/** Tools never captured as guardrails: our own surface and the code-mode wrapper. */
function isGuardrailTool(tool: string, ignoreTools: readonly string[]): boolean {
  if (tool === "" || tool === "execute") return false
  if (tool.startsWith("memory_")) return false
  return !ignoreTools.includes(tool)
}

function exitCodeOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const exit = (value as Record<string, unknown>)["exit"]
  return typeof exit === "number" && Number.isFinite(exit) ? exit : undefined
}

/** Flattened text of a tool result's content parts (defensive about shapes). */
function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return ""
  const content = (result as { content?: unknown }).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    const text = (part as { text?: unknown } | undefined)?.text
    if (typeof text === "string") parts.push(text)
  }
  return parts.join("\n")
}

/**
 * A *completed* tool call that actually failed. The shell tool reports a
 * nonzero exit as a normal result (`output.exit` / `metadata.exit`) rather
 * than an error — the dominant failure mode in practice. Returns the failure
 * text to record, or undefined for genuine successes.
 */
export function failureTextFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const record = result as { output?: unknown; metadata?: unknown }
  const outputExit = exitCodeOf(record.output)
  const metadataExit = exitCodeOf(record.metadata)
  const outputStatus =
    record.output && typeof record.output === "object" && !Array.isArray(record.output)
      ? (record.output as Record<string, unknown>)["status"]
      : undefined
  const failed =
    (outputExit !== undefined && outputExit !== 0) ||
    (metadataExit !== undefined && metadataExit !== 0) ||
    outputStatus === "error"
  if (!failed) return undefined
  const text = resultText(result).trim()
  if (text !== "") return text
  const exit = outputExit ?? metadataExit
  return exit !== undefined ? `exit ${exit}` : "command failed"
}

export function createRuntime(deps: RuntimeDeps): MemoryRuntime {
  let epoch = 0
  const sessions = new Map<string, SessionState>()
  const directoryCache = new Map<string, { directory: string; at: number }>()

  const now = (): Date => deps.now?.() ?? new Date()

  function sessionState(sessionID: string): SessionState {
    let state = sessions.get(sessionID)
    if (!state) {
      state = {
        blockSections: [],
        blockTruncations: [],
        blockEpoch: -1,
        pins: [],
        pinsVersion: 0,
        blockPinsVersion: 0,
        pendingDistill: false,
        surfaced: new Map(),
      }
      sessions.set(sessionID, state)
    }
    return state
  }

  function emit(event: "changed" | "injected", data: Record<string, unknown>): void {
    try {
      deps.emit?.(event, data)
    } catch (error) {
      deps.debug?.(`emit ${event} failed: ${String(error)}`)
    }
  }

  async function resolveWorkspace(sessionID?: string): Promise<Workspace> {
    let directory: string | undefined
    const cacheKey = sessionID ?? "<instance>"
    const cached = directoryCache.get(cacheKey)
    if (cached && now().getTime() - cached.at < DIRECTORY_TTL_MS) directory = cached.directory
    if (directory === undefined) {
      try {
        directory = await deps.resolveDirectory(sessionID)
      } catch (error) {
        deps.debug?.(`resolveDirectory(${cacheKey}) failed: ${String(error)}`)
        directory = await deps.resolveDirectory(undefined)
      }
      directoryCache.set(cacheKey, { directory, at: now().getTime() })
    }
    const projectRoot = canonicalProjectRoot(directory)
    return {
      ...(sessionID ? { sessionID } : {}),
      directory,
      projectRoot,
      projectDir: projectMemoryDir(projectRoot),
      globalDir: globalMemoryDir(deps.env ?? {}),
    }
  }

  function filesFor(workspace: Workspace): WorkspaceFiles {
    const personality = personalityPath(workspace.globalDir)
    const project = projectEntriesPath(workspace.projectDir)
    return {
      personality,
      project,
      learnings: learningsPath(workspace.projectDir),
      issues: issuesPath(workspace.projectDir),
      guardrails: guardrailsPath(workspace.projectDir),
      audit: auditPath(workspace.projectDir),
      personalityRecoveryDir: recoveryDirFor(personality),
      projectRecoveryDir: recoveryDirFor(project),
      globalConfig: configPath(workspace.globalDir),
      projectConfig: configPath(workspace.projectDir),
    }
  }

  function load(workspace: Workspace): LoadedWorkspace {
    const files = filesFor(workspace)
    const loadedConfig = loadConfig({
      options: deps.options,
      globalPath: files.globalConfig,
      projectPath: files.projectConfig,
    })
    return {
      ...workspace,
      files,
      config: loadedConfig.config,
      sources: loadedConfig.sources,
      warnings: loadedConfig.warnings,
      personality: readEntries(files.personality, "personality"),
      project: readEntries(files.project, "project"),
      lessons: readLearnings(files.learnings),
      guardrails: readGuardrails(files.guardrails),
      threads: readIssues(files.issues),
    }
  }

  function commit(loaded: Pick<LoadedWorkspace, "projectRoot" | "projectDir">, scope: ChangedScope): void {
    ensureMemoryDir(loaded.projectDir)
    epoch++
    emit("changed", { scope, projectRoot: loaded.projectRoot })
  }

  function writeAudit(loaded: LoadedWorkspace, type: AuditEventType, fields: Record<string, unknown>): void {
    if (!loaded.config.audit.enabled) return
    try {
      ensureMemoryDir(loaded.projectDir)
      const at = now()
      const text = readText(loaded.files.audit)
      const event = createAuditEvent(type, at.toISOString(), {
        ...(loaded.sessionID ? { sessionID: loaded.sessionID } : {}),
        ...fields,
      })
      // Append then prune: the log stays inside `audit.retentionDays`, so
      // parse cost and file size stay bounded for the life of a project.
      const events = pruneEvents(parseEvents(appendEventText(text, event)), {
        retentionDays: loaded.config.audit.retentionDays,
        now: at,
      })
      atomicWrite(loaded.files.audit, serializeEvents(events))
    } catch (error) {
      // Audit must never break a session or a tool call.
      deps.debug?.(`audit write failed: ${String(error)}`)
    }
  }

  async function doInject(input: { sessionID: string; messages: readonly unknown[] }): Promise<InjectionResult> {
    const state = sessionState(input.sessionID)
    const workspace = await resolveWorkspace(input.sessionID)
    const loaded = load(workspace)
    const turnKey = deriveTurnKey(input.messages)
    const configStamp = stableStringify(loaded.config)
    const turnChanged = state.turnKey !== turnKey
    const mustRebuild =
      state.block === undefined ||
      turnChanged ||
      state.blockEpoch !== epoch ||
      state.blockConfigStamp !== configStamp ||
      state.blockPinsVersion !== state.pinsVersion

    if (!mustRebuild) {
      return { ...(state.block ? { block: state.block } : {}), rebuilt: false, ...(state.blockHash ? { hash: state.blockHash } : {}), chars: state.block?.length }
    }

    if (state.turnKey !== undefined && turnChanged) {
      // A genuinely new user turn drops last turn's pins. The very first
      // inject of a session keeps pins recorded before any block existed
      // (pre-flight can fire before the first model call).
      state.pins = []
      state.pinsVersion++
    }

    const turn = turnContextFromMessages(input.messages)
    const corrections = loaded.project.filter((entry) => entry.kind === "correction")
    const jit: JitMatch[] = loaded.config.jit
      ? jitMatches({
          ctx: turn,
          threads: loaded.threads,
          corrections,
          lessons: loaded.lessons,
          guardrails: loaded.guardrails,
        })
      : []
    const snapshot = buildSnapshot({
      config: loaded.config,
      personality: loaded.personality,
      project: loaded.project,
      lessons: loaded.lessons,
      threads: loaded.threads,
      guardrails: loaded.guardrails,
      jit,
      pins: state.pins,
      ...(state.pendingDistill ? { distill: true } : {}),
    })
    // The distillation request rides exactly one built block; later turns
    // go back to normal until the next compaction asks again.
    state.pendingDistill = false

    state.turnKey = turnKey
    state.block = snapshot.block
    state.blockHash = snapshot.hash
    state.blockSections = snapshot.sections
    state.blockTruncations = snapshot.truncations
    state.blockEpoch = epoch
    state.blockConfigStamp = configStamp
    state.blockPinsVersion = state.pinsVersion

    // Remember which guardrails the model has now seen; a later successful
    // call on the same tool can auto-resolve them (enforcement ladder #5).
    // Section refs cover always-injected records, JIT matches and pins alike.
    markSurfaced(
      state,
      snapshot.sections.flatMap((section) => section.refs),
    )

    if (snapshot.block !== "") {
      const why: Record<string, string> = {}
      for (const match of jit) why[match.type === "thread" ? `t:${match.id}` : match.id] = match.reason
      for (const pin of state.pins) why[pin.ref] = pin.reason
      const sections: InjectionAuditSection[] = snapshot.sections
        .slice()
        .sort((a, b) => SECTION_RENDER_ORDER.indexOf(a.name) - SECTION_RENDER_ORDER.indexOf(b.name))
        .map((section) => {
          const sectionWhy: Record<string, string> = {}
          for (const ref of section.refs) {
            const reason = why[ref]
            if (reason !== undefined) sectionWhy[ref] = reason
          }
          return {
            name: section.name,
            chars: section.chars,
            reason: SECTION_REASON[section.name],
            refs: section.refs,
            ...(Object.keys(sectionWhy).length > 0 ? { why: sectionWhy } : {}),
          }
        })
      writeAudit(loaded, "inject", {
        turnKey,
        hash: snapshot.hash,
        chars: snapshot.chars,
        // Flat refs list: the effectiveness stats ("injected N / reoccurred M")
        // key on this, independent of section layout.
        refs: [...new Set(sections.flatMap((section) => section.refs))],
        sections,
        ...(snapshot.truncations.length > 0 ? { truncations: snapshot.truncations } : {}),
      })
      emit("injected", {
        sessionID: input.sessionID,
        turnKey,
        hash: snapshot.hash,
        chars: snapshot.chars,
        sections: snapshot.sections.length,
      })
    }

    return {
      ...(snapshot.block ? { block: snapshot.block } : {}),
      rebuilt: true,
      hash: snapshot.hash,
      chars: snapshot.chars,
    }
  }

  function inject(input: { sessionID: string; messages: readonly unknown[] }): Promise<InjectionResult> {
    const state = sessionState(input.sessionID)
    if (state.inFlight) return state.inFlight
    const promise = doInject(input).finally(() => {
      state.inFlight = undefined
    })
    state.inFlight = promise
    return promise
  }

  function applyToSystem(sessionID: string, system: Array<{ type?: string; text?: string }>, block: string): boolean {
    const state = sessionState(sessionID)
    const previous = state.appliedBlock
    for (const part of system) {
      if (!part || typeof part.text !== "string") continue
      if (part.text === block) {
        state.appliedBlock = block
        return false
      }
      if (previous !== undefined && part.text === previous) {
        part.text = block
        state.appliedBlock = block
        return true
      }
    }
    system.push({ type: "text", text: block })
    state.appliedBlock = block
    return true
  }

  function invalidateApplied(sessionID: string): void {
    const state = sessionState(sessionID)
    state.appliedBlock = undefined
  }

  function pin(sessionID: string, value: SnapshotPin): void {
    const state = sessionState(sessionID)
    state.pins = [...state.pins.filter((existing) => existing.ref !== value.ref), value]
    state.pinsVersion++
  }

  function clearPins(sessionID: string): void {
    const state = sessionState(sessionID)
    if (state.pins.length === 0) return
    state.pins = []
    state.pinsVersion++
  }

  /** Remember guardrail refs shown to the model (bounded, insertion-ordered). */
  function markSurfaced(state: SessionState, refs: readonly string[]): void {
    let touched = false
    const at = now().toISOString()
    for (const ref of refs) {
      if (!ref.startsWith("g:")) continue
      state.surfaced.set(ref.slice(2), at)
      touched = true
    }
    if (!touched) return
    while (state.surfaced.size > SURFACED_LIMIT) {
      const oldest = state.surfaced.keys().next().value
      if (oldest === undefined) break
      state.surfaced.delete(oldest)
    }
  }

  function invalidateBlock(sessionID: string): void {
    const state = sessionState(sessionID)
    state.block = undefined
    state.blockHash = undefined
    state.blockEpoch = -1
  }

  /** After a compaction, ask the next built block to prompt a distillation pass (opt-in). */
  async function noteCompaction(sessionID: string): Promise<void> {
    const loaded = load(await resolveWorkspace(sessionID))
    if (loaded.config.autoDistillOnCompact) sessionState(sessionID).pendingDistill = true
  }

  function configView(loaded: LoadedWorkspace): ConfigView {
    const values: Record<string, unknown> = {}
    for (const path of CONFIG_FIELD_PATHS) values[path] = readFieldValue(loaded.config, path)
    return {
      values,
      sources: { ...loaded.sources },
      warnings: [...loaded.warnings],
      fields: CONFIG_FIELDS.map((field) => ({ path: field.path, type: field.type, description: field.description })),
    }
  }

  async function setConfigValue(input: {
    scope: "global" | "project"
    key: string
    value: unknown
    sessionID?: string | undefined
  }): Promise<ConfigView> {
    if (input.scope !== "global" && input.scope !== "project") {
      throw new MemoryError("invalid_config", `config scope must be "global" or "project"`, { scope: input.scope })
    }
    if (!isConfigFieldPath(input.key)) {
      throw new MemoryError("invalid_config", `unknown config key "${String(input.key)}"`, { key: input.key })
    }
    const problem = validateFieldValue(input.key, input.value)
    if (problem !== null) throw new MemoryError("invalid_config", problem, { key: input.key, value: input.value })

    const workspace = await resolveWorkspace(input.sessionID)
    const files = filesFor(workspace)
    const file = input.scope === "global" ? files.globalConfig : files.projectConfig
    const text = readText(file)
    let raw: Record<string, unknown> = {}
    if (text !== null && text.trim() !== "") {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new MemoryError("invalid_config", `${file} is not valid JSON — fix it before editing via RPC`, { file })
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new MemoryError("invalid_config", `${file} is not a JSON object — fix it before editing via RPC`, { file })
      }
      raw = parsed as Record<string, unknown>
    }
    setRawField(raw, input.key, input.value)
    atomicWrite(file, `${JSON.stringify(raw, null, 2)}\n`)
    commit({ projectRoot: workspace.projectRoot, projectDir: workspace.projectDir }, "config")
    return configView(load(workspace))
  }

  async function setGuardrailMode(input: {
    id: string
    mode: string
    sessionID?: string | undefined
  }): Promise<{ id: string; mode: string; state: string }> {
    if (input.mode !== "inherit" && input.mode !== "warn" && input.mode !== "block") {
      throw new MemoryError("invalid_config", `guardrail mode must be inherit | warn | block`, { mode: input.mode })
    }
    const workspace = await resolveWorkspace(input.sessionID)
    const loaded = load(workspace)
    const result = setGuardrailModeCore(loaded.guardrails, input.id, input.mode as GuardrailModeSetting)
    const capped = capGuardrails(result.records, loaded.config.capture.maxRecords)
    atomicWrite(loaded.files.guardrails, serializeGuardrails(capped))
    commit(loaded, "guardrails")
    return { id: result.record.id, mode: result.record.mode, state: result.record.state }
  }

  // -------------------------------------------------------------------------
  // Guardrail dynamics (enforcement ladder #3–5)
  // -------------------------------------------------------------------------

  function blockMessage(record: Guardrail): string {
    const fix = record.fix ? ` Fix: use \`${record.fix.input}\` instead.` : ""
    const seen = record.count > 1 ? ` (failed ${record.count}×)` : ""
    return `Blocked by memory guardrail #${record.id}${seen}: \`${record.fingerprint}\` — ${record.errorSample}.${fix} If this is wrong, dismiss the guardrail in the /memory panel or run memory_audit.`
  }

  async function captureFailure(input: {
    sessionID: string
    tool: string
    input: unknown
    error: unknown
  }): Promise<CaptureResult> {
    const state = sessionState(input.sessionID)
    const loaded = load(await resolveWorkspace(input.sessionID))
    if (!loaded.config.capture.toolErrors) return { coached: false }
    if (!isGuardrailTool(input.tool, loaded.config.capture.ignoreTools)) return { coached: false }

    // Coaching: does a *resolved* guardrail with a fix match this failing
    // call? Checked before the upsert so the pre-failure state decides.
    const call: CallLike = { tool: input.tool, input: input.input }
    const coachedRecord = loaded.guardrails.find(
      (record) => record.state === "resolved" && record.fix !== undefined && matchGuardrail(record, call).match,
    )

    const signature = signatureFor(input.tool, input.input, input.error)
    const result = upsertGuardrail(loaded.guardrails, { ...signature, sessionID: input.sessionID }, now().toISOString())
    atomicWrite(
      loaded.files.guardrails,
      serializeGuardrails(capGuardrails(result.records, loaded.config.capture.maxRecords)),
    )
    commit(loaded, "guardrails")

    writeAudit(loaded, "fail", {
      guardrail: result.record.id,
      tool: input.tool,
      fingerprint: signature.fingerprint,
      isNew: result.isNew,
      count: result.record.count,
    })
    // A repeat failure of a guardrail the model has already seen is the
    // effectiveness signal the audit tracks ("reoccurred after injection").
    const injectedBefore = auditStats(loaded).entries.some(
      (entry) => entry.ref === `g:${result.record.id}` && entry.injected > 0,
    )
    if (!result.isNew && injectedBefore) {
      writeAudit(loaded, "reoccur", { ref: `g:${result.record.id}`, tool: input.tool })
    }

    if (coachedRecord) {
      pin(input.sessionID, {
        ref: `g:${coachedRecord.id}`,
        text: guardrailLine(coachedRecord),
        reason: `coach:${coachedRecord.id}`,
      })
      markSurfaced(state, [`g:${coachedRecord.id}`])
    }
    return { guardrail: result.record.id, coached: coachedRecord !== undefined }
  }

  async function preflight(input: { sessionID: string; tool: string; input: unknown }): Promise<PreflightResult> {
    const state = sessionState(input.sessionID)
    const loaded = load(await resolveWorkspace(input.sessionID))
    if (!isGuardrailTool(input.tool, loaded.config.capture.ignoreTools)) return { blocked: false }

    const call: CallLike = { tool: input.tool, input: input.input }
    const scored = loaded.guardrails
      .filter((record) => record.state !== "dismissed")
      .map((record) => ({ record, match: matchGuardrail(record, call) }))
      .filter((item) => item.match.match)
      .map((item) => ({
        record: item.record,
        rank:
          (item.match.exact ? 4 : 0) +
          (item.record.state === "resolved" && item.record.fix ? 2 : 0) +
          (item.record.count > 1 ? 1 : 0),
      }))
    if (scored.length === 0) return { blocked: false }

    // Strongest first: exact fingerprint, then resolved-with-fix, then frequent.
    scored.sort(
      (a, b) =>
        b.rank - a.rank ||
        b.record.lastSeen.localeCompare(a.record.lastSeen) ||
        a.record.id.localeCompare(b.record.id),
    )
    const chosen = scored[0]?.record
    if (!chosen) return { blocked: false }

    const mode = chosen.mode !== "inherit" ? chosen.mode : loaded.config.guardrails.mode
    markSurfaced(state, [`g:${chosen.id}`])
    if (mode === "block") {
      writeAudit(loaded, "preflight", { guardrail: chosen.id, tool: input.tool, mode, blocked: true })
      return { blocked: true, guardrail: chosen.id, message: blockMessage(chosen) }
    }
    pin(input.sessionID, { ref: `g:${chosen.id}`, text: guardrailLine(chosen), reason: `preflight:${chosen.id}` })
    writeAudit(loaded, "preflight", { guardrail: chosen.id, tool: input.tool, mode, blocked: false })
    return { blocked: false, guardrail: chosen.id }
  }

  async function autoResolve(input: { sessionID: string; tool: string; input: unknown }): Promise<AutoResolveResult> {
    const state = sessionState(input.sessionID)
    if (state.surfaced.size === 0) return { resolved: [] }
    const loaded = load(await resolveWorkspace(input.sessionID))
    if (!isGuardrailTool(input.tool, loaded.config.capture.ignoreTools)) return { resolved: [] }

    const call: CallLike = { tool: input.tool, input: input.input }
    const candidates = [...state.surfaced.keys()]
      .map((id) => loaded.guardrails.find((record) => record.id === id))
      .filter(
        (record): record is Guardrail =>
          record !== undefined && record.state !== "dismissed" && fixCandidate(record, call),
      )
    if (candidates.length === 0) return { resolved: [] }

    const fixInput = normalizeCall(input.tool, input.input).display
    let records = loaded.guardrails
    const resolved: string[] = []
    for (const record of candidates) {
      try {
        records = resolveGuardrail(records, record.id, { input: fixInput }, now().toISOString()).records
        state.surfaced.delete(record.id)
        resolved.push(record.id)
      } catch (error) {
        deps.debug?.(`auto-resolve skipped ${record.id}: ${String(error)}`)
      }
    }
    if (resolved.length === 0) return { resolved: [] }
    atomicWrite(loaded.files.guardrails, serializeGuardrails(capGuardrails(records, loaded.config.capture.maxRecords)))
    commit(loaded, "guardrails")
    for (const id of resolved) writeAudit(loaded, "resolve", { ref: `g:${id}`, tool: input.tool, fix: fixInput })
    return { resolved }
  }

  /** Route one tool outcome: capture failures (+coaching), auto-resolve successes. */
  async function toolOutcome(input: ToolOutcomeInput): Promise<ToolOutcomeResult> {
    if (input.status === "error") {
      const capture = await captureFailure({
        sessionID: input.sessionID,
        tool: input.tool,
        input: input.input,
        error: input.error,
      })
      return { captured: capture.guardrail !== undefined, coached: capture.coached, resolved: [] }
    }
    const failure = failureTextFromResult(input.result)
    if (failure !== undefined) {
      const capture = await captureFailure({
        sessionID: input.sessionID,
        tool: input.tool,
        input: input.input,
        error: failure,
      })
      return { captured: capture.guardrail !== undefined, coached: capture.coached, resolved: [] }
    }
    const resolved = await autoResolve({ sessionID: input.sessionID, tool: input.tool, input: input.input })
    return { captured: false, coached: false, resolved: resolved.resolved }
  }

  function searchMemory(loaded: LoadedWorkspace, query: string, target: SearchTarget = "project", limit = 5): SearchHitDTO[] {
    const docs: SearchDoc[] = []
    if (target === "personality" || target === "all") {
      loaded.personality.forEach((entry, index) => {
        docs.push({
          name: `personality/${entry.kind}#${index + 1}`,
          text: displayEntry(entry),
          meta: { ref: entryRef("p", displayEntry(entry)) },
        })
      })
    }
    if (target === "project" || target === "all") {
      loaded.project.forEach((entry, index) => {
        docs.push({
          name: `project/${entry.kind}#${index + 1}`,
          text: displayEntry(entry),
          meta: { ref: entryRef("j", displayEntry(entry)) },
        })
      })
      for (const lesson of loaded.lessons) {
        docs.push({
          name: `lesson/${lesson.outcome}: ${lesson.title}`,
          text: `${lesson.title}\n${lesson.content}`,
          meta: { ref: lessonRef(lesson) },
        })
      }
      for (const issue of loaded.threads) {
        docs.push({
          name: `issue/#${issue.id} ${issue.status} — ${issue.title}`,
          text: [issue.title, ...issue.notes.map((note) => note.text)].join("\n"),
          meta: { ref: `t:${issue.id}` },
        })
      }
      for (const guardrail of loaded.guardrails) {
        docs.push({
          name: `guardrail/${guardrail.id}`,
          text: `${guardrail.fingerprint} ${guardrail.errorSample}${guardrail.fix ? ` → ${guardrail.fix.input}` : ""}`,
          meta: { ref: `g:${guardrail.id}` },
        })
      }
    }
    return searchDocs(docs, query, Math.min(Math.max(limit, 1), 10)).map((hit) => ({
      name: hit.name,
      snippet: hit.snippet,
      score: Math.round(hit.score * 100) / 100,
      ref: String(hit.meta?.["ref"] ?? ""),
    }))
  }

  function auditEvents(loaded: LoadedWorkspace): AuditEvent[] {
    return parseEvents(readText(loaded.files.audit))
  }

  function auditStats(loaded: LoadedWorkspace): AuditStats {
    return computeStats(auditEvents(loaded))
  }

  function injectionLog(
    loaded: LoadedWorkspace,
    options: { sessionID?: string | undefined; limit?: number | undefined } = {},
  ): InjectionLogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const entries: InjectionLogEntry[] = []
    for (const event of auditEvents(loaded)) {
      if (event.type !== "inject") continue
      const session = event["sessionID"]
      if (options.sessionID !== undefined && session !== options.sessionID) continue
      const hash = event["hash"]
      const chars = event["chars"]
      const sections = Array.isArray(event["sections"]) ? (event["sections"] as InjectionLogEntry["sections"]) : []
      const refs = Array.isArray(event["refs"]) ? event["refs"].filter((ref): ref is string => typeof ref === "string") : []
      const truncations = Array.isArray(event["truncations"])
        ? event["truncations"].filter((item): item is string => typeof item === "string")
        : undefined
      entries.push({
        ts: event.ts,
        ...(typeof session === "string" ? { sessionID: session } : {}),
        ...(typeof event["turnKey"] === "string" ? { turnKey: event["turnKey"] } : {}),
        hash: typeof hash === "string" ? hash : "?",
        chars: typeof chars === "number" ? chars : 0,
        refs,
        sections,
        ...(truncations !== undefined && truncations.length > 0 ? { truncations } : {}),
      })
    }
    return entries.slice(-limit).reverse()
  }

  function effectivenessData(
    loaded: LoadedWorkspace,
    scope: "all" | "project" | "personality" = "all",
  ): EffectivenessData {
    const stats = auditStats(loaded)
    const labels = labelsFor(loaded)
    const inScope = (ref: string): boolean => {
      if (scope === "all") return true
      if (scope === "personality") return ref.startsWith("p:")
      return !ref.startsWith("p:")
    }
    const entries = stats.entries
      .filter((entry) => inScope(entry.ref))
      .sort((a, b) => b.reoccurred - a.reoccurred || b.injected - a.injected || a.ref.localeCompare(b.ref))
      .map((entry) => {
        const label = labels.get(entry.ref)
        return {
          ref: entry.ref,
          injected: entry.injected,
          reoccurred: entry.reoccurred,
          ...(entry.firstInjectedAt !== undefined ? { firstInjectedAt: entry.firstInjectedAt } : {}),
          ...(entry.lastInjectedAt !== undefined ? { lastInjectedAt: entry.lastInjectedAt } : {}),
          ...(label !== undefined ? { label } : {}),
        }
      })
    return {
      totals: {
        sessions: stats.sessions,
        injections: stats.injections,
        failures: stats.failures,
        resolves: stats.resolves,
        preflights: stats.preflights,
        blocked: stats.blocked,
        searches: stats.searches,
      },
      entries,
      recommendations: recommendations(loaded, stats),
    }
  }

  function labelsFor(loaded: LoadedWorkspace): Map<string, string> {
    const labels = new Map<string, string>()
    for (const entry of loaded.personality) labels.set(entryRef("p", displayEntry(entry)), displayEntry(entry))
    for (const entry of loaded.project) labels.set(entryRef("j", displayEntry(entry)), displayEntry(entry))
    for (const lesson of loaded.lessons) labels.set(lessonRef(lesson), `lesson: ${lesson.title}`)
    for (const issue of loaded.threads) labels.set(`t:${issue.id}`, `#${issue.id} ${issue.title}`)
    for (const guardrail of loaded.guardrails) labels.set(`g:${guardrail.id}`, `\`${guardrail.fingerprint}\``)
    return labels
  }

  function recommendations(loaded: LoadedWorkspace, stats: AuditStats): string[] {
    const corpus = [
      ...loaded.project
        .filter((entry) => entry.kind === "correction")
        .map((entry) => ({ ref: entryRef("j", displayEntry(entry)), label: "correction" })),
      ...loaded.lessons.map((lesson) => ({ ref: lessonRef(lesson), label: "lesson" })),
    ]
    return buildRecommendations(stats, { corpus })
  }

  function statusData(loaded: LoadedWorkspace): StatusData {
    const stats = auditStats(loaded)
    const threadCounts: StatusData["usage"]["threads"] = { open: 0, fixed: 0, verifying: 0, regressed: 0, closed: 0, active: [] }
    for (const issue of loaded.threads) {
      threadCounts[issue.status] = (threadCounts[issue.status] ?? 0) + 1
      if (ACTIVE_ISSUE_STATUSES.includes(issue.status)) threadCounts.active.push(issue.id)
    }
    const guardrailCounts: Record<string, number> = { open: 0, resolved: 0, dismissed: 0 }
    let reoccurring = 0
    for (const guardrail of loaded.guardrails) {
      guardrailCounts[guardrail.state] = (guardrailCounts[guardrail.state] ?? 0) + 1
      if (guardrail.state === "open" && guardrail.count > 1) reoccurring++
    }
    const projectTerms = projectTermsFor(loaded.projectRoot)
    const lint: string[] = []
    for (const item of routingLint(loaded.personality, loaded.project, projectTerms)) {
      lint.push(`${item.scope} #${item.index + 1}: ${item.text} — ${item.suggestion}`)
    }
    return {
      projectRoot: loaded.projectRoot,
      projectDir: loaded.projectDir,
      globalDir: loaded.globalDir,
      ...(loaded.sessionID ? { sessionID: loaded.sessionID } : {}),
      config: configView(loaded),
      usage: {
        personality: { entries: loaded.personality.length, chars: charCount(loaded.personality), cap: loaded.config.personalityCharLimit },
        project: {
          entries: loaded.project.length,
          chars: charCount(loaded.project),
          cap: loaded.config.projectCharLimit,
        },
        lessons: loaded.lessons.length,
        threads: threadCounts,
        guardrails: guardrailCounts,
        reoccurring,
      },
      audit: {
        injections: stats.injections,
        sessions: stats.sessions,
        failures: stats.failures,
        resolves: stats.resolves,
        searches: stats.searches,
      },
      lint: lint.slice(0, 12),
    }
  }

  function guardrailList(loaded: LoadedWorkspace): GuardrailDTO[] {
    return loaded.guardrails.map((record) => ({
      id: record.id,
      fingerprint: record.fingerprint,
      tool: record.tool,
      state: record.state,
      mode: record.mode,
      count: record.count,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      errorSample: record.errorSample,
      ...(record.fix !== undefined ? { fix: { input: record.fix.input, at: record.fix.at } } : {}),
    }))
  }

  return {
    get epoch() {
      return epoch
    },
    now,
    resolveWorkspace,
    load,
    commit,
    writeAudit,
    inject,
    applyToSystem,
    invalidateApplied,
    pin,
    clearPins,
    invalidateBlock,
    noteCompaction,
    captureFailure,
    preflight,
    autoResolve,
    toolOutcome,
    statusData,
    configView,
    setConfigValue,
    setGuardrailMode,
    searchMemory,
    auditEvents,
    auditStats,
    injectionLog,
    effectivenessData,
    guardrailList,
    labelsFor,
    recommendations,
  }
}
