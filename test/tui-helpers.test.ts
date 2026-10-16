import { test } from "node:test"
import assert from "node:assert/strict"
import {
  attentionLine,
  displayValue,
  editableValue,
  parseFieldText,
  recalledCount,
  scopeBreakdown,
  sidebarMode,
  sidebarSummary,
  totalsSummary,
} from "../src/tui-rpc.ts"
import type { InjectionLogEntry, StatusData } from "../src/runtime.ts"

// ---------------------------------------------------------------------------
// Config value formatting (TUI editor)
// ---------------------------------------------------------------------------

test("displayValue renders arrays, strings, booleans and numbers", () => {
  assert.equal(displayValue(["a", "b"]), "a, b")
  assert.equal(displayValue([]), "[]")
  assert.equal(displayValue("warn"), "warn")
  assert.equal(displayValue(true), "true")
  assert.equal(displayValue(2400), "2400")
})

test("editableValue renders values for the prompt editor", () => {
  assert.equal(editableValue(["a", "b"]), "a, b")
  assert.equal(editableValue(false), "false")
  assert.equal(editableValue(12), "12")
  assert.equal(editableValue("full"), "full")
})

// ---------------------------------------------------------------------------
// parseFieldText (mirrors server validation lightly)
// ---------------------------------------------------------------------------

test("parseFieldText parses bool spellings", () => {
  for (const text of ["true", "1", "yes", "y", "on", "ON", " True "]) {
    assert.deepEqual(parseFieldText("bool", text), { ok: true, value: true }, text)
  }
  for (const text of ["false", "0", "no", "n", "off"]) {
    assert.deepEqual(parseFieldText("bool", text), { ok: true, value: false }, text)
  }
  const bad = parseFieldText("bool", "maybe")
  assert.equal(bad.ok, false)
})

test("parseFieldText parses integers and rejects junk", () => {
  assert.deepEqual(parseFieldText("int", " 2400 "), { ok: true, value: 2400 })
  assert.deepEqual(parseFieldText("int", "-3"), { ok: true, value: -3 })
  const float = parseFieldText("int", "2.5")
  assert.equal(float.ok, false)
  const empty = parseFieldText("int", "")
  assert.equal(empty.ok, false)
})

test("parseFieldText splits string arrays on commas", () => {
  assert.deepEqual(parseFieldText("string[]", "npm, yarn"), { ok: true, value: ["npm", "yarn"] })
  assert.deepEqual(parseFieldText("string[]", ""), { ok: true, value: [] })
  assert.deepEqual(parseFieldText("string[]", " one , , two "), { ok: true, value: ["one", "two"] })
})

test("parseFieldText passes strings through untouched", () => {
  assert.deepEqual(parseFieldText("string", "warn"), { ok: true, value: "warn" })
  assert.deepEqual(parseFieldText("string", " keep spaces "), { ok: true, value: " keep spaces " })
})

// ---------------------------------------------------------------------------
// Sidebar summary (compact | full | off)
// ---------------------------------------------------------------------------

const usage = (overrides?: Partial<StatusData["usage"]>): StatusData["usage"] => ({
  personality: { entries: 0, chars: 0, cap: 1500 },
  project: { entries: 0, chars: 0, cap: 4000 },
  lessons: 0,
  threads: { open: 0, fixed: 0, verifying: 0, regressed: 0, closed: 0, active: [] },
  guardrails: {},
  reoccurring: 0,
  ...overrides,
})

const injection = (why: Record<string, string> | undefined, chars = 1744): InjectionLogEntry => ({
  ts: "2026-10-16T00:00:00.000Z",
  hash: "s:test",
  chars,
  refs: [],
  sections:
    why === undefined
      ? []
      : [{ name: "RELEVANT THIS TURN", chars: 100, reason: "jit", refs: [], why }],
})

test("recalledCount counts only jit reasons of the relevant section", () => {
  assert.equal(recalledCount(undefined), 0)
  assert.equal(recalledCount(injection(undefined)), 0)
  assert.equal(recalledCount(injection({ "f:src/a.ts": "file", "t:g1": "jit:keyword" })), 1)
  assert.equal(recalledCount(injection({ "t:g1": "jit:keyword", "t:g2": "jit:file" })), 2)
})

