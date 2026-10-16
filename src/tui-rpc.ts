/**
 * TUI-side client for the memory RPC contract.
 *
 * One place that knows how to reach the memory server: the client comes from
 * the TUI context, every call carries the TUI's current location so the RPC
 * lands on the workspace the user is looking at, and the raw typed methods are
 * wrapped into small, purpose-named helpers the sidebar and dashboard share.
 */
import { MemoryRpc } from "./rpc.ts"
import type { Plugin } from "@opencode/plugin/tui"
import type {
  ConfigView,
  EffectivenessData,
  GuardrailDTO,
  InjectionLogEntry,
  SearchHitDTO,
  StatusData,
} from "./runtime.ts"

type TuiContext = Plugin.Context

export interface PingView {
  ok: boolean
  version: string
  directory: string
}
export interface InjectionLog {
  events: InjectionLogEntry[]
}
export interface GuardrailList {
  records: GuardrailDTO[]
}
export interface SearchHits {
  hits: SearchHitDTO[]
}

export type MemoryTuiClient = ReturnType<typeof memoryClient>

/**
 * Build the typed client (`context.client.rpc` is synchronous). The SDK does
 * not statically type JSON-Schema methods, so each call is bound here to the
 * server runtime's own DTO types — one place, no drift.
 */
export function memoryClient(context: TuiContext) {
  const rpc = context.client.rpc(MemoryRpc)
  const options = context.location ? { location: { directory: context.location.directory } } : undefined

  return {
    ping: () => rpc.ping({}, options) as Promise<PingView>,
    status: (sessionID?: string) =>
      rpc.status(sessionID !== undefined ? { sessionID } : {}, options) as Promise<StatusData>,
    configGet: (sessionID?: string) =>
      rpc["config.get"](sessionID !== undefined ? { sessionID } : {}, options) as Promise<ConfigView>,
    configSet: (input: { scope: "global" | "project"; key: string; value: unknown; sessionID?: string }) =>
      rpc["config.set"](input, options) as Promise<ConfigView>,
    guardrailSetMode: (input: { id: string; mode: "inherit" | "warn" | "block"; sessionID?: string }) =>
      rpc["guardrail.setMode"](input, options) as Promise<{ id: string; mode: string; state: string }>,
    search: (input: { query: string; target?: "project" | "personality" | "all"; limit?: number; sessionID?: string }) =>
      rpc.search(input, options) as Promise<SearchHits>,
    injections: (sessionID?: string, limit = 50) =>
      rpc.injections({ ...(sessionID !== undefined ? { sessionID } : {}), limit }, options) as Promise<InjectionLog>,
    guardrails: (sessionID?: string) =>
      rpc.guardrails(sessionID !== undefined ? { sessionID } : {}, options) as Promise<GuardrailList>,
    effectiveness: (sessionID?: string, scope: "all" | "project" | "personality" = "all") =>
      rpc.effectiveness({ ...(sessionID !== undefined ? { sessionID } : {}), scope }, options) as Promise<EffectivenessData>,
    /** Plugin events: `changed` (any mutation) and `injected` (new block). */
    on: rpc.events.on,
  }
}

/** Error → one short line for toasts. */
export function errorLine(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message
  return String(error)
}

/** Render one config value for display in a list. */
export function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.join(", ")
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

/** Render one config value into the prompt editor. */
export function editableValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ")
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

/**
 * Parse editor text back into a typed config value. Mirrors the server's
 * validation lightly; the server re-validates and reports `invalid_config`.
 */
export function parseFieldText(type: string, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (type) {
    case "bool": {
      const lower = text.trim().toLowerCase()
      if (["true", "1", "yes", "y", "on"].includes(lower)) return { ok: true, value: true }
      if (["false", "0", "no", "n", "off"].includes(lower)) return { ok: true, value: false }
      return { ok: false, error: "expected true or false" }
    }
    case "int": {
      const trimmed = text.trim()
      const parsed = Number(trimmed)
      if (trimmed === "" || !Number.isInteger(parsed)) return { ok: false, error: "expected an integer" }
      return { ok: true, value: parsed }
    }
    case "string[]": {
      const parts = text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
      return { ok: true, value: parts }
    }
    default:
      return { ok: true, value: text }
  }
}

