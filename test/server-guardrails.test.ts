import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseEvents } from "../src/core/audit.ts"
import { readGuardrails, serializeGuardrails } from "../src/core/learnings.ts"
import { failureTextFromResult } from "../src/runtime.ts"
import { guardrail, makeServerFixture } from "./helpers.ts"

function guardrailsFile(fx: ReturnType<typeof makeServerFixture>): string {
  return join(fx.projectDir, "guardrails.jsonl")
}

function auditEvents(fx: ReturnType<typeof makeServerFixture>) {
  const path = join(fx.projectDir, "audit.jsonl")
  return existsSync(path) ? parseEvents(readFileSync(path, "utf8")) : []
}

const MESSAGE = [{ role: "user", id: "msg_h", content: [{ type: "text", text: "run the tests" }] }]

// ---------------------------------------------------------------------------
// Pre-flight (execute.before)
// ---------------------------------------------------------------------------

test("preflight warn pins the fix into the next block and audits", async () => {
  const fx = makeServerFixture()
  writeFileSync(
    guardrailsFile(fx),
    serializeGuardrails([
      guardrail({
        id: "g1",
        sig: "shell::npm test::command not found",
        tool: "shell",
        fingerprint: "npm test",
        state: "resolved",
        fix: { input: "bun test", at: "2026-10-05T00:00:00.000Z" },
      }),
    ]),
  )

  const result = await fx.runtime.preflight({ sessionID: "ses_pf", tool: "shell", input: { command: "npm test" } })
  assert.equal(result.blocked, false)
  assert.equal(result.guardrail, "g1")

  // The pin lands in the next injected block with reason preflight:g1.
  const injection = await fx.runtime.inject({ sessionID: "ses_pf", messages: MESSAGE })
  assert.ok(injection.block?.includes("bun test"))

  const events = auditEvents(fx)
  const preflights = events.filter((event) => event.type === "preflight")
  assert.equal(preflights.length, 1)
  assert.equal(preflights[0]?.["blocked"], false)
  assert.equal(preflights[0]?.["guardrail"], "g1")

  const inject = events.find((event) => event.type === "inject")
  const sections = (inject?.["sections"] ?? []) as { why?: Record<string, string> }[]
  const reasons = sections.flatMap((section) => Object.values(section.why ?? {}))
  assert.ok(reasons.includes("preflight:g1"))
})

test("preflight block mode aborts with the recorded fix (per-guardrail and global)", async () => {
  // Per-guardrail override.
  const fx = makeServerFixture()
  writeFileSync(
    guardrailsFile(fx),
    serializeGuardrails([
      guardrail({
        id: "g2",
        sig: "shell::npm test::command not found",
        tool: "shell",
        fingerprint: "npm test",
        state: "resolved",
        mode: "block",
        fix: { input: "bun test", at: "2026-10-05T00:00:00.000Z" },
      }),
    ]),
  )
  const blocked = await fx.runtime.preflight({ sessionID: "ses_b", tool: "shell", input: { command: "npm test" } })
  assert.equal(blocked.blocked, true)
  assert.ok(blocked.message?.includes("bun test"))
  assert.ok(blocked.message?.includes("#g2"))
  const preflights = auditEvents(fx).filter((event) => event.type === "preflight")
  assert.equal(preflights[0]?.["blocked"], true)

  // Global mode via plugin options; per-guardrail warn wins over it.
  const fx2 = makeServerFixture({ guardrails: { mode: "block" } })
  writeFileSync(
    guardrailsFile(fx2),
    serializeGuardrails([
      guardrail({ id: "g3", sig: "shell::npm test::x", tool: "shell", fingerprint: "npm test", mode: "inherit" }),
      guardrail({ id: "g4", sig: "shell::npm lint::x", tool: "shell", fingerprint: "npm lint", mode: "warn" }),
    ]),
  )
  const globalBlocked = await fx2.runtime.preflight({ sessionID: "ses_b2", tool: "shell", input: { command: "npm test" } })
  assert.equal(globalBlocked.blocked, true)
  const perWarn = await fx2.runtime.preflight({ sessionID: "ses_b2", tool: "shell", input: { command: "npm lint" } })
  assert.equal(perWarn.blocked, false)
  assert.equal(perWarn.guardrail, "g4")
})

