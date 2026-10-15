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
