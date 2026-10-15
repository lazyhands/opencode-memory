import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { memoryTools } from "../src/tools.ts"
import type { MemoryToolDefinition } from "../src/tools.ts"
import { parseEvents } from "../src/core/audit.ts"
import { makeServerFixture, seedStores } from "./helpers.ts"

function tool(tools: MemoryToolDefinition[], name: string): MemoryToolDefinition {
  const found = tools.find((item) => item.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

async function run(tools: MemoryToolDefinition[], name: string, input: unknown): Promise<string> {
  const result = await tool(tools, name).execute(input, { sessionID: "ses_tools" })
  return result.content
}

test("the tool suite exports exactly the nine memory tools", () => {
  const tools = memoryTools(makeServerFixture().runtime)
  assert.deepEqual(
    tools.map((definition) => definition.name),
    [
      "memory_set",
      "memory_read",
      "memory_search",
      "memory_learn",
      "memory_issue",
      "memory_forget",
      "memory_restore",
      "memory_status",
      "memory_audit",
    ],
  )
})

test("memory_set adds entries, commits, emits changed, and dedupes", async () => {
  const fx = makeServerFixture()
  const tools = memoryTools(fx.runtime)

  const out = await run(tools, "memory_set", { target: "project", action: "add", kind: "pref", content: "Prefer bun over npm" })
  assert.match(out, /✓ added project\/pref/)
  assert.ok(readFileSync(join(fx.projectDir, "project.md"), "utf8").includes("[pref] Prefer bun over npm"))
  assert.equal(fx.events.filter((event) => event.event === "changed").length, 1)

  const duplicate = await run(tools, "memory_set", { target: "project", action: "add", kind: "pref", content: "Prefer bun over npm" })
  assert.match(duplicate, /^= identical/)
  assert.equal(fx.events.filter((event) => event.event === "changed").length, 1, "no commit for a no-op")
})

test("memory_set rejects project-specific content in personality memory", async () => {
  const fx = makeServerFixture()
  const tools = memoryTools(fx.runtime)
  await assert.rejects(
    () => run(tools, "memory_set", { target: "personality", action: "add", content: `Check notes in ${fx.projectRoot}` }),
    /\[routing_violation\]/,
  )
  await assert.rejects(
    () => run(tools, "memory_set", { target: "project", action: "add", kind: "rule", content: "wrong kind for project" }),
    /\[invalid_kind\]/,
  )
})

test("memory_set replace edits via unique old_text and rejects ambiguity", async () => {
  const fx = makeServerFixture()
  const tools = memoryTools(fx.runtime)
  await run(tools, "memory_set", { target: "project", action: "add", content: "API port is 3000" })
  await run(tools, "memory_set", { target: "project", action: "add", content: "API port is 4000 (staging)" })

  await assert.rejects(
    () => run(tools, "memory_set", { target: "project", action: "replace", content: "API port is 5000", old_text: "API port" }),
    /\[ambiguous_match\]/,
  )

  const replaced = await run(tools, "memory_set", {
    target: "project",
    action: "replace",
    content: "API port is 5000",
    old_text: "3000",
  })
  assert.match(replaced, /✓ replaced 1 project entry/)
  const listed = await run(tools, "memory_read", { target: "project" })
  assert.ok(listed.includes("API port is 5000"))
  assert.ok(!listed.includes("API port is 3000"))
})

test("memory_set reports overflow against the configured cap", async () => {
  const fx = makeServerFixture({ projectCharLimit: 40 })
  const tools = memoryTools(fx.runtime)
  await run(tools, "memory_set", { target: "project", action: "add", content: "one short fact here" })
  await assert.rejects(
    () => run(tools, "memory_set", { target: "project", action: "add", content: "another fact that will not fit" }),
    /\[overflow\]/,
  )
})

test("memory_read filters by kind and explains empty stores", async () => {
  const fx = makeServerFixture()
  const tools = memoryTools(fx.runtime)
  const empty = await run(tools, "memory_read", { target: "personality" })
  assert.match(empty, /personality memory is empty/)

  await run(tools, "memory_set", { target: "project", action: "add", kind: "fact", content: "Fact one" })
  await run(tools, "memory_set", { target: "project", action: "add", kind: "decision", content: "Decision one" })
  const filtered = await run(tools, "memory_read", { target: "project", kind: "decision" })
  assert.ok(filtered.includes("Decision one"))
  assert.ok(!filtered.includes("Fact one"))
  assert.match(filtered, /project \(\d+ entries/)
})

test("memory_search spans stores and records a search audit event", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const tools = memoryTools(fx.runtime)

  const out = await run(tools, "memory_search", { query: "bun test", target: "all" })
  assert.ok(out.includes("lesson/failure: npm test fails in this repo"))

  const events = parseEvents(readFileSync(join(fx.projectDir, "audit.jsonl"), "utf8"))
  assert.equal(events.filter((event) => event.type === "search").length, 1)

  const miss = await run(tools, "memory_search", { query: "zzz-nothing-matches-zzz" })
  assert.match(miss, /no matches/)
})

test("memory_learn records and dedupes lessons", async () => {
  const fx = makeServerFixture()
  const tools = memoryTools(fx.runtime)

  const out = await run(tools, "memory_learn", {
    outcome: "failure",
    title: "npm test is not wired",
    content: "Use bun test — there is no npm test script",
  })
  assert.match(out, /✓ lesson recorded \(failure\)/)
  assert.equal(fx.events.filter((event) => event.event === "changed" && event.data["scope"] === "learnings").length, 1)

  const duplicate = await run(tools, "memory_learn", {
    outcome: "failure",
    title: "npm test is not wired",
    content: "Use bun test — there is no npm test script",
  })
  assert.match(duplicate, /^= identical lesson/)

  await assert.rejects(
    () => run(tools, "memory_learn", { outcome: "outcome?", title: "t", content: "c" }),
    /\[invalid_content\]/,
  )
})

test("memory_issue opens, updates, regresses and lists threads", async () => {
  const fx = makeServerFixture()
  const tools = memoryTools(fx.runtime)

  const opened = await run(tools, "memory_issue", {
    action: "open",
    title: "Login redirect loop",
    areas: ["src/auth/**"],
    note: "suspect refresh order",
  })
  assert.match(opened, /✓ opened #i1 \(open\)/)

  const listed = await run(tools, "memory_issue", { action: "list" })
  assert.ok(listed.includes("#i1 open"))
  assert.ok(listed.includes("src/auth/**"))

  const fixed = await run(tools, "memory_issue", { action: "update", id: "i1", status: "fixed", verify_with: "bun test auth" })
  assert.match(fixed, /✓ #i1 → fixed/)

  const regressed = await run(tools, "memory_issue", { action: "update", id: "i1", status: "regressed", note: "came back after the refactor" })
  assert.match(regressed, /regressed \(regression #1 recorded\)/)

  await assert.rejects(
    () => run(tools, "memory_issue", { action: "update", id: "i1", status: "open" }),
    /\[invalid_status\]/,
  )
  await assert.rejects(() => run(tools, "memory_issue", { action: "update", id: "i1" }), /\[invalid_content\]/)
  await assert.rejects(() => run(tools, "memory_issue", { action: "open", title: "no areas" }), /\[invalid_content\]/)
})

test("memory_forget is recoverable via memory_restore", async () => {
  const fx = makeServerFixture()
  const tools = memoryTools(fx.runtime)
  await run(tools, "memory_set", { target: "project", action: "add", content: "Temporary fact" })

  const forgotten = await run(tools, "memory_forget", { target: "project", old_text: "Temporary fact", reason: "stale" })
  const id = /recovery: (r[0-9a-z-]+)/.exec(forgotten)?.[1] ?? ""
  assert.ok(id !== "", `recovery id in: ${forgotten}`)
  assert.ok(!readFileSync(join(fx.projectDir, "project.md"), "utf8").includes("Temporary fact"))

  const restored = await run(tools, "memory_restore", { target: "project", recovery_id: id })
  assert.match(restored, /✓ restored 1 entry/)
  assert.ok(readFileSync(join(fx.projectDir, "project.md"), "utf8").includes("Temporary fact"))

  await assert.rejects(() => run(tools, "memory_restore", { target: "project", recovery_id: id }), /\[not_found\]/)

  // Restoring when the entry is already present consumes the recovery cleanly.
  const forgotten2 = await run(tools, "memory_forget", { target: "project", old_text: "Temporary fact" })
  const id2 = /recovery: (r[0-9a-z-]+)/.exec(forgotten2)?.[1] ?? ""
  await run(tools, "memory_set", { target: "project", action: "add", content: "Temporary fact" })
  const replayed = await run(tools, "memory_restore", { target: "project", recovery_id: id2 })
  assert.match(replayed, /^= all 1 entry was already present/)
})

test("memory_status reports usage, config sources, warnings and lint", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  const tools = memoryTools(fx.runtime)

  const out = await run(tools, "memory_status", {})
  assert.match(out, /^memory status — /)
  assert.ok(out.includes("maxInjectChars = 2400 (default)"))
  assert.ok(out.includes("personality "))
  assert.ok(out.includes("lessons 1"))

  writeFileSync(join(fx.projectDir, "config.json"), JSON.stringify({ jit: "yes" }))
  const withWarning = await run(tools, "memory_status", {})
  assert.ok(withWarning.includes("warnings"))
  assert.ok(withWarning.includes("invalid_config"))
})

test("memory_audit summarizes injections after a rebuild", async () => {
  const fx = makeServerFixture()
  seedStores(fx)
  await fx.runtime.inject({
    sessionID: "ses_audit",
    messages: [{ role: "user", id: "msg_a", content: [{ type: "text", text: "auth refresh" }] }],
  })
  const tools = memoryTools(fx.runtime)
  const out = await run(tools, "memory_audit", {})

  assert.match(out, /memory audit — 1 session\(s\) · 1 injection\(s\)/)
  assert.ok(out.includes("recent injections"))
  const events = parseEvents(readFileSync(join(fx.projectDir, "audit.jsonl"), "utf8"))
  assert.equal(events.filter((event) => event.type === "review").length, 1)
})
