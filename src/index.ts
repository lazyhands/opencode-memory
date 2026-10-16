/**
 * Memory server plugin entry.
 *
 * Thin wiring only (ARC-01): the runtime (`runtime.ts`) owns state and
 * resolution, the tools (`tools.ts`) own model-facing behaviour, the RPC
 * contract (`rpc.ts`) is shared with the TUI. This file connects them to the
 * OpenCode plugin surface:
 *
 *   - `session.hook("context")`  → turn-stable MEMORY block + JIT relevance
 *   - `session.hook("compaction")` → invalidate the cached block, request distillation
 *   - `tool.transform`            → the nine `memory_*` tools
 *   - `rpc.register`              → status / config / guardrail / search
 */
import { Plugin } from "@opencode/plugin"
import { MemoryRpc } from "./rpc.ts"
import { createRuntime } from "./runtime.ts"
import { memoryTools } from "./tools.ts"
import { isMemoryError } from "./core/errors.ts"

export const MEMORY_VERSION = "0.2.3"

const DEBUG =
  process.env["OPENCODE_MEMORY_DEBUG"] === "1" || process.env["OPENCODE_MEMORY_DEBUG"] === "true"

function debugLog(message: string): void {
  if (!DEBUG) return
  try {
    console.error(`[memory] ${message}`)
  } catch {
    // diagnostics must never break a session
  }
}

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

function sessionIDOf(data: Record<string, unknown>): string | undefined {
  const value = data["sessionID"]
  return typeof value === "string" && value !== "" ? value : undefined
}

