import { Plugin } from "@opencode/plugin/tui"
import { MemoryRpc } from "./rpc.ts"

/**
 * Memory TUI plugin.
 *
 * Phase 0: a sidebar marker and a `/memory` command that round-trips the RPC
 * contract, proving server↔TUI communication. The audit dashboard and config
 * editor land in Phase 5.
 */
export default Plugin.define({
  id: "memory.tui",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column">
          <text>memory: phase 0</text>
        </box>
      ),
    })

    context.keymap.layer(() => ({
      commands: [
        {
          id: "memory.status",
          title: "Memory status",
          group: "Memory",
          palette: true,
          slash: { name: "memory" },
          run: async () => {
            try {
              const rpc = await context.client.rpc(MemoryRpc)
              const result = (await rpc.ping({})) as { ok: boolean; version: string; directory: string }
              context.ui.toast.show({
                message: `memory ${result.version} · ${result.directory}`,
                variant: "success",
              })
            } catch (error) {
              context.ui.toast.show({
                message: `memory RPC failed: ${String(error)}`,
                variant: "error",
              })
            }
          },
        },
      ],
    }))
  },
})
