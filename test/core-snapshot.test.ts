import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIG, type MemoryConfig } from "../src/core/config.ts"
import { jitMatches } from "../src/core/jit.ts"
import { lessonRef } from "../src/core/learnings.ts"
import {
  MAX_GUARDRAIL_LINES,
  PACK_ORDER,
  PROTOCOL_FULL,
  PROTOCOL_SHORT,
  SECTION_RENDER_ORDER,
  type SnapshotInputs,
  buildSnapshot,
} from "../src/core/snapshot.ts"
import { entry, guardrail, issue, lesson } from "./helpers.ts"

function config(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides }
}

function inputs(overrides: Partial<SnapshotInputs> = {}): SnapshotInputs {
  return {
    config: config(),
    personality: [],
    project: [],
    lessons: [],
    threads: [],
    guardrails: [],
    ...overrides,
  }
}

test("renders sections in priority order", () => {
  const snapshot = buildSnapshot(
    inputs({
      personality: [entry("rule", "Always research before working")],
      project: [entry("fact", "API base URL is localhost:3000"), entry("correction", "wrong: cookies; use: bearer tokens; verified: 2026-10-01")],
      threads: [issue({ id: "i1", status: "open", notes: [{ at: "2026-10-01", status: "open", text: "watch Z" }] })],
      guardrails: [guardrail({ state: "resolved", fix: { input: "bun test", at: "2026-10-02T00:00:00.000Z" } })],
      lessons: [lesson("failure", "Use bun test", "npm test fails in this repo.")],
    }),
  )
  const names = snapshot.sections.map((section) => section.name)
  assert.deepEqual(names, ["GUARDRAILS", "PERSONALITY", "OPEN THREADS", "CORRECTIONS", "PROJECT", "LESSONS", "MEMORY PROTOCOL"])

  const positions = names.map((name) => snapshot.block.indexOf(`[${name}]`))
  assert.ok(positions.every((position) => position >= 0), "every section has a visible header")
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)

  assert.match(snapshot.block, /\[GUARDRAILS\] 1 resolved · 0 open/)
  assert.match(snapshot.block, /`npm test` failed → use `bun test`/)
  assert.match(snapshot.block, /\[PERSONALITY\] \d+\/1500 chars · 1 entries/)
  assert.match(snapshot.block, /- #i1 open: Login redirect loop — watch Z/)
  assert.match(snapshot.block, /wrong: cookies; use: bearer tokens/)
  assert.match(snapshot.block, /\[LESSONS\] 1 lesson\(s\)/)
  assert.ok(snapshot.block.includes(PROTOCOL_FULL))
  assert.ok(snapshot.refs.some((ref) => ref.startsWith("g:g1")))
  assert.equal(snapshot.truncations.length, 0)
})

test("distill request renders a one-line DISTILL section only when pending", () => {
  const pending = buildSnapshot(inputs({ distill: true }))
  assert.ok(pending.block.includes("[DISTILL]"))
  assert.ok(pending.sections.some((section) => section.name === "DISTILL"))

  const off = buildSnapshot(inputs())
  assert.ok(!off.block.includes("[DISTILL]"))
  assert.ok(!off.sections.some((section) => section.name === "DISTILL"))
})

test("is byte-stable across repeated builds", () => {
  const input = inputs({
    personality: [entry("rule", "Rule one")],
    project: [entry("fact", "Fact one")],
    lessons: [lesson("success", "T", "C")],
    guardrails: [guardrail()],
  })
  const first = buildSnapshot(input)
  const second = buildSnapshot(input)
  assert.equal(first.block, second.block)
  assert.equal(first.hash, second.hash)
  assert.deepEqual(first.refs, second.refs)
})

test("protocol modes: full, short, off", () => {
  assert.ok(buildSnapshot(inputs({ config: config({ protocol: "off" }) })).block.includes("[PERSONALITY] (empty)"))
  assert.ok(!buildSnapshot(inputs({ config: config({ protocol: "off" }) })).block.includes("[MEMORY PROTOCOL]"))
  assert.ok(buildSnapshot(inputs({ config: config({ protocol: "short" }) })).block.includes(PROTOCOL_SHORT))
  assert.ok(buildSnapshot(inputs()).block.includes(PROTOCOL_FULL))
})

test("tiny budget keeps guardrails, never exceeds the budget, logs truncation", () => {
  const snapshot = buildSnapshot(
    inputs({ config: config({ maxInjectChars: 40 }), guardrails: [guardrail()], project: [entry("fact", "some project fact")] }),
  )
  assert.ok(snapshot.chars <= 40)
  assert.equal(snapshot.sections[0]?.name, "GUARDRAILS")
  assert.match(snapshot.block, /\[GUARDRAILS\]/)
  assert.ok(snapshot.truncations.includes("GUARDRAILS: 1 item(s) omitted (budget)"))
})

