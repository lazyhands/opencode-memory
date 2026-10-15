import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRuntime, deriveTurnKey, projectTermsFor, turnContextFromMessages } from "../src/runtime.ts"
import { parseEvents } from "../src/core/audit.ts"
import { hasCode } from "../src/core/errors.ts"
import { readGuardrails } from "../src/core/learnings.ts"
import { serializeGuardrails } from "../src/core/learnings.ts"
import { guardrail, makeServerFixture, seedStores } from "./helpers.ts"

// ---------------------------------------------------------------------------
// Turn extraction
// ---------------------------------------------------------------------------

test("deriveTurnKey prefers the last user message id", () => {
  const messages = [
    { role: "user", id: "msg_1", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [] },
    { role: "user", id: "msg_2", content: [{ type: "text", text: "two" }] },
    { role: "tool", content: [] },
  ]
  assert.equal(deriveTurnKey(messages), "msg_2")
})

test("deriveTurnKey is stable while a turn grows and changes across turns", () => {
  const first = [{ role: "user", content: "hello world" }]
  const key = deriveTurnKey(first)
  assert.match(key, /^u0:t:[0-9a-f]+$/)
  assert.equal(deriveTurnKey([{ role: "user", content: "hello world" }, { role: "assistant", content: [] }]), key)
  assert.notEqual(deriveTurnKey([{ role: "user", content: "something else" }]), key)
  assert.equal(deriveTurnKey([]), "none")
})

test("turnContextFromMessages collects only the current turn's text, files and commands", () => {
  const messages = [
    { role: "user", id: "u1", content: [{ type: "text", text: "fix the auth redirect" }] },
    { role: "assistant", content: [{ type: "tool-call", name: "read", input: { filePath: "src/old.ts" } }] },
    { role: "system", content: [{ type: "text", text: "ignored" }] },
    { role: "user", id: "u2", content: [{ type: "text", text: "now the token refresh" }] },
    { role: "assistant", content: [{ type: "tool-call", name: "read", input: { filePath: "src/auth/token.ts" } }] },
    { role: "assistant", content: [{ type: "tool-call", name: "shell", input: { command: "bun test auth" } }] },
    { role: "assistant", content: [{ type: "tool-call" }] },
  ]
  const context = turnContextFromMessages(messages)
  assert.equal(context.text, "now the token refresh")
  assert.deepEqual(context.files, ["src/auth/token.ts"])
  assert.deepEqual(context.commands, ["bun test auth"])
})

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

test("inject builds one turn-stable block, logs it once and emits once", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const messages = [{ role: "user", id: "msg_1", content: [{ type: "text", text: "how does the auth refresh flow work?" }] }]

  const first = await fx.runtime.inject({ sessionID: "ses_inject", messages })
  assert.equal(first.rebuilt, true)
  assert.ok(first.block?.includes("[PERSONALITY]"))
  assert.ok(first.block?.includes("[PROJECT]"))
  assert.ok(first.block?.includes("[MEMORY PROTOCOL]"))
  assert.ok(first.block?.includes("i2"), "fixed thread surfaces via JIT regression watch")

  // Same turn, messages grew between model calls → byte-identical block.
  const second = await fx.runtime.inject({
    sessionID: "ses_inject",
    messages: [...messages, { role: "assistant", content: [{ type: "text", text: "thinking" }] }],
  })
  assert.equal(second.rebuilt, false)
  assert.equal(second.block, first.block)

  const events = parseEvents(readFileSync(join(fx.projectDir, "audit.jsonl"), "utf8"))
  const injects = events.filter((event) => event.type === "inject")
  assert.equal(injects.length, 1)
  assert.equal(fx.events.filter((event) => event.event === "injected").length, 1)
  assert.equal(fx.events.filter((event) => event.event === "changed").length, 0)
})

test("writes bump the epoch, rebuild the block, and emit changed", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const messages = [{ role: "user", id: "msg_w", content: [{ type: "text", text: "hello" }] }]
  const first = await fx.runtime.inject({ sessionID: "ses_writes", messages })
  assert.equal(first.rebuilt, true)

  const loaded = fx.runtime.load(await fx.runtime.resolveWorkspace("ses_writes"))
  fx.runtime.commit(loaded, "project")

  const after = await fx.runtime.inject({ sessionID: "ses_writes", messages })
  assert.equal(after.rebuilt, true)
  assert.equal(fx.events.filter((event) => event.event === "changed").length, 1)
  assert.equal(fx.events.filter((event) => event.event === "injected").length, 2)
})

