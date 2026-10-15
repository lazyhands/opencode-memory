/**
 * Phase 0 diagnostics for the memory plugin.
 *
 * Enabled with the plugin option `{ "spike": true }` (see the approved plan,
 * Phase 0). Writes a compact log of hook/tool/RPC behavior so we can verify:
 *   - context hook event shapes (message parts, system parts, tools)
 *   - execute.before throw semantics (does a throw block the tool call?)
 *   - execute.after completed/error shapes
 *
 * Removed after Phase 0 verification lands.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"

const here = dirname(fileURLToPath(import.meta.url))
const SPIKE_LOG = process.env["OPENCODE_MEMORY_SPIKE_LOG"] ?? join(here, "..", ".spike", "spike.log")

function log(line: string): void {
  try {
    mkdirSync(dirname(SPIKE_LOG), { recursive: true })
    appendFileSync(SPIKE_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break a session
  }
}

function summarizeMessage(message: any): unknown {
  const content = Array.isArray(message?.content)
    ? message.content.map((part: any) => {
        const { type, ...rest } = part ?? {}
        return { type, keys: Object.keys(rest), sample: JSON.stringify(rest).slice(0, 400) }
      })
    : typeof message?.content
  return { role: message?.role, content }
}

export function installSpike(ctx: Plugin.Context): void {
  log("setup: memory plugin loaded")

  ctx.tool.transform((tools) => {
    tools.add({
      name: "memory_spike",
      description:
        "Phase 0 diagnostics tool for the opencode-memory plugin. Echoes back the provided token. Set triggerBlock=true to test execute.before throw semantics.",
      input: {
        type: "object",
        properties: {
          token: { type: "string" },
          triggerBlock: { type: "boolean" },
        },
        required: ["token"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        const value = input as { token: string; triggerBlock?: boolean }
        log(`tool.execute token=${value.token} triggerBlock=${value.triggerBlock === true}`)
        return { content: `SPIKE_OK token=${value.token}` }
      },
    })
  })

  ctx.tool.hook("execute.before", (event) => {
    const input = event.input as { triggerBlock?: boolean } | undefined
    log(`tool.execute.before tool=${event.tool} triggerBlock=${input?.triggerBlock === true}`)
    if (event.tool === "memory_spike" && input?.triggerBlock === true) {
      log("tool.execute.before THROWING")
      throw new Error("SPIKE_BLOCKED: deliberate execute.before throw from the memory plugin Phase 0 spike")
    }
  })

  ctx.tool.hook("execute.after", (event) => {
    const shape =
      event.status === "completed"
        ? { status: event.status, result: (event as any).result }
        : { status: event.status, error: (event as any).error }
    log(`tool.execute.after tool=${event.tool} ${JSON.stringify(shape).slice(0, 400)}`)
  })

  const seen = new Set<string>()
  ctx.session.hook("context", async (event) => {
    if (seen.has(event.sessionID)) return
    seen.add(event.sessionID)
    log(
      "context.first " +
        JSON.stringify({
          sessionID: event.sessionID,
          agent: event.agent,
          model: event.model,
          system: (event.system as any[]).map((part) => ({
            type: part?.type,
            textLen: typeof part?.text === "string" ? part.text.length : 0,
          })),
          toolNames: Object.keys(event.tools),
          messages: (event.messages as any[]).slice(-8).map(summarizeMessage),
        }),
    )
  })

  ctx.session.hook("compaction", async () => {
    log("compaction fired")
  })
}