test("sidebarMode accepts known values and falls back to compact", () => {
  assert.equal(sidebarMode({ "tui.sidebar": "full" }), "full")
  assert.equal(sidebarMode({ "tui.sidebar": "off" }), "off")
  assert.equal(sidebarMode({ "tui.sidebar": "compact" }), "compact")
  assert.equal(sidebarMode({}), "compact")
  assert.equal(sidebarMode({ "tui.sidebar": "huge" }), "compact")
})

test("compact sidebar: empty state, counts, recalls and singular grammar", () => {
  assert.deepEqual(sidebarSummary({ usage: usage(), lastInjection: undefined, mode: "compact" }), {
    lines: ["nothing remembered yet"],
    attention: undefined,
  })

  const filled = sidebarSummary({
    usage: usage({
      project: { entries: 2, chars: 100, cap: 4000 },
      lessons: 2,
      guardrails: { open: 1, resolved: 1 },
    }),
    lastInjection: injection({ "t:g1": "jit:keyword", "t:g2": "always" }),
    mode: "compact",
  })
  assert.deepEqual(filled.lines, ["6 memories · 1 recalled just now"])

  const single = sidebarSummary({
    usage: usage({ project: { entries: 1, chars: 50, cap: 4000 } }),
    lastInjection: undefined,
    mode: "compact",
  })
  assert.deepEqual(single.lines, ["1 memory"])
})

test("attention line only appears for reoccurring guardrails", () => {
  assert.equal(attentionLine(usage()), undefined)
  assert.equal(attentionLine(usage({ reoccurring: 1 })), "1 guardrail failing again")
  assert.equal(attentionLine(usage({ reoccurring: 3 })), "3 guardrails failing again")
  assert.deepEqual(sidebarSummary({ usage: usage({ reoccurring: 2 }), lastInjection: undefined, mode: "compact" }), {
    lines: ["nothing remembered yet"],
    attention: "2 guardrails failing again",
  })
  assert.equal(sidebarSummary({ usage: usage({ reoccurring: 1 }), lastInjection: undefined, mode: "off" }).attention, undefined)
})

test("full sidebar shows the scope breakdown and injection size on fitting lines", () => {
  const summary = sidebarSummary({
    usage: usage({
      project: { entries: 2, chars: 100, cap: 4000 },
      personality: { entries: 1, chars: 40, cap: 1500 },
      lessons: 2,
      guardrails: { resolved: 2 },
    }),
    lastInjection: injection({ "t:g1": "jit:keyword", "t:g2": "jit:file" }),
    mode: "full",
  })
  assert.deepEqual(summary.lines, [
    "2 project · 1 global · 2 lessons",
    "2 guardrails · 2 recalled · added 436 tok",
  ])

  const noInjection = sidebarSummary({ usage: usage(), lastInjection: undefined, mode: "full" })
  assert.deepEqual(noInjection.lines, ["0 project · 0 global · 0 lessons", "0 guardrails"])

  const singular = sidebarSummary({
    usage: usage({ guardrails: { open: 1 } }),
    lastInjection: injection({}, 1338),
    mode: "full",
  })
  assert.deepEqual(singular.lines, ["0 project · 0 global · 0 lessons", "1 guardrail · added 335 tok"])
})

test("off sidebar renders nothing", () => {
  const summary = sidebarSummary({ usage: usage({ lessons: 3 }), lastInjection: injection({}), mode: "off" })
  assert.deepEqual(summary, { lines: [], attention: undefined })
})

test("scopeBreakdown is the shared vocabulary for toast and full mode", () => {
  assert.equal(
    scopeBreakdown(usage({ project: { entries: 2, chars: 0, cap: 4000 }, lessons: 2, guardrails: { open: 1, resolved: 1 } })),
    "2 project · 0 global · 2 lessons · 2 guardrails",
  )
})

test("totalsSummary spells out labels with correct plurals", () => {
  assert.equal(
    totalsSummary({ sessions: 2, injections: 11, failures: 2, resolves: 1, preflights: 2, blocked: 1, searches: 3 }),
    "11 injections · 2 failures · 1 fix · 2 preflight checks (1 blocked)",
  )
  assert.equal(
    totalsSummary({ sessions: 1, injections: 1, failures: 0, resolves: 0, preflights: 1, blocked: 0, searches: 0 }),
    "1 injection · 0 failures · 0 fixes · 1 preflight check (0 blocked)",
  )
})
