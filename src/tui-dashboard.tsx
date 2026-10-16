/** @jsxImportSource @opentui/solid */
/**
 * Memory audit dashboard — rendered into the `session.panel` slot when the
 * user opens `/memory`. Pure presentation: data loading, key handling and
 * actions live in `tui.tsx`; this file renders the three tabs and reports the
 * selected row back so the keymap can act on it.
 */
import { createEffect, createMemo, For, Show } from "solid-js"
import type { Accessor } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { displayValue, sourceKind, totalsSummary } from "./tui-rpc.ts"
import type { MemoryTuiClient } from "./tui-rpc.ts"

export type MemoryTab = "injections" | "effectiveness" | "config"

/** What the dashboard was loaded with (one refresh fills all tabs). */
export interface DashboardData {
  status: Awaited<ReturnType<MemoryTuiClient["status"]>>
  injections: Awaited<ReturnType<MemoryTuiClient["injections"]>>["events"]
  effectiveness: Awaited<ReturnType<MemoryTuiClient["effectiveness"]>>
  guardrails: Awaited<ReturnType<MemoryTuiClient["guardrails"]>>["records"]
  config: Awaited<ReturnType<MemoryTuiClient["configGet"]>>
}

/** The selected row, in the shape the keymap can act on. */
export interface SelectedRow {
  guardrail?: { id: string; mode: string }
  configPath?: string
}

interface Row {
  text: string
  detail?: string
  select?: SelectedRow
}

export interface DashboardProps {
  theme: Plugin.Context["theme"]
  width: number
  tab: Accessor<MemoryTab>
  selection: Accessor<number>
  data: Accessor<DashboardData | undefined>
  error: Accessor<string | undefined>
  onRows: (count: number) => void
  onSelection: (row: SelectedRow | undefined) => void
}

function clip(text: string, width: number): string {
  const limit = Math.max(width, 12)
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function injectionRows(data: DashboardData): Row[] {
  return data.injections.map((event) => {
    const names = event.sections.map((section) => section.name).join(", ")
    const reasons = [
      ...new Set(event.sections.flatMap((section) => Object.values(section.why ?? {}))),
    ].slice(0, 4)
    return {
      text: `${event.ts.slice(11, 19)} · ${event.hash} · ${event.chars} ch · ${event.refs.length} ref(s)`,
      ...(names !== "" ? { detail: `${names}${reasons.length > 0 ? ` — ${reasons.join(" · ")}` : ""}` } : {}),
    }
  })
}

function effectivenessRows(data: DashboardData): Row[] {
  const byId = new Map(data.guardrails.map((record) => [`g:${record.id}`, record]))
  return data.effectiveness.entries.map((entry) => {
    const record = byId.get(entry.ref)
    const parts = [entry.ref]
    if (record !== undefined && record.mode !== "inherit") parts.push(`[${record.mode}]`)
    if (entry.label !== undefined && entry.label !== "") parts.push(entry.label)
    parts.push(`injected ${entry.injected}×`)
    if (entry.reoccurred > 0) parts.push(`reoccurred ${entry.reoccurred}×`)
    if (record !== undefined) parts.push(record.state)
    const detail =
      record !== undefined
        ? `${record.fingerprint} → ${record.fix?.input ?? "no fix yet"}`
        : "matched or injected entry (no guardrail record)"
    return {
      text: parts.join(" · "),
      detail,
      ...(record !== undefined ? { select: { guardrail: { id: record.id, mode: record.mode } } } : {}),
    }
  })
}

function configRows(data: DashboardData): Row[] {
  const { fields, values, sources } = data.config
  return fields.map((field) => {
    const kind = sourceKind(sources[field.path])
    return {
      text: `${field.path} = ${displayValue(values[field.path])}`,
      detail: `${field.description}${kind !== undefined ? ` · source: ${kind}` : ""}`,
      select: { configPath: field.path },
    }
  })
}

export function MemoryDashboard(props: DashboardProps) {
  const rows = createMemo<Row[]>(() => {
    const data = props.data()
    if (data === undefined) return []
    switch (props.tab()) {
      case "injections":
        return injectionRows(data)
      case "effectiveness":
        return effectivenessRows(data)
      case "config":
        return configRows(data)
    }
  })

  const width = () => (props.width > 24 ? props.width - 3 : 77)
  const selected = () => Math.min(props.selection(), Math.max(rows().length - 1, 0))

  const projectRoot = createMemo(() => {
    const status = props.data()?.status
    return status !== undefined ? `  ${status.projectRoot}` : ""
  })

  const totalsLine = createMemo(() => {
    const data = props.data()
    if (data === undefined) return ""
    return totalsSummary(data.effectiveness.totals)
  })

  createEffect(() => {
    props.onRows(rows().length)
  })

  createEffect(() => {
    props.onSelection(rows()[selected()]?.select)
  })

  const tabLabel = (tab: MemoryTab, label: string): string =>
    props.tab() === tab ? `[${label}]` : ` ${label} `

  return (
    <box flexDirection="column" width={width()}>
      <box flexDirection="row">
        <text fg={props.theme.text.base}>memory</text>
        <text fg={props.theme.text.muted}>{projectRoot()}</text>
      </box>
      <box flexDirection="row">
        <text fg={props.tab() === "injections" ? props.theme.text.action.primary.base : props.theme.text.muted}>
          {tabLabel("injections", "1 Injections")}
        </text>
        <text fg={props.tab() === "effectiveness" ? props.theme.text.action.primary.base : props.theme.text.muted}>
          {tabLabel("effectiveness", "2 Effectiveness")}
        </text>
        <text fg={props.tab() === "config" ? props.theme.text.action.primary.base : props.theme.text.muted}>
          {tabLabel("config", "3 Config")}
        </text>
      </box>
      <text fg={props.theme.text.muted}>{totalsLine()}</text>
      <text fg={props.theme.text.muted}>{"─".repeat(Math.max(width() - 2, 10))}</text>

      <Show when={props.error() !== undefined}>
        <text fg={props.theme.text.feedback.error.base}>{clip(props.error() ?? "", width())}</text>
      </Show>
      <Show when={props.error() === undefined && rows().length === 0}>
        <text fg={props.theme.text.muted}>{props.data() === undefined ? "loading…" : "nothing here yet"}</text>
      </Show>
      <For each={rows()}>
        {(row, index) => (
          <box flexDirection="column">
            <text fg={index() === selected() ? props.theme.text.action.primary.base : props.theme.text.base}>
              {`${index() === selected() ? "▸" : " "} ${clip(row.text, width() - 2)}`}
            </text>
            <Show when={index() === selected() && row.detail !== undefined}>
              <text fg={props.theme.text.muted}>{`    ${clip(row.detail ?? "", width() - 6)}`}</text>
            </Show>
          </box>
        )}
      </For>

      <text fg={props.theme.text.muted}>
        {props.tab() === "effectiveness"
          ? "1/2/3 tabs · ↑/↓ select · b block toggle · r refresh · f fullscreen · esc close"
          : props.tab() === "config"
            ? "1/2/3 tabs · ↑/↓ select · enter edit · r refresh · f fullscreen · esc close"
            : "1/2/3 tabs · ↑/↓ select · r refresh · f fullscreen · esc close"}
      </text>
    </box>
  )
}
