/** @jsxImportSource @opentui/solid */
/**
 * Memory TUI plugin: visibility for what memory does.
 *
 * - `sidebar.content`: two-line live counter (personality/project/lessons/
 *   guardrails + the session's last injection size and JIT hits). A red dot
 *   marks unresolved reoccurrences.
 * - `session.panel` via `/memory`: the audit dashboard — injection timeline,
 *   per-entry effectiveness, effective config — with keyboard navigation.
 * - `/memory config [field]`: guided editor that writes through the RPC.
 *
 * The host owns panel layout and input scope; all data comes from the memory
 * server plugin through the shared RPC contract (`rpc.ts`).
 */
import { createEffect, createSignal, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { displayValue, editableValue, errorLine, memoryClient, parseFieldText } from "./tui-rpc.ts"
import type { MemoryTuiClient } from "./tui-rpc.ts"
import { MemoryDashboard } from "./tui-dashboard.tsx"
import type { DashboardData, MemoryTab, SelectedRow } from "./tui-dashboard.tsx"

type StatusView = Awaited<ReturnType<MemoryTuiClient["status"]>>
type InjectionEntry = Awaited<ReturnType<MemoryTuiClient["injections"]>>["events"][number]

interface SideData {
  status: StatusView
  lastInjection: InjectionEntry | undefined
}

/** Fields with a closed value set get a picker instead of a text prompt. */
const ENUM_FIELDS: Record<string, readonly string[]> = {
  "guardrails.mode": ["warn", "block"],
  protocol: ["full", "short", "off"],
}

export default Plugin.define({
  id: "memory.tui",
  setup(context) {
    const client = memoryClient(context)

    // --- shared dashboard state -------------------------------------------
    const [tab, setTab] = createSignal<MemoryTab>("injections")
    const [selection, setSelection] = createSignal(0)
    const [rowCount, setRowCount] = createSignal(0)
    const [selectedRow, setSelectedRow] = createSignal<SelectedRow | undefined>()
    const [rev, setRev] = createSignal(0)
    const [dash, setDash] = createSignal<DashboardData | undefined>()
    const [dashError, setDashError] = createSignal<string | undefined>()
    const [panelSession, setPanelSession] = createSignal<string | undefined>()
    const [panelFocused, setPanelFocused] = createSignal(false)
    let panelClose: (() => void) | undefined
    let panelFullscreen: (() => void) | undefined

    const bump = () => setRev((value) => value + 1)

    // Server events → debounced refresh (injections can fire rapidly).
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        bump()
      }, 150)
    }
    const offChanged = client.on("changed", () => scheduleRefresh())
    const offInjected = client.on("injected", () => scheduleRefresh())

    const currentSession = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const memorySession = (): string | undefined => panelSession() ?? currentSession()

    // --- sidebar ----------------------------------------------------------
    const [side, setSide] = createSignal<SideData | undefined>()
    const [sideError, setSideError] = createSignal<string | undefined>()
    let sideToken = 0
    const loadSide = async (sessionID: string) => {
      const token = ++sideToken
      try {
        const [status, injections] = await Promise.all([client.status(sessionID), client.injections(sessionID, 1)])
        if (token !== sideToken) return
        setSide({ status, lastInjection: injections.events[0] })
        setSideError(undefined)
      } catch (error) {
        if (token !== sideToken) return
        setSideError(errorLine(error))
      }
    }

    const injectionLine = (data: SideData): string => {
      const event = data.lastInjection
      if (event === undefined) return "no injection yet"
      const relevant = event.sections.find((section) => section.name === "RELEVANT THIS TURN")
      const jit =
        relevant !== undefined
          ? Object.values(relevant.why ?? {}).filter((reason) => reason.startsWith("jit:")).length
          : 0
      const tokens = Math.max(1, Math.round(event.chars / 4))
      return `inj ${tokens} tok · jit ${jit}`
    }

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        createEffect(() => {
          const sessionID = input.sessionID
          void rev()
          void loadSide(sessionID)
        })
        const counters = (): string | undefined => {
          const data = side()
          if (data === undefined) return undefined
          const usage = data.status.usage
          const guardrails = Object.values(usage.guardrails).reduce((sum, value) => sum + value, 0)
          return `P${usage.personality.entries} · J${usage.project.entries} · L${usage.lessons} · G${guardrails}`
        }
        const reoccurring = () => side()?.status.usage.reoccurring ?? 0
        const injection = (): string | undefined => {
          const data = side()
          return data !== undefined ? injectionLine(data) : undefined
        }
        return (
          <box flexDirection="column">
            <text fg={context.theme.text.base}>memory</text>
            <Show
              when={counters() !== undefined}
              fallback={
                <text fg={context.theme.text.muted}>{sideError() !== undefined ? "unavailable" : "…"}</text>
              }
            >
              <box flexDirection="column">
                <box flexDirection="row">
                  <text fg={context.theme.text.muted}>{counters() ?? ""}</text>
                  <Show when={reoccurring() > 0}>
                    <text fg={context.theme.text.feedback.error.base}>{` ●${reoccurring()}`}</text>
                  </Show>
                </box>
                <text fg={context.theme.text.muted}>{injection() ?? ""}</text>
              </box>
            </Show>
          </box>
        )
      },
    })

    // --- dashboard data ---------------------------------------------------
    let dashToken = 0
    const loadDash = async (sessionID: string) => {
      const token = ++dashToken
      try {
        const [status, injections, effectiveness, guardrails, config] = await Promise.all([
          client.status(sessionID),
          client.injections(sessionID, 20),
          client.effectiveness(sessionID, "all"),
          client.guardrails(sessionID),
          client.configGet(sessionID),
        ])
        if (token !== dashToken) return
        setDash({ status, injections: injections.events, effectiveness, guardrails: guardrails.records, config })
        setDashError(undefined)
      } catch (error) {
        if (token !== dashToken) return
        setDashError(errorLine(error))
      }
    }

    const handleRows = (count: number) => {
      setRowCount(count)
      setSelection((previous) => Math.min(previous, Math.max(count - 1, 0)))
    }

    // --- panel slot -------------------------------------------------------
    context.ui.slot({
      append: "session.panel",
      render: (input) => {
        createEffect(() => {
          const mine = input.name === "memory"
          setPanelSession(mine ? input.sessionID : undefined)
          setPanelFocused(mine && input.focused)
          if (mine) {
            panelClose = input.close
            panelFullscreen = input.toggleFullscreen
          }
        })
        createEffect(() => {
          const sessionID = panelSession()
          void rev()
          if (sessionID !== undefined) void loadDash(sessionID)
        })
        return (
          <Show when={input.name === "memory"}>
            <MemoryDashboard
              theme={context.theme}
              width={input.width}
              tab={tab}
              selection={selection}
              data={dash}
              error={dashError}
              onRows={handleRows}
              onSelection={(row) => setSelectedRow(row)}
            />
          </Show>
        )
      },
    })

    // --- actions ----------------------------------------------------------
    const openMemory = (which: MemoryTab): boolean => {
      if (context.ui.panel.open("memory", { presentation: "panel" })) {
        setTab(which)
        setSelection(0)
        return true
      }
      context.ui.toast.show({
        message: "Open or focus a session first — the memory panel attaches to a session.",
        variant: "warning",
      })
      return false
    }

    const moveSelection = (delta: number) => {
      const count = rowCount()
      setSelection((previous) => {
        if (count === 0) return 0
        return Math.min(Math.max(previous + delta, 0), count - 1)
      })
    }

    const toggleSelectedGuardrail = async () => {
      const row = selectedRow()
      const sessionID = memorySession()
      if (row?.guardrail === undefined || sessionID === undefined) return
      const next = row.guardrail.mode === "block" ? "inherit" : "block"
      try {
        await client.guardrailSetMode({ id: row.guardrail.id, mode: next, sessionID })
        context.ui.toast.show({ message: `guardrail #${row.guardrail.id} → ${next}`, variant: "success" })
        bump()
      } catch (error) {
        context.ui.toast.show({ message: `guardrail mode: ${errorLine(error)}`, variant: "error" })
      }
    }

    // --- config editor ----------------------------------------------------
    const openConfigEditor = async (sessionID: string | undefined, presetPath?: string) => {
      try {
        const view = await client.configGet(sessionID)
        let path = presetPath
        if (path === undefined) {
          path = await context.ui.dialog.select<string>({
            title: "Memory config",
            placeholder: "Filter by field name…",
            options: view.fields.map((field) => ({
              title: field.path,
              value: field.path,
              description: `${displayValue(view.values[field.path])} — ${field.description}`,
              ...(view.sources[field.path] !== undefined ? { footer: view.sources[field.path] } : {}),
            })),
            search: (query, options) => {
              const needle = query.trim().toLowerCase()
              if (needle === "") return options
              return options.filter(
                (option) =>
                  option.title.toLowerCase().includes(needle) ||
                  (option.description ?? "").toLowerCase().includes(needle),
              )
            },
          })
          if (path === undefined) return
        }

        const field = view.fields.find((candidate) => candidate.path === path)
        if (field === undefined) {
          context.ui.toast.show({ message: `unknown config field ${path}`, variant: "warning" })
          return
        }

        let value: unknown
        const enumValues = ENUM_FIELDS[path]
        if (enumValues !== undefined) {
          value = await context.ui.dialog.select<string>({
            title: field.path,
            options: enumValues.map((option) => ({ title: option, value: option })),
            ...(typeof view.values[path] === "string" ? { current: view.values[path] as string } : {}),
          })
          if (value === undefined) return
        } else {
          const text = await context.ui.dialog.prompt({
            title: field.path,
            description: `${field.description} (${field.type})`,
            value: editableValue(view.values[path]),
          })
          if (text === undefined) return
          const parsed = parseFieldText(field.type, text)
          if (!parsed.ok) {
            context.ui.toast.show({ message: `${field.path}: ${parsed.error}`, variant: "warning" })
            return
          }
          value = parsed.value
        }

        const scope = await context.ui.dialog.select<"global" | "project">({
          title: `${path} = ${displayValue(value)}`,
          placeholder: "Write to…",
          current: "project",
          options: [
            {
              title: "project",
              value: "project",
              description: "shipped with the repo: .opencode/memory/config.json",
            },
            {
              title: "global",
              value: "global",
              description: "this machine: ~/.config/opencode/memory/config.json",
            },
          ],
        })
        if (scope === undefined) return

        await client.configSet({ scope, key: path, value, sessionID })
        context.ui.toast.show({ message: `${path} = ${displayValue(value)} (${scope})`, variant: "success" })
        bump()
      } catch (error) {
        context.ui.toast.show({ message: `memory config: ${errorLine(error)}`, variant: "error" })
      }
    }

    // --- keymap -----------------------------------------------------------
    context.keymap.layer(() => ({
      mode: "global",
      enabled: () => context.ui.panel.current()?.name === "memory" && panelFocused(),
      commands: [
        {
          id: "memory.tab.injections",
          bind: "1",
          run: () => {
            setTab("injections")
            setSelection(0)
          },
        },
        {
          id: "memory.tab.effectiveness",
          bind: "2",
          run: () => {
            setTab("effectiveness")
            setSelection(0)
          },
        },
        {
          id: "memory.tab.config",
          bind: "3",
          run: () => {
            setTab("config")
            setSelection(0)
          },
        },
        { id: "memory.select.down", bind: "down", run: () => moveSelection(1) },
        { id: "memory.select.down.j", bind: "j", run: () => moveSelection(1) },
        { id: "memory.select.up", bind: "up", run: () => moveSelection(-1) },
        { id: "memory.select.up.k", bind: "k", run: () => moveSelection(-1) },
        { id: "memory.refresh", bind: "r", run: () => bump() },
        {
          id: "memory.guardrail.toggle",
          bind: "b",
          run: () => {
            void toggleSelectedGuardrail()
          },
        },
        {
          id: "memory.edit",
          bind: "enter",
          run: () => {
            const row = selectedRow()
            void openConfigEditor(memorySession(), row?.configPath)
          },
        },
        { id: "memory.fullscreen", bind: "f", run: () => panelFullscreen?.() },
        { id: "memory.close", bind: "escape", run: () => panelClose?.() },
      ],
    }))

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "memory.dashboard",
          title: "Memory: dashboard",
          description: "Injection timeline, effectiveness and config in a session panel",
          group: "Memory",
          palette: true,
          suggested: true,
          slash: { name: "memory", aliases: [], arguments: true },
          run: async (raw) => {
            const arg = (raw ?? "")
              .trim()
              .replace(/^\/?memory\b\s*/u, "")
              .trim()
            if (arg === "config" || arg.startsWith("config ")) {
              const path = arg.startsWith("config ") ? arg.slice("config ".length).trim() : undefined
              if (path === undefined) openMemory("config")
              await openConfigEditor(memorySession(), path === "" ? undefined : path)
              return
            }
            if (arg === "audit" || arg === "effectiveness") {
              openMemory("effectiveness")
              return
            }
            if (arg === "injections") {
              openMemory("injections")
              return
            }
            if (arg === "status") {
              try {
                const sessionID = memorySession()
                const status = await client.status(sessionID)
                const usage = status.usage
                const guardrails = Object.values(usage.guardrails).reduce((sum, value) => sum + value, 0)
                context.ui.toast.show({
                  message: `memory · ${status.projectRoot} · P${usage.personality.entries} J${usage.project.entries} L${usage.lessons} G${guardrails}${usage.reoccurring > 0 ? ` ●${usage.reoccurring}` : ""}`,
                  variant: "success",
                })
              } catch (error) {
                context.ui.toast.show({ message: `memory status: ${errorLine(error)}`, variant: "error" })
              }
              return
            }
            openMemory("injections")
          },
        },
        {
          id: "memory.configure",
          title: "Memory: configure",
          description: "Edit one memory config field (guided)",
          group: "Memory",
          palette: true,
          run: async () => {
            await openConfigEditor(memorySession())
          },
        },
      ],
    }))

    return () => {
      offChanged()
      offInjected()
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    }
  },
})