test("preflight ignores non-matching, dismissed and internal tools", async () => {
  const fx = makeServerFixture()
  writeFileSync(
    guardrailsFile(fx),
    serializeGuardrails([
      guardrail({ id: "g5", sig: "shell::npm test::x", tool: "shell", fingerprint: "npm test", state: "dismissed" }),
    ]),
  )
  assert.equal((await fx.runtime.preflight({ sessionID: "s", tool: "shell", input: { command: "npm test" } })).blocked, false)
  assert.equal((await fx.runtime.preflight({ sessionID: "s", tool: "shell", input: { command: "ls" } })).blocked, false)
  assert.equal((await fx.runtime.preflight({ sessionID: "s", tool: "memory_set", input: { command: "npm test" } })).blocked, false)
  assert.equal((await fx.runtime.preflight({ sessionID: "s", tool: "execute", input: { command: "npm test" } })).blocked, false)
})

// ---------------------------------------------------------------------------
// Failure capture + coaching (execute.after → error)
// ---------------------------------------------------------------------------

test("captureFailure records the guardrail, audits, and counts reoccurrences after injection", async () => {
  const fx = makeServerFixture()
  const error = new Error("command not found: npm")

  const first = await fx.runtime.captureFailure({ sessionID: "ses_cap", tool: "shell", input: { command: "npm test" }, error })
  assert.equal(first.guardrail, "g1")
  assert.equal(first.coached, false)

  const stored = readGuardrails(guardrailsFile(fx))
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.state, "open")
  assert.equal(stored[0]?.count, 1)
  assert.deepEqual(stored[0]?.sessions, ["ses_cap"])
  assert.equal(auditEvents(fx).filter((event) => event.type === "fail").length, 1)

  // The guardrail is now injected (settle-on-write rebuild shows it to the model)…
  const injection = await fx.runtime.inject({ sessionID: "ses_cap", messages: MESSAGE })
  assert.ok(injection.block?.includes("npm test"))

  // …so the next failure counts as a reoccurrence after injection.
  await fx.runtime.captureFailure({ sessionID: "ses_cap", tool: "shell", input: { command: "npm test" }, error })
  const events = auditEvents(fx)
  assert.equal(events.filter((event) => event.type === "fail").length, 2)
  const reoccur = events.filter((event) => event.type === "reoccur")
  assert.equal(reoccur.length, 1)
  assert.equal(reoccur[0]?.["ref"], "g:g1")

  const loaded = fx.runtime.load(await fx.runtime.resolveWorkspace("ses_cap"))
  const stats = fx.runtime.auditStats(loaded)
  assert.equal(stats.failures, 2)
  const stat = stats.entries.find((entry) => entry.ref === "g:g1")
  assert.ok(stat !== undefined)
  assert.ok(stat.injected >= 1)
  assert.equal(stat.reoccurred, 1)
})

test("captureFailure coaches with the fix of a matching resolved guardrail", async () => {
  const fx = makeServerFixture()
  writeFileSync(
    guardrailsFile(fx),
    serializeGuardrails([
      guardrail({
        id: "g3",
        sig: "shell::npm test::command not found",
        tool: "shell",
        fingerprint: "npm test",
        state: "resolved",
        fix: { input: "bun test", at: "2026-10-05T00:00:00.000Z" },
      }),
    ]),
  )

  const result = await fx.runtime.captureFailure({
    sessionID: "ses_coach",
    tool: "shell",
    input: { command: "npm test" },
    error: new Error("command not found"),
  })
  assert.equal(result.coached, true)
  assert.equal(result.guardrail, "g3")

  // The reoccurrence reopened the record but kept the known fix.
  const stored = readGuardrails(guardrailsFile(fx))
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.state, "open")
  assert.equal(stored[0]?.fix?.input, "bun test")

  const injection = await fx.runtime.inject({ sessionID: "ses_coach", messages: MESSAGE })
  assert.ok(injection.block?.includes("bun test"))
  const inject = auditEvents(fx).find((event) => event.type === "inject")
  const sections = (inject?.["sections"] ?? []) as { why?: Record<string, string> }[]
  const reasons = sections.flatMap((section) => Object.values(section.why ?? {}))
  assert.ok(reasons.includes("coach:g3"))
})