export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    const location = ctx.location as
      | { directory?: string; project?: { canonical?: string } }
      | undefined

    /**
     * Session → working directory. `session.get` is authoritative (sessions
     * can live anywhere); the plugin instance's location is the fallback for
     * instance-scoped RPC calls.
     */
    const resolveDirectory = async (sessionID?: string): Promise<string> => {
      if (sessionID) {
        try {
          const info = (await ctx.session.get({ sessionID })) as
            | { location?: { directory?: unknown } }
            | null
            | undefined
          const directory = info?.location?.directory
          if (typeof directory === "string" && directory !== "") return directory
        } catch (error) {
          debugLog(`session.get(${sessionID}) failed: ${String(error)}`)
        }
      }
      const canonical = location?.project?.canonical
      if (typeof canonical === "string" && canonical !== "") return canonical
      if (typeof location?.directory === "string" && location.directory !== "") return location.directory
      return process.cwd()
    }

    let emitRpc: ((name: string, data: Record<string, unknown>) => void) | undefined

    const runtime = createRuntime({
      options: ctx.options as Record<string, unknown> | undefined,
      resolveDirectory,
      debug: debugLog,
      emit: (event, data) => {
        emitRpc?.(event, data)
      },
    })

    // -----------------------------------------------------------------------
    // RPC surface (shared with the TUI)
    // -----------------------------------------------------------------------
    const rpc = await ctx.rpc.register(MemoryRpc, {
      ping: async () => ({
        ok: true,
        version: MEMORY_VERSION,
        directory: location?.directory ?? "",
      }),

      status: async (input) => {
        const sessionID = sessionIDOf(asObject(input))
        return runtime.statusData(runtime.load(await runtime.resolveWorkspace(sessionID)))
      },

      "config.get": async (input) => {
        const sessionID = sessionIDOf(asObject(input))
        return runtime.configView(runtime.load(await runtime.resolveWorkspace(sessionID)))
      },

      "config.set": async (input, context) => {
        try {
          const data = asObject(input)
          return await runtime.setConfigValue({
            // Unknown scopes pass through so setConfigValue can reject them.
            scope: String(data["scope"] ?? "") as "global" | "project",
            key: typeof data["key"] === "string" ? data["key"] : String(data["key"] ?? ""),
            value: data["value"],
            sessionID: sessionIDOf(data),
          })
        } catch (error) {
          if (isMemoryError(error) && error.code === "invalid_config") {
            return context.error("invalid_config", error.message, { message: error.message })
          }
          throw error
        }
      },

      "guardrail.setMode": async (input, context) => {
        try {
          const data = asObject(input)
          return await runtime.setGuardrailMode({
            id: typeof data["id"] === "string" ? data["id"] : String(data["id"] ?? ""),
            mode: typeof data["mode"] === "string" ? data["mode"] : String(data["mode"] ?? ""),
            sessionID: sessionIDOf(data),
          })
        } catch (error) {
          if (isMemoryError(error)) {
            if (error.code === "not_found") return context.error("not_found", error.message, { message: error.message })
            if (error.code === "invalid_config") {
              return context.error("invalid_config", error.message, { message: error.message })
            }
          }
          throw error
        }
      },

      search: async (input) => {
        const data = asObject(input)
        const query = typeof data["query"] === "string" ? data["query"] : ""
        const rawTarget = data["target"]
        const target = rawTarget === "personality" || rawTarget === "all" ? rawTarget : "project"
        const rawLimit = data["limit"]
        const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : 5
        const loaded = runtime.load(await runtime.resolveWorkspace(sessionIDOf(data)))
        return { hits: runtime.searchMemory(loaded, query, target, limit) }
      },

      injections: async (input) => {
        const data = asObject(input)
        const sessionID = sessionIDOf(data)
        const rawLimit = data["limit"]
        const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : 50
        const loaded = runtime.load(await runtime.resolveWorkspace(sessionID))
        return { events: runtime.injectionLog(loaded, { sessionID, limit }) }
      },

      guardrails: async (input) => {
        const loaded = runtime.load(await runtime.resolveWorkspace(sessionIDOf(asObject(input))))
        return { records: runtime.guardrailList(loaded) }
      },

      effectiveness: async (input) => {
        const data = asObject(input)
        const rawScope = data["scope"]
        const scope = rawScope === "project" || rawScope === "personality" ? rawScope : "all"
        const loaded = runtime.load(await runtime.resolveWorkspace(sessionIDOf(data)))
        return runtime.effectivenessData(loaded, scope)
      },
    })

    emitRpc = (name, data) => {
      try {
        const emit = rpc.events.emit as unknown as (
          event: string,
          payload: Record<string, unknown>,
        ) => Promise<void>
        void emit(name, data).catch((error: unknown) => debugLog(`emit ${name} failed: ${String(error)}`))
      } catch (error) {
        debugLog(`emit ${name} failed: ${String(error)}`)
      }
    }

    // -----------------------------------------------------------------------
    // Tools
    // -----------------------------------------------------------------------
    await ctx.tool.transform((editor) => {
      for (const tool of memoryTools(runtime)) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input as never,
          execute: async (input: unknown, context: { sessionID: string }) => {
            const result = await tool.execute(input, { sessionID: context.sessionID })
            return {
              content: result.content,
              ...(result.metadata ? { metadata: result.metadata } : {}),
            }
          },
        } as never)
      }
    })

    // -----------------------------------------------------------------------
    // Hooks
    // -----------------------------------------------------------------------

    // Turn-stable injection: one byte-stable MEMORY block per user turn,
    // with just-in-time relevance for the current turn's text/paths/commands.
    await ctx.session.hook("context", async (event) => {
      try {
        const result = await runtime.inject({
          sessionID: event.sessionID,
          messages: event.messages as unknown as readonly unknown[],
        })
        if (!result.block) return
        const system = event.system as unknown as Array<{ type?: string; text?: string }>
        runtime.applyToSystem(event.sessionID, system, result.block)
      } catch (error) {
        debugLog(`context hook failed: ${String(error)}`)
      }
    })

    // Compaction rewrites the message history; force a rebuild for the next
    // model call so nothing stale or lost survives the compaction.
    await ctx.session.hook("compaction", async (event) => {
      try {
        runtime.invalidateBlock(event.sessionID)
        runtime.invalidateApplied(event.sessionID)
        await runtime.noteCompaction(event.sessionID)
      } catch (error) {
        debugLog(`compaction hook failed: ${String(error)}`)
      }
    })

    // -----------------------------------------------------------------------
    // Guardrail dynamics (enforcement ladder #3–5)
    // -----------------------------------------------------------------------

    // Pre-flight: match planned calls against recorded failure guardrails.
    // warn (default) pins the fix into the next model call without touching
    // this one; block (opt-in) aborts the call with the recorded fix —
    // rejecting in `execute.before` fails that call alone, not the session.
    await ctx.tool.hook("execute.before", async (event) => {
      let result: Awaited<ReturnType<typeof runtime.preflight>>
      try {
        result = await runtime.preflight({ sessionID: event.sessionID, tool: event.tool, input: event.input })
      } catch (error) {
        debugLog(`preflight failed: ${String(error)}`)
        return
      }
      if (result.blocked && result.message) throw new Error(result.message)
    })

    // After every call: capture failures (+ coaching) or auto-resolve fixes.
    // Nonzero exits arrive as *completed* results with exit metadata — the
    // runtime routes both shapes through `toolOutcome`.
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        await runtime.toolOutcome(
          event.status === "error"
            ? { sessionID: event.sessionID, tool: event.tool, input: event.input, status: "error", error: event.error }
            : { sessionID: event.sessionID, tool: event.tool, input: event.input, status: "completed", result: event.result },
        )
      } catch (error) {
        debugLog(`execute.after failed: ${String(error)}`)
      }
    })
  },
})