test("pins force a rebuild within the turn and are dropped on the next turn", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const messages = [{ role: "user", id: "msg_p", content: [{ type: "text", text: "hello" }] }]
  const first = await fx.runtime.inject({ sessionID: "ses_pin", messages })

  const marker = "PINNED-GUARDRAIL-TEXT"
  fx.runtime.pin("ses_pin", { ref: "g:g9", text: marker, reason: "preflight:g9" })
  const pinned = await fx.runtime.inject({ sessionID: "ses_pin", messages })
  assert.equal(pinned.rebuilt, true)
  assert.ok(pinned.block?.includes(marker))
  assert.notEqual(pinned.block, first.block)

  // Still the same turn → stable again.
  const stable = await fx.runtime.inject({ sessionID: "ses_pin", messages })
  assert.equal(stable.rebuilt, false)
  assert.equal(stable.block, pinned.block)

  // New user message → rebuild without the pin.
  const nextTurn = await fx.runtime.inject({
    sessionID: "ses_pin",
    messages: [...messages, { role: "assistant", content: [] }, { role: "user", id: "msg_q", content: [{ type: "text", text: "hello" }] }],
  })
  assert.equal(nextTurn.rebuilt, true)
  assert.ok(!nextTurn.block?.includes(marker))
})

test("invalidateBlock forces a rebuild (compaction path)", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const messages = [{ role: "user", id: "msg_c", content: [{ type: "text", text: "hello" }] }]
  await fx.runtime.inject({ sessionID: "ses_compact", messages })
  fx.runtime.invalidateBlock("ses_compact")
  const rebuilt = await fx.runtime.inject({ sessionID: "ses_compact", messages })
  assert.equal(rebuilt.rebuilt, true)
})

test("config changes rebuild the block even without a new turn", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const messages = [{ role: "user", id: "msg_cfg", content: [{ type: "text", text: "hello" }] }]
  await fx.runtime.inject({ sessionID: "ses_cfg", messages })
  await fx.runtime.setConfigValue({ scope: "project", key: "protocol", value: "off" })
  const after = await fx.runtime.inject({ sessionID: "ses_cfg", messages })
  assert.equal(after.rebuilt, true)
  assert.ok(!after.block?.includes("[MEMORY PROTOCOL]"))
})

test("applyToSystem appends once, replaces carried-over blocks, and never duplicates", () => {
  const fx = makeServerFixture()
  const block = "BLOCK-A"

  const system: { type?: string; text?: string }[] = [{ type: "text", text: "base" }]
  assert.equal(fx.runtime.applyToSystem("ses_sys", system, block), true)
  assert.deepEqual(system.map((part) => part.text), ["base", "BLOCK-A"])

  // A fresh system array that already carries our previous block (replacement path).
  const carried = [{ type: "text", text: "base" }, { type: "text", text: block }]
  assert.equal(fx.runtime.applyToSystem("ses_sys", carried, "BLOCK-B"), true)
  assert.deepEqual(carried.map((part) => part.text), ["base", "BLOCK-B"])

  // Same block already present → no change, no duplicate.
  const same = [{ type: "text", text: "base" }, { type: "text", text: "BLOCK-B" }]
  assert.equal(fx.runtime.applyToSystem("ses_sys", same, "BLOCK-B"), false)
  assert.equal(same.length, 2)

  // Compaction forgets the applied block; the next apply appends the new one.
  fx.runtime.invalidateApplied("ses_sys")
  const fresh = [{ type: "text", text: "base" }]
  assert.equal(fx.runtime.applyToSystem("ses_sys", fresh, "BLOCK-C"), true)
  assert.deepEqual(fresh.map((part) => part.text), ["base", "BLOCK-C"])
})

// ---------------------------------------------------------------------------
// Config + guardrail RPC operations (shared with index.ts handlers)
// ---------------------------------------------------------------------------

