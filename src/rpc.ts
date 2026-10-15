import { Rpc } from "@opencode/plugin"

/**
 * Shared RPC contract between the memory server plugin and the memory TUI.
 *
 * Pure JSON Schema only — importable by clients (and other plugins) without
 * loading the implementation. The `./rpc` package export publishes it.
 *
 * Every method's output mirrors a `runtime.ts` DTO exactly (the RPC host
 * encodes outputs through these schemas). Fields that may be absent are
 * optional; extra detail is added conservatively.
 */

const emptyInput = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const

/** Instance-scoped calls may name the session so resolution never guesses. */
const sessionInput = {
  type: "object",
  properties: {
    sessionID: { type: "string", description: "Session whose workspace should be used" },
  },
  required: [],
  additionalProperties: false,
} as const

/** Effective config view: flattened values, per-field source, loader warnings. */
const configView = {
  type: "object",
  properties: {
    values: { type: "object", description: "Effective values keyed by dotted config path" },
    sources: { type: "object", description: "Source label per dotted config path" },
    warnings: { type: "array", items: { type: "string" } },
    fields: {
      type: "array",
      description: "Field catalog so clients can build editors",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          type: { type: "string" },
          description: { type: "string" },
        },
        required: ["path", "type", "description"],
      },
    },
  },
  required: ["values", "sources", "warnings", "fields"],
} as const

const usageEntry = {
  type: "object",
  properties: {
    entries: { type: "integer" },
    chars: { type: "integer" },
    cap: { type: "integer" },
  },
  required: ["entries", "chars", "cap"],
} as const