// ---------------------------------------------------------------------------
// Sidebar summary — plain language, progressive disclosure
// ---------------------------------------------------------------------------

export type SidebarMode = "compact" | "full" | "off"

/** Sidebar verbosity from config values; unknown/missing falls back to compact. */
export function sidebarMode(values: Record<string, unknown>): SidebarMode {
  const value = values["tui.sidebar"]
  return value === "full" || value === "off" ? value : "compact"
}

/** How many entries were surfaced just-in-time in one injection event. */
export function recalledCount(event: InjectionLogEntry | undefined): number {
  if (event === undefined) return 0
  const relevant = event.sections.find((section) => section.name === "RELEVANT THIS TURN")
  if (relevant === undefined) return 0
  return Object.values(relevant.why ?? {}).filter((reason) => reason.startsWith("jit:")).length
}

/** Total guardrail records across states. */
function guardrailTotal(usage: StatusData["usage"]): number {
  return Object.values(usage.guardrails).reduce((sum, value) => sum + value, 0)
}

/** `2 project · 0 global · 2 lessons · 2 guardrails` — shared by full mode and the status toast. */
export function scopeBreakdown(usage: StatusData["usage"]): string {
  return `${usage.project.entries} project · ${usage.personality.entries} global · ${usage.lessons} lessons · ${guardrailTotal(usage)} guardrails`
}

/** Red attention line when a guardrail failed again after being fixed. */
export function attentionLine(usage: StatusData["usage"]): string | undefined {
  if (usage.reoccurring <= 0) return undefined
  return `${usage.reoccurring} guardrail${usage.reoccurring === 1 ? "" : "s"} failing again`
}

/** Spelled-out totals for the dashboard header. */
export function totalsSummary(totals: EffectivenessData["totals"]): string {
  const count = (n: number, singular: string, plural = `${singular}s`): string => `${n} ${n === 1 ? singular : plural}`
  return `${count(totals.injections, "injection")} · ${count(totals.failures, "failure")} · ${count(totals.resolves, "fix", "fixes")} · ${count(totals.preflights, "preflight check")} (${totals.blocked} blocked)`
}

export interface SidebarSummary {
  /** Muted detail lines under the `memory` label (empty when hidden or stat-free). */
  lines: string[]
  /** Attention line, rendered in the error color with a leading dot. */
  attention: string | undefined
}

/**
 * The user-facing sidebar content. `compact` (default) answers "how much does
 * it know and did it just help?" in one plain sentence; `full` adds the scope
 * breakdown and injection size; `off` hides the widget.
 */
export function sidebarSummary(input: {
  usage: StatusData["usage"]
  lastInjection: InjectionLogEntry | undefined
  mode: SidebarMode
}): SidebarSummary {
  if (input.mode === "off") return { lines: [], attention: undefined }
  const attention = attentionLine(input.usage)

  if (input.mode === "full") {
    const breakdown = `${input.usage.project.entries} project · ${input.usage.personality.entries} global · ${input.usage.lessons} lessons`
    return { lines: [breakdown, guardrailDetail(input.usage, input.lastInjection)], attention }
  }

  const total =
    input.usage.project.entries + input.usage.personality.entries + input.usage.lessons + guardrailTotal(input.usage)
  if (total === 0) return { lines: ["nothing remembered yet"], attention }
  const recalled = recalledCount(input.lastInjection)
  const remembered = `${total} memor${total === 1 ? "y" : "ies"}`
  return { lines: [recalled > 0 ? `${remembered} · ${recalled} recalled just now` : remembered], attention }
}

function guardrailDetail(usage: StatusData["usage"], event: InjectionLogEntry | undefined): string {
  const total = guardrailTotal(usage)
  const label = `${total} guardrail${total === 1 ? "" : "s"}`
  if (event === undefined) return label
  const tokens = Math.max(1, Math.round(event.chars / 4))
  const recalled = recalledCount(event)
  const recalledPart = recalled > 0 ? `${recalled} recalled · ` : ""
  return `${label} · ${recalledPart}added ${tokens} tok`
}