test("setConfigValue writes only the touched key and returns the effective view", async () => {
  const fx = makeServerFixture()
  const view = await fx.runtime.setConfigValue({ scope: "project", key: "maxInjectChars", value: 1234 })
  assert.equal(view.values["maxInjectChars"], 1234)
  assert.equal(view.sources["maxInjectChars"], join(fx.projectDir, "config.json"))
  assert.deepEqual(JSON.parse(readFileSync(join(fx.projectDir, "config.json"), "utf8")), { maxInjectChars: 1234 })
  assert.equal(fx.events.filter((event) => event.event === "changed" && event.data["scope"] === "config").length, 1)

  // Nested leaf keeps sibling keys intact.
  await fx.runtime.setConfigValue({ scope: "project", key: "guardrails.mode", value: "block" })
  assert.deepEqual(JSON.parse(readFileSync(join(fx.projectDir, "config.json"), "utf8")), {
    maxInjectChars: 1234,
    guardrails: { mode: "block" },
  })

  await assert.rejects(
    () => fx.runtime.setConfigValue({ scope: "project", key: "nope", value: 1 }),
    (error) => hasCode(error, "invalid_config"),
  )
  await assert.rejects(
    () => fx.runtime.setConfigValue({ scope: "global", key: "jit", value: "yes" }),
    (error) => hasCode(error, "invalid_config"),
  )
})

test("setConfigValue refuses to clobber a malformed file", async () => {
  const fx = makeServerFixture()
  writeFileSync(join(fx.projectDir, "config.json"), "{oops")
  await assert.rejects(
    () => fx.runtime.setConfigValue({ scope: "project", key: "jit", value: false }),
    (error) => hasCode(error, "invalid_config"),
  )
  assert.equal(readFileSync(join(fx.projectDir, "config.json"), "utf8"), "{oops")
})

test("setGuardrailMode persists per-guardrail mode and validates", async () => {
  const fx = makeServerFixture()
  writeFileSync(join(fx.projectDir, "guardrails.jsonl"), serializeGuardrails([guardrail({ id: "g1" })]))
  const result = await fx.runtime.setGuardrailMode({ id: "g1", mode: "block" })
  assert.equal(result.id, "g1")
  assert.equal(result.mode, "block")
  const stored = readGuardrails(join(fx.projectDir, "guardrails.jsonl"))
  assert.equal(stored[0]?.mode, "block")
  assert.equal(fx.events.filter((event) => event.event === "changed" && event.data["scope"] === "guardrails").length, 1)

  await assert.rejects(
    () => fx.runtime.setGuardrailMode({ id: "gX", mode: "warn" }),
    (error) => hasCode(error, "not_found"),
  )
  await assert.rejects(
    () => fx.runtime.setGuardrailMode({ id: "g1", mode: "maybe" }),
    (error) => hasCode(error, "invalid_config"),
  )
})

// ---------------------------------------------------------------------------
// Status / search / audit aggregation
// ---------------------------------------------------------------------------

test("statusData reports usage, config values with sources, and audit totals", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  await fx.runtime.inject({
    sessionID: "ses_status",
    messages: [{ role: "user", id: "msg_s", content: [{ type: "text", text: "auth refresh" }] }],
  })
  const loaded = fx.runtime.load(await fx.runtime.resolveWorkspace("ses_status"))
  const data = fx.runtime.statusData(loaded)

  assert.equal(data.usage.personality.entries, 1)
  assert.equal(data.usage.project.entries, 2)
  assert.equal(data.usage.lessons, 1)
  assert.equal(data.usage.threads.fixed, 1)
  assert.equal(data.config.values["maxInjectChars"], 2400)
  assert.equal(data.config.sources["maxInjectChars"], "default")
  assert.equal(data.audit.injections, 1)
  assert.deepEqual(data.lint, [])
})

test("searchMemory spans stores and reports refs", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const loaded = fx.runtime.load(await fx.runtime.resolveWorkspace("ses_search"))

  const hits = fx.runtime.searchMemory(loaded, "sqlite caching", "project", 5)
  assert.ok(hits.length >= 1)
  assert.ok(hits.some((hit) => hit.ref.startsWith("j:")))

  const lessonHits = fx.runtime.searchMemory(loaded, "bun test", "all", 5)
  assert.ok(lessonHits.some((hit) => hit.name.startsWith("lesson/")))

  const personalityHits = fx.runtime.searchMemory(loaded, "run tests before claiming", "personality", 5)
  assert.ok(personalityHits.every((hit) => hit.ref.startsWith("p:")))
  assert.equal(personalityHits.length >= 1, true)
})