export const MemoryRpc = Rpc.define({
  id: "memory",
  methods: {
    ping: {
      input: emptyInput,
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

    /** Full health snapshot for the instance's workspace. */
    status: {
      input: sessionInput,
      output: {
        type: "object",
        properties: {
          projectRoot: { type: "string" },
          projectDir: { type: "string" },
          globalDir: { type: "string" },
          sessionID: { type: "string" },
          config: configView,
          usage: {
            type: "object",
            properties: {
              personality: usageEntry,
              project: usageEntry,
              lessons: { type: "integer" },
              threads: {
                type: "object",
                properties: {
                  open: { type: "integer" },
                  fixed: { type: "integer" },
                  verifying: { type: "integer" },
                  regressed: { type: "integer" },
                  closed: { type: "integer" },
                  active: { type: "array", items: { type: "string" } },
                },
                required: ["open", "fixed", "verifying", "regressed", "closed", "active"],
              },
              guardrails: { type: "object" },
              reoccurring: { type: "integer" },
            },
            required: ["personality", "project", "lessons", "threads", "guardrails", "reoccurring"],
          },
          audit: {
            type: "object",
            properties: {
              injections: { type: "integer" },
              sessions: { type: "integer" },
              failures: { type: "integer" },
              resolves: { type: "integer" },
              searches: { type: "integer" },
            },
            required: ["injections", "sessions", "failures", "resolves", "searches"],
          },
          lint: { type: "array", items: { type: "string" } },
        },
        required: ["projectRoot", "projectDir", "globalDir", "config", "usage", "audit", "lint"],
      },
    },

    /** Effective config (values + sources + warnings). */
    "config.get": {
      input: sessionInput,
      output: configView,
    },

    /** Validate + persist one config leaf, then return the new effective view. */
    "config.set": {
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "project"] },
          key: { type: "string", description: "Dotted config path, e.g. guardrails.mode" },
          value: { description: "New value (validated server-side against the field)" },
          sessionID: { type: "string", description: "Session whose workspace should be used" },
        },
        required: ["scope", "key", "value"],
        additionalProperties: false,
      },
      output: configView,
      errors: {
        invalid_config: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    },

    /** Per-guardrail enforcement mode (inherit uses the global config mode). */
    "guardrail.setMode": {
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Guardrail id like g3 or #g3" },
          mode: { type: "string", enum: ["inherit", "warn", "block"] },
          sessionID: { type: "string", description: "Session whose workspace should be used" },
        },
        required: ["id", "mode"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          mode: { type: "string" },
          state: { type: "string" },
        },
        required: ["id", "mode", "state"],
        additionalProperties: false,
      },
      errors: {
        not_found: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        invalid_config: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    },

    /** Keyword recall across the stores (same engine as the memory_search tool). */
    search: {
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          target: { type: "string", enum: ["project", "personality", "all"] },
          limit: { type: "integer" },
          sessionID: { type: "string", description: "Session whose workspace should be used" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          hits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                snippet: { type: "string" },
                score: { type: "number" },
                ref: { type: "string" },
              },
              required: ["name", "snippet", "score", "ref"],
              additionalProperties: false,
            },
          },
        },
        required: ["hits"],
      },
    },

    /** All guardrail records (dashboard actions: toggle mode, inspect fixes). */
    guardrails: {
      input: sessionInput,
      output: {
        type: "object",
        properties: {
          records: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                fingerprint: { type: "string" },
                tool: { type: "string" },
                state: { type: "string" },
                mode: { type: "string" },
                count: { type: "integer" },
                firstSeen: { type: "string" },
                lastSeen: { type: "string" },
                errorSample: { type: "string" },
                fix: {
                  type: "object",
                  properties: {
                    input: { type: "string" },
                    at: { type: "string" },
                  },
                  required: ["input", "at"],
                },
              },
              required: ["id", "fingerprint", "tool", "state", "mode", "count", "firstSeen", "lastSeen", "errorSample"],
            },
          },
        },
        required: ["records"],
      },
    },

    /** Injection timeline (newest first) for the TUI dashboard. */
    injections: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          limit: { type: "integer" },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ts: { type: "string" },
                sessionID: { type: "string" },
                turnKey: { type: "string" },
                hash: { type: "string" },
                chars: { type: "integer" },
                refs: { type: "array", items: { type: "string" } },
                sections: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      chars: { type: "integer" },
                      reason: { type: "string" },
                      refs: { type: "array", items: { type: "string" } },
                      why: { type: "object" },
                    },
                    required: ["name", "chars", "reason", "refs"],
                  },
                },
                truncations: { type: "array", items: { type: "string" } },
              },
              required: ["ts", "hash", "chars", "refs", "sections"],
            },
          },
        },
        required: ["events"],
      },
    },

    /** Per-entry effectiveness + recommendations for the TUI dashboard. */
    effectiveness: {
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "project", "personality"] },
          sessionID: { type: "string", description: "Session whose workspace should be used" },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          totals: {
            type: "object",
            properties: {
              sessions: { type: "integer" },
              injections: { type: "integer" },
              failures: { type: "integer" },
              resolves: { type: "integer" },
              preflights: { type: "integer" },
              blocked: { type: "integer" },
              searches: { type: "integer" },
            },
            required: ["sessions", "injections", "failures", "resolves", "preflights", "blocked", "searches"],
          },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
                injected: { type: "integer" },
                reoccurred: { type: "integer" },
                firstInjectedAt: { type: "string" },
                lastInjectedAt: { type: "string" },
                label: { type: "string" },
              },
              required: ["ref", "injected", "reoccurred"],
            },
          },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["totals", "entries", "recommendations"],
      },
    },
  },

  events: {
    /** Emitted after every mutation (settle-on-write). */
    changed: {
      schema: {
        type: "object",
        properties: {
          scope: { type: "string" },
          projectRoot: { type: "string" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    },
    /** Emitted when a new turn-stable injection block is built and logged. */
    injected: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          turnKey: { type: "string" },
          hash: { type: "string" },
          chars: { type: "integer" },
          sections: { type: "integer" },
        },
        required: ["sessionID", "hash", "chars"],
        additionalProperties: false,
      },
    },
  },
})