test("capture is skipped for internal tools, disabled capture, and ignore lists", async () => {
  const error = new Error("boom")

  const fx = makeServerFixture()
  const internal = await fx.runtime.captureFailure({ sessionID: "s", tool: "memory_set", input: {}, error })
  assert.equal(internal.guardrail, undefined)
  const wrapper = await fx.runtime.captureFailure({ sessionID: "s", tool: "execute", input: {}, error })
  assert.equal(wrapper.guardrail, undefined)
  assert.equal(existsSync(guardrailsFile(fx)), false)

  const off = makeServerFixture({ capture: { toolErrors: false } })
  const disabled = await off.runtime.captureFailure({ sessionID: "s", tool: "shell", input: { command: "npm test" }, error })
  assert.equal(disabled.guardrail, undefined)
  assert.equal(existsSync(guardrailsFile(off)), false)

  const ignored = makeServerFixture({ capture: { ignoreTools: ["shell"] } })
  const skipped = await ignored.runtime.captureFailure({ sessionID: "s", tool: "shell", input: { command: "npm test" }, error })
  assert.equal(skipped.guardrail, undefined)
  assert.equal(existsSync(guardrailsFile(ignored)), false)
})

// ---------------------------------------------------------------------------
// Auto-resolve loop (execute.after → success)
// ---------------------------------------------------------------------------

test("a recorded failure auto-resolves when the fix succeeds in the same session", async () => {
  const fx = makeServerFixture()
  await fx.runtime.captureFailure({
    sessionID: "ses_fix",
    tool: "shell",
    input: { command: "npm test" },
    error: new Error("command not found"),
  })
  await fx.runtime.inject({ sessionID: "ses_fix", messages: MESSAGE })

  const result = await fx.runtime.autoResolve({ sessionID: "ses_fix", tool: "shell", input: { command: "bun test" } })
  assert.deepEqual(result.resolved, ["g1"])

  const stored = readGuardrails(guardrailsFile(fx))
  assert.equal(stored[0]?.state, "resolved")
  assert.equal(stored[0]?.fix?.input, "bun test")
  const resolves = auditEvents(fx).filter((event) => event.type === "resolve")
  assert.equal(resolves.length, 1)
  assert.equal(resolves[0]?.["ref"], "g:g1")
  assert.equal(resolves[0]?.["fix"], "bun test")
})

test("preflight surfacing enables the resolve loop; unrelated successes never resolve", async () => {
  const fx = makeServerFixture()
  writeFileSync(
    guardrailsFile(fx),
    serializeGuardrails([
      guardrail({
        id: "g4",
        sig: "shell::npm test::command not found",
        tool: "shell",
        fingerprint: "npm test",
        state: "resolved",
        fix: { input: "bun test", at: "2026-10-05T00:00:00.000Z" },
      }),
    ]),
  )
  const pf = await fx.runtime.preflight({ sessionID: "ses_loop", tool: "shell", input: { command: "npm test" } })
  assert.equal(pf.blocked, false)

  // Successful but unrelated calls share no token with the failure — no resolve.
  const unrelated = await fx.runtime.autoResolve({ sessionID: "ses_loop", tool: "shell", input: { command: "ls -la" } })
  assert.deepEqual(unrelated.resolved, [])
  // A different tool never resolves it either.
  const otherTool = await fx.runtime.autoResolve({ sessionID: "ses_loop", tool: "read", input: { filePath: "package.json" } })
  assert.deepEqual(otherTool.resolved, [])
  assert.equal(readGuardrails(guardrailsFile(fx))[0]?.state, "resolved")

  const fixed = await fx.runtime.autoResolve({ sessionID: "ses_loop", tool: "shell", input: { command: "bun test" } })
  assert.deepEqual(fixed.resolved, ["g4"])
})