test("projectTermsFor returns directory name and root", () => {
  const terms = projectTermsFor("/tmp/some/project-root")
  assert.deepEqual(terms, ["project-root", "/tmp/some/project-root"])
})

// ---------------------------------------------------------------------------
// Audit retention + TUI data providers
// ---------------------------------------------------------------------------

test("writeAudit prunes events outside the retention window", async () => {
  const fx = makeServerFixture({ audit: { retentionDays: 1 } })
  const file = join(fx.projectDir, "audit.jsonl")
  writeFileSync(
    file,
    `${JSON.stringify({ v: 1, ts: "2020-01-01T00:00:00.000Z", type: "inject", hash: "s:old", chars: 1 })}\n`,
  )
  const loaded = fx.runtime.load(await fx.runtime.resolveWorkspace("ses_prune"))
  fx.runtime.writeAudit(loaded, "search", { query: "x", hits: 0 })
  const events = parseEvents(readFileSync(file, "utf8"))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, "search")
})

test("injectionLog returns newest-first entries with sections and refs, filterable by session", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  await fx.runtime.inject({
    sessionID: "ses_log",
    messages: [{ role: "user", id: "m1", content: [{ type: "text", text: "how does auth refresh work?" }] }],
  })
  await fx.runtime.inject({
    sessionID: "ses_other",
    messages: [{ role: "user", id: "m2", content: [{ type: "text", text: "hello" }] }],
  })
  const loaded = fx.runtime.load(await fx.runtime.resolveWorkspace("ses_log"))

  const all = fx.runtime.injectionLog(loaded, { limit: 10 })
  assert.equal(all.length, 2)
  assert.ok(all[0]!.ts >= all[1]!.ts, "newest first")
  assert.ok(all[0]!.sections.some((section) => section.name === "MEMORY PROTOCOL"))

  const only = fx.runtime.injectionLog(loaded, { sessionID: "ses_log", limit: 10 })
  assert.equal(only.length, 1)
  assert.equal(only[0]?.sessionID, "ses_log")
  assert.ok((only[0]?.refs ?? []).length > 0, "entry refs captured for the effectiveness join")

  // When JIT fires, the reason map explains why the section was injected.
  const jitEntry = fx.runtime.injectionLog(loaded, { sessionID: "ses_log", limit: 10 })[0]
  const relevant = jitEntry?.sections.find((section) => section.name === "RELEVANT THIS TURN")
  assert.ok(relevant !== undefined)
  const reasons = Object.values(relevant.why ?? {})
  assert.ok(reasons.some((reason) => reason.startsWith("jit:")), `jit reasons in ${JSON.stringify(relevant.why)}`)
})

test("effectivenessData filters by scope, labels entries and carries totals", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  await fx.runtime.inject({
    sessionID: "ses_eff",
    messages: [{ role: "user", id: "m1", content: [{ type: "text", text: "how does auth refresh work?" }] }],
  })
  const loaded = fx.runtime.load(await fx.runtime.resolveWorkspace("ses_eff"))

  const all = fx.runtime.effectivenessData(loaded, "all")
  assert.equal(all.totals.injections, 1)
  assert.ok(all.entries.length > 0)
  assert.ok(all.entries.every((entry) => entry.injected >= 1 && entry.reoccurred === 0))
  assert.ok(all.entries.some((entry) => entry.ref.startsWith("p:")))
  assert.ok(all.entries.some((entry) => entry.ref.startsWith("j:")))
  assert.ok(all.entries.some((entry) => entry.label !== undefined))

  const personality = fx.runtime.effectivenessData(loaded, "personality")
  assert.ok(personality.entries.length > 0)
  assert.ok(personality.entries.every((entry) => entry.ref.startsWith("p:")))

  const project = fx.runtime.effectivenessData(loaded, "project")
  assert.ok(project.entries.every((entry) => !entry.ref.startsWith("p:")))
  assert.ok(project.entries.some((entry) => entry.ref.startsWith("j:")))
})

test("runtime is constructible without options", async () => {
  const runtime = createRuntime({ resolveDirectory: async () => process.cwd() })
  const workspace = await runtime.resolveWorkspace()
  assert.ok(workspace.projectRoot.length > 0)
  assert.ok(workspace.projectDir.endsWith(join(".opencode", "memory")))
})
