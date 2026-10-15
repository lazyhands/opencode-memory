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
import { appendEventText, buildRecommendations, computeStats, contentId, createAuditEvent, entryRef, parseEvents } from "./core/audit.ts"
import type { AuditEvent, AuditEventType, AuditStats } from "./core/audit.ts"
import {
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
  serializeGuardrails,
  setGuardrailMode as setGuardrailModeCore,
} from "./core/learnings.ts"
import type { Guardrail, GuardrailModeSetting, Issue, Learning } from "./core/learnings.ts"
import {
  atomicWrite,
  auditPath,
  canonicalProjectRoot,
  configPath,
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
import { buildSnapshot, SECTION_RENDER_ORDER } from "./core/snapshot.ts"
import type { SectionName, SnapshotPin, SnapshotSectionInfo } from "./core/snapshot.ts"
import { stableStringify } from "./core/signature.ts"
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
  "MEMORY PROTOCOL": "always",
}

export interface InjectionResult {
  /** The block to append to system parts (undefined when there is nothing to inject). */
  block?: string | undefined
  rebuilt: boolean
  hash?: string | undefined
  chars?: number | undefined
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

export type SearchTarget = "project" | "personality" | "all"

export interface ConfigView {
  values: Record<string, unknown>
  sources: Record<string, string>
  warnings: string[]
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
  statusData(loaded: LoadedWorkspace): StatusData
  configView(loaded: LoadedWorkspace): ConfigView
  setConfigValue(input: { scope: "global" | "project"; key: string; value: unknown }): Promise<ConfigView>
  setGuardrailMode(input: { id: string; mode: string }): Promise<{ id: string; mode: string; state: string }>
  searchMemory(loaded: LoadedWorkspace, query: string, target?: SearchTarget, limit?: number): SearchHitDTO[]
  auditEvents(loaded: LoadedWorkspace): AuditEvent[]
  auditStats(loaded: LoadedWorkspace): AuditStats
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

  function commit(loaded: LoadedWorkspace, scope: ChangedScope): void {
    epoch++
    emit("changed", { scope, projectRoot: loaded.projectRoot })
  }

  function writeAudit(loaded: LoadedWorkspace, type: AuditEventType, fields: Record<string, unknown>): void {
    if (!loaded.config.audit.enabled) return
    try {
      const event = createAuditEvent(type, now().toISOString(), {
        ...(loaded.sessionID ? { sessionID: loaded.sessionID } : {}),
        ...fields,
      })
      atomicWrite(loaded.files.audit, appendEventText(readText(loaded.files.audit), event))
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

    if (turnChanged) {
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
    })

    state.turnKey = turnKey
    state.block = snapshot.block
    state.blockHash = snapshot.hash
    state.blockSections = snapshot.sections
    state.blockTruncations = snapshot.truncations
    state.blockEpoch = epoch
    state.blockConfigStamp = configStamp
    state.blockPinsVersion = state.pinsVersion

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

  function invalidateBlock(sessionID: string): void {
    const state = sessionState(sessionID)
    state.block = undefined
    state.blockHash = undefined
    state.blockEpoch = -1
  }

  function configView(loaded: LoadedWorkspace): ConfigView {
    const values: Record<string, unknown> = {}
    for (const path of CONFIG_FIELD_PATHS) values[path] = readFieldValue(loaded.config, path)
    return {
      values,
      sources: { ...loaded.sources },
      warnings: [...loaded.warnings],
    }
  }

  async function setConfigValue(input: { scope: "global" | "project"; key: string; value: unknown }): Promise<ConfigView> {
    if (input.scope !== "global" && input.scope !== "project") {
      throw new MemoryError("invalid_config", `config scope must be "global" or "project"`, { scope: input.scope })
    }
    if (!isConfigFieldPath(input.key)) {
      throw new MemoryError("invalid_config", `unknown config key "${String(input.key)}"`, { key: input.key })
    }
    const problem = validateFieldValue(input.key, input.value)
    if (problem !== null) throw new MemoryError("invalid_config", problem, { key: input.key, value: input.value })

    const workspace = await resolveWorkspace(undefined)
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
    epoch++
    emit("changed", { scope: "config", projectRoot: workspace.projectRoot })
    return configView(load(workspace))
  }

  async function setGuardrailMode(input: { id: string; mode: string }): Promise<{ id: string; mode: string; state: string }> {
    if (input.mode !== "inherit" && input.mode !== "warn" && input.mode !== "block") {
      throw new MemoryError("invalid_config", `guardrail mode must be inherit | warn | block`, { mode: input.mode })
    }
    const workspace = await resolveWorkspace(undefined)
    const loaded = load(workspace)
    const result = setGuardrailModeCore(loaded.guardrails, input.id, input.mode as GuardrailModeSetting)
    const capped = capGuardrails(result.records, loaded.config.capture.maxRecords)
    atomicWrite(loaded.files.guardrails, serializeGuardrails(capped))
    commit(loaded, "guardrails")
    return { id: result.record.id, mode: result.record.mode, state: result.record.state }
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
    for (const guardrail of loaded.guardrails) {
      guardrailCounts[guardrail.state] = (guardrailCounts[guardrail.state] ?? 0) + 1
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
    statusData,
    configView,
    setConfigValue,
    setGuardrailMode,
    searchMemory,
    auditEvents,
    auditStats,
    labelsFor,
    recommendations,
  }
}