test("auto-resolve does nothing without a surfaced guardrail in the session", async () => {
  const fx = makeServerFixture()
  writeFileSync(
    guardrailsFile(fx),
    serializeGuardrails([guardrail({ id: "g9", sig: "shell::npm test::x", tool: "shell", fingerprint: "npm test" })]),
  )
  // Never injected or pinned in this session → untouched.
  const result = await fx.runtime.autoResolve({ sessionID: "ses_cold", tool: "shell", input: { command: "bun test" } })
  assert.deepEqual(result.resolved, [])
  assert.equal(readGuardrails(guardrailsFile(fx))[0]?.state, "open")
})

// ---------------------------------------------------------------------------
// Completed-but-failed routing (shapes captured from the live shell tool)
// ---------------------------------------------------------------------------

const SHELL_FAILURE = {
  output: { exit: 1, truncated: false, output: 'npm error Missing script: "missing-script"', status: "completed" },
  content: [
    { type: "text", text: 'npm error Missing script: "missing-script"' },
    { type: "text", text: "Exited with code 1" },
  ],
  metadata: { status: "completed", truncated: false, exit: 1 },
}

const SHELL_SUCCESS = {
  output: { exit: 0, truncated: false, output: "\n> test\n", status: "completed" },
  content: [{ type: "text", text: "\n> test\n" }],
  metadata: { status: "completed", truncated: false, exit: 0 },
}

test("failureTextFromResult detects nonzero exits in completed shell results", () => {
  assert.ok(failureTextFromResult(SHELL_FAILURE)?.includes("Missing script"))
  assert.equal(failureTextFromResult(SHELL_SUCCESS), undefined)
  assert.equal(failureTextFromResult({ content: "plain content" }), undefined)
  assert.equal(failureTextFromResult(undefined), undefined)
  assert.equal(failureTextFromResult({ output: { exit: 1 }, content: [] }), "exit 1")
  assert.equal(failureTextFromResult({ output: { status: "error" }, content: "boom" }), "boom")
})

test("toolOutcome captures failed completed calls and resolves real successes", async () => {
  const fx = makeServerFixture()
  const first = await fx.runtime.toolOutcome({
    sessionID: "ses_out",
    tool: "shell",
    input: { command: "npm run missing-script" },
    status: "completed",
    result: SHELL_FAILURE,
  })
  assert.equal(first.captured, true)
  assert.equal(first.coached, false)

  // The guardrail is visible to the next model call → surfaced in this session.
  await fx.runtime.inject({ sessionID: "ses_out", messages: MESSAGE })

  const second = await fx.runtime.toolOutcome({
    sessionID: "ses_out",
    tool: "shell",
    input: { command: "npm run test" },
    status: "completed",
    result: SHELL_SUCCESS,
  })
  assert.deepEqual(second.resolved, ["g1"])
  const stored = readGuardrails(guardrailsFile(fx))
  assert.equal(stored[0]?.state, "resolved")
  assert.equal(stored[0]?.fix?.input, "npm run test")

  // The same failure again: reopened, reoccurrence counted, coached with the fix.
  const third = await fx.runtime.toolOutcome({
    sessionID: "ses_out",
    tool: "shell",
    input: { command: "npm run missing-script" },
    status: "completed",
    result: SHELL_FAILURE,
  })
  assert.equal(third.captured, true)
  assert.equal(third.coached, true)
  assert.equal(readGuardrails(guardrailsFile(fx))[0]?.state, "open")
})
