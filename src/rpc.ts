import { Rpc } from "@opencode/plugin"

/**
 * Shared RPC contract between the memory server plugin and the memory TUI plugin.
 *
 * Pure JSON Schema only — importable by clients (and other plugins) without
 * loading the implementation. The `./rpc` package export publishes this contract.
 */
export const MemoryRpc = Rpc.define({
  id: "memory",
  methods: {
    ping: {
      input: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          version: { type: "string" },
          directory: { type: "string" },
        },
        required: ["ok", "version", "directory"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          scope: { type: "string" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    },
  },
})
