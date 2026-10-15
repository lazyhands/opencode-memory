import { Plugin } from "@opencode/plugin"
import { MemoryRpc } from "./rpc.ts"
import { installSpike } from "./spike.ts"

export const MEMORY_VERSION = "0.1.0"

/**
 * Memory server plugin.
 *
 * Phase 0: registers the RPC contract and optional diagnostics. The real
 * functionality (stores, injection, tools, hooks) lands in the following phases.
 */
export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    await ctx.rpc.register(MemoryRpc, {
      ping: async () => ({
        ok: true,
        version: MEMORY_VERSION,
        directory: ctx.location.directory,
      }),
    })

    if (ctx.options["spike"] === true) {
      installSpike(ctx)
    }
  },
})
