import { test } from "node:test"
import assert from "node:assert/strict"
import { collectPaths, commandsFromToolCall, jitMatches, keywordSet, matchGlob, pathsFromToolCall } from "../src/core/jit.ts"
import { entry, guardrail, issue, lesson } from "./helpers.ts"

test("matchGlob: globs, bare names, ports, prefixing", () => {
  assert.equal(matchGlob("src/auth/**", "src/auth/session.ts"), true)
  assert.equal(matchGlob("src/auth/**", "src/authx/session.ts"), false)
  assert.equal(matchGlob("**/*.ts", "a/b/c.ts"), true)
  assert.equal(matchGlob("./src/x.ts", "src/x.ts"), true)
  assert.equal(matchGlob("src/x.ts", "/abs/path/src/x.ts"), true)
  assert.equal(matchGlob("auth", "src/auth/session.ts"), true)
  assert.equal(matchGlob("auth", "src/database/users.ts"), false)
  assert.equal(matchGlob("", "src/x.ts"), false)
})

test("keywordSet drops stopwords and short tokens", () => {
  const keywords = keywordSet({ text: "Please fix the auth redirect it is broken" })
  assert.ok(keywords.has("auth"))
  assert.ok(keywords.has("redirect"))
  assert.ok(!keywords.has("the"))
  assert.ok(!keywords.has("is"))
})

test("threads match by area glob with reason, keywords, and regression watch", () => {
  const open = issue({ id: "i1", areas: ["src/auth/**"], status: "open", title: "Login redirect loop" })
  const fixed = issue({ id: "i2", areas: ["src/session/**"], status: "fixed", title: "Session leak", notes: [{ at: "2026-10-03", status: "fixed", text: "guarded Z" }] })
  const matches = jitMatches({
    ctx: { text: "fix the session redirect", files: ["src/auth/session.ts"] },
    threads: [open, fixed],
    corrections: [],
    lessons: [],
    guardrails: [],
  })
  const i1 = matches.find((m) => m.id === "i1")
  assert.equal(i1?.reason, "jit:file:src/auth/**")
  assert.equal(i1?.regressionWatch, undefined)
  const i2 = matches.find((m) => m.id === "i2")
  assert.equal(i2?.regressionWatch, true)
  assert.equal(i2?.detail, "guarded Z")
})

test("corrections and lessons match on keywords with reasons", () => {
  const matches = jitMatches({
    ctx: { text: "migrate the webclient calls" },
    threads: [],
    corrections: [entry("correction", "webclient: wrong: WebClient(); use: WebClient.builder()")],
    lessons: [lesson("failure", "Webclient retries need backoff", "Add retry with backoff.")],
    guardrails: [],
  })
  const correction = matches.find((m) => m.type === "correction")
  assert.equal(correction?.reason, "jit:kw:webclient")
  const lessonMatch = matches.find((m) => m.type === "lesson")
  assert.equal(lessonMatch?.title, "Webclient retries need backoff")
})

test("guardrails match planned commands by token similarity", () => {
  const record = guardrail({ id: "g1", tool: "bash", fingerprint: "npm test" })
  const matches = jitMatches({
    ctx: { commands: ["npm run test --watch"] },
    threads: [],
    corrections: [],
    lessons: [],
    guardrails: [record],
  })
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.type, "guardrail")
  assert.match(matches[0]?.reason ?? "", /^jit:cmd:/)

  const unrelated = jitMatches({
    ctx: { commands: ["git status"] },
    threads: [],
    corrections: [],
    lessons: [],
    guardrails: [record],
  })
  assert.equal(unrelated.length, 0)
})

test("jit output is deterministic and bounded", () => {
  const threads = [
    issue({ id: "i1", areas: ["auth"], title: "A" }),
    issue({ id: "i2", areas: ["auth"], title: "B" }),
  ]
  const run = (): ReturnType<typeof jitMatches> =>
    jitMatches({ ctx: { text: "auth" }, threads, corrections: [], lessons: [], guardrails: [] })
  assert.deepEqual(run().map((m) => m.id), run().map((m) => m.id))
  assert.equal(jitMatches({ ctx: { text: "auth" }, threads, corrections: [], lessons: [], guardrails: [] }, { max: 1 }).length, 1)
})

test("tool-call extraction is defensive", () => {
  assert.deepEqual(pathsFromToolCall("read", { filePath: "src/a.ts" }), ["src/a.ts"])
  assert.deepEqual(pathsFromToolCall("read", { file: "b.ts" }), ["b.ts"])
  assert.deepEqual(pathsFromToolCall("read", "src/a.ts"), [])
  assert.deepEqual(pathsFromToolCall("read", null), [])
  assert.deepEqual(commandsFromToolCall("bash", { command: "ls -la" }), ["ls -la"])
  assert.deepEqual(commandsFromToolCall("bash", { command: "   " }), [])

  const collected = collectPaths([
    { tool: "read", input: { filePath: "a.ts" } },
    { tool: "bash", input: { command: "ls" } },
    { tool: "read", input: { filePath: "a.ts" } },
  ])
  assert.deepEqual(collected.files, ["a.ts"])
  assert.deepEqual(collected.commands, ["ls"])
})
