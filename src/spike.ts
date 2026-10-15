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
import { tmpdir, homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin"

const SPIKE_LOG = process.env["OPENCODE_MEMORY_SPIKE_LOG"] ?? join(tmpdir(), "opencode-memory-spike.log")

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

/**
 * Phase 0 probe: what does the runtime session domain actually expose? The
 * typed surface (SessionDomain) omits `list`/`children`, but the runtime object
 * may be wider. Read-only calls only.
 */
async function probeSessionDomain(ctx: Plugin.Context, sessionID: string): Promise<void> {
  const session = ctx.session as unknown as Record<string, any>
  const methods = ["list", "children", "get", "remove", "create", "update", "hook"]
  log("probe: session methods " + methods.map((name) => `${name}=${typeof session[name]}`).join(" "))

  try {
    const info = await session["get"]?.({ sessionID })
    log("probe: session.get ok " + JSON.stringify({ id: info?.id, keys: info && Object.keys(info).slice(0, 12) }).slice(0, 300))
  } catch (error) {
    log("probe: session.get failed " + String(error).slice(0, 300))
  }
}

/** Phase 0 probe: plugin storage + direct sqlite read (session-manager needs an enumeration path). */
async function probeStorageAndDb(ctx: Plugin.Context, sessionID: string): Promise<void> {
  try {
    const res: any = await ctx.storage.scan({ prefix: "", limit: 10 })
    log(
      "probe: storage.scan ok " +
        JSON.stringify({ entries: res?.entries?.length, next: res?.next, sample: res?.entries?.slice(0, 3) }).slice(0, 400),
    )
  } catch (error) {
    log("probe: storage.scan failed " + String(error).slice(0, 300))
  }

  const specifier = "bun:sqlite"
  try {
    const mod: any = await import(specifier)
    const db = new mod.Database(join(homedir(), ".local", "share", "opencode", "opencode.db"), { readonly: true })
    const count = db.query("SELECT COUNT(*) AS n FROM session").get()
    const kids = db.query("SELECT id, title, parent_id, time_created, time_updated FROM session WHERE parent_id = ? LIMIT 5").all(sessionID)
    db.close()
    log("probe: sqlite ok " + JSON.stringify({ count, kids }).slice(0, 500))
  } catch (error) {
    log("probe: sqlite failed " + String(error).slice(0, 300))
  }
}

/** Phase 0 probe: can the plugin observe the server event stream? */
function probeEvents(ctx: Plugin.Context): void {
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe()) {
        log("probe: event " + JSON.stringify({ type: (event as any)?.type, keys: event && Object.keys(event) }).slice(0, 300))
        break
      }
    } catch (error) {
      log("probe: event subscribe failed " + String(error).slice(0, 300))
    }
  })()
}

export function installSpike(ctx: Plugin.Context): void {
  log("setup: memory plugin loaded")
  log("probe: ctxKeys=" + Object.keys(ctx).sort().join(",") + " sessionKeys=" + Object.keys(ctx.session).sort().join(","))
  probeEvents(ctx)

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
    await probeSessionDomain(ctx, event.sessionID)
    await probeStorageAndDb(ctx, event.sessionID)
  })

  ctx.session.hook("compaction", async () => {
    log("compaction fired")
  })
}