test("mid budget squeezes the protocol first and records it", () => {
  const snapshot = buildSnapshot(
    inputs({
      config: config({ maxInjectChars: 420 }),
      personality: [entry("rule", "r".repeat(60)), entry("rule", "s".repeat(60))],
      project: [entry("fact", "f".repeat(120))],
      guardrails: [guardrail()],
    }),
  )
  assert.ok(snapshot.chars <= 420)
  assert.ok(snapshot.truncations.some((t) => t.startsWith("MEMORY PROTOCOL:")))
  assert.ok(snapshot.block.includes("[GUARDRAILS]"))
})

test("partial sections get a recall marker", () => {
  const project = Array.from({ length: 10 }, (_, i) => entry("fact", `fact ${i} ${"x".repeat(70)}`))
  const snapshot = buildSnapshot(inputs({ config: config({ maxInjectChars: 300 }), project }))
  assert.ok(snapshot.chars <= 300)
  assert.ok(snapshot.truncations.some((t) => t.startsWith("PROJECT:") && t.includes("omitted")))
  assert.match(snapshot.block, /… \d+ more — recall via memory_search/)
})

test("jit dedupes against packed sections and keeps regression watch", () => {
  const open = issue({ id: "i1", areas: ["src/auth/**"], status: "open" })
  const fixed = issue({
    id: "i2",
    areas: ["src/auth/**"],
    status: "fixed",
    title: "Session leak",
    notes: [{ at: "2026-10-03", status: "fixed", text: "do not reintroduce Z" }],
  })
  const ctx = { text: "fix the auth redirect", files: ["src/auth/session.ts"] }
  const jit = jitMatches({ ctx, threads: [open, fixed], corrections: [], lessons: [], guardrails: [] })
  const snapshot = buildSnapshot(inputs({ threads: [open, fixed], jit }))
  assert.ok(snapshot.block.includes("- #i1 open: Login redirect loop"))
  assert.ok(!snapshot.block.includes("(thread #i1"), "active thread is not repeated in RELEVANT")
  assert.ok(snapshot.block.includes("(thread #i2 fixed · regression watch"))
  assert.ok(snapshot.block.includes("do not reintroduce Z"))
})

test("lessons index respects maxIndexTitles", () => {
  const lessons = Array.from({ length: 15 }, (_, i) => lesson("success", `Lesson ${i + 1}`, "takeaway"))
  const snapshot = buildSnapshot(inputs({ lessons }))
  assert.ok(snapshot.block.includes("[LESSONS] 15 lesson(s)"))
  assert.ok(snapshot.block.includes("… 3 more — recall via memory_search"))
  assert.ok(snapshot.refs.includes(lessonRef(lessons[0]!)))
})

test("pins render first in RELEVANT THIS TURN", () => {
  const snapshot = buildSnapshot(
    inputs({ pins: [{ ref: "g:g1", text: "`npm test` → use `bun test`", reason: "preflight:g1" }] }),
  )
  assert.ok(snapshot.block.includes("[RELEVANT THIS TURN]"))
  assert.ok(snapshot.block.includes("- (pin preflight:g1) `npm test` → use `bun test`"))
  assert.ok(snapshot.refs.includes("g:g1"))
})

test("empty stores still render personality/project hints", () => {
  const snapshot = buildSnapshot(inputs())
  assert.ok(snapshot.block.includes("[PERSONALITY] (empty)"))
  assert.ok(snapshot.block.includes("[PROJECT] (empty)"))
  assert.ok(!snapshot.block.includes("[OPEN THREADS]"))
  assert.ok(!snapshot.block.includes("[RELEVANT THIS TURN]"))
})

test("guardrail lines are capped with a visible remainder", () => {
  const guardrails = Array.from({ length: MAX_GUARDRAIL_LINES + 3 }, (_, i) =>
    guardrail({ id: `g${i + 1}`, fingerprint: `cmd ${i}`, sig: `sig-${i}` }),
  )
  const snapshot = buildSnapshot(inputs({ guardrails }))
  const lines = snapshot.block.split("\n").filter((line) => line.startsWith("- `cmd "))
  assert.equal(lines.length, MAX_GUARDRAIL_LINES)
  assert.match(snapshot.block, /… 3 more failure record\(s\) — memory_status/)
})

test("section orders are exported for the audit dashboard", () => {
  assert.equal(SECTION_RENDER_ORDER.length, PACK_ORDER.length)
  assert.deepEqual([...SECTION_RENDER_ORDER].sort(), [...PACK_ORDER].sort(), "same sections, different packing order")
})
