import { test } from "node:test"
import assert from "node:assert/strict"
import {
  canResolveWith,
  errorText,
  jaccard,
  matchGuardrail,
  normalizeCall,
  normalizeVolatile,
  signatureFor,
  stableStringify,
  tokenSet,
} from "../src/core/signature.ts"
import { guardrail } from "./helpers.ts"

test("normalizeVolatile strips volatile fragments across sessions", () => {
  const a = normalizeVolatile(
    "error: Cannot find module '/Users/dev/app/node_modules/x.js' at line 42 (code 0x1f, resolve df14af8abcdef, 2026-10-15T10:00:00Z, took 120ms)",
  )
  const b = normalizeVolatile(
    "error: Cannot find module '/Users/other/app/node_modules/x.js' at line 99 (code 0x2a, resolve 7fd13acffffff, 2026-11-01T22:11:00Z, took 850ms)",
  )
  assert.equal(a, b)
  assert.ok(a.includes("<str>"))
  assert.ok(a.includes("<n>"))
  assert.ok(!a.includes("/Users/"))
})

test("normalizeCall masks home and temp path prefixes", () => {
  const abs = normalizeCall("edit", { filePath: "/Users/someone/Dev/app/src/x.ts" })
  assert.equal(abs.display, "<home>/Dev/app/src/x.ts")
  assert.ok(!abs.fingerprint.includes("someone"))

  // Plain-string input: the fingerprint fully collapses volatile absolute
  // paths (normalizeVolatile), and the display keeps the masked tail.
  const tmpString = normalizeCall("read", "/private/var/folders/ab/cdef12/T/opencode/x.txt")
  assert.equal(tmpString.fingerprint, "<path>")
  assert.equal(tmpString.display, "<tmp>/opencode/x.txt")

  // Path-shaped inputs keep the meaningful tail in the fingerprint too.
  const tmpPath = normalizeCall("read", { filePath: "/private/var/folders/ab/cdef12/T/opencode/x.txt" })
  assert.equal(tmpPath.fingerprint, "<tmp>/opencode/x.txt")

  const command = normalizeCall("bash", { command: "cd /Users/someone/app && npm test" })
  assert.equal(command.display, "cd <home>/app && npm test")

  const generic = normalizeCall("mystery", { seed: "/home/someone/secret.txt" })
  assert.ok(!generic.display.includes("someone"))
})

test("signatureFor is stable for the same failure", () => {
  const first = signatureFor("bash", { command: "npm test" }, "sh: npm: command not found (session 12345)")
  const second = signatureFor("bash", { command: "npm test" }, "sh: npm: command not found (session 99999)")
  assert.equal(first.sig, second.sig)
  assert.equal(first.fingerprint, "npm test")
  assert.equal(first.tool, "bash")
})

test("normalizeCall: commands, paths, and content-collapsed generic input", () => {
  assert.deepEqual(normalizeCall("bash", { command: "  bun   test  " }), { fingerprint: "bun test", display: "bun test" })
  assert.equal(normalizeCall("edit", { filePath: "src/a.ts", oldString: "x".repeat(200), newString: "y".repeat(200) }).fingerprint, "src/a.ts")
  assert.equal(normalizeCall("read", "src/b.ts").fingerprint, "src/b.ts")
  const generic = normalizeCall("mystery", { alpha: 1, beta: "x".repeat(100) })
  assert.equal(generic.fingerprint, stableStringify({ alpha: 1, beta: "x".repeat(100) }))
})

test("stableStringify sorts keys and collapses long strings", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ content: "x".repeat(100) }), '{"content":"<100 chars>"}')
})

test("matchGuardrail: exact, similar, unrelated, wrong tool", () => {
  const record = guardrail({ tool: "bash", fingerprint: "npm test" })
  assert.deepEqual(matchGuardrail(record, { tool: "bash", input: { command: "npm test" } }), { match: true, exact: true, score: 1 })
  const similar = matchGuardrail(record, { tool: "bash", input: { command: "npm test --watch" } })
  assert.equal(similar.match, true)
  assert.equal(similar.exact, false)
  assert.equal(matchGuardrail(record, { tool: "bash", input: { command: "npm install" } }).match, false)
  assert.equal(matchGuardrail(record, { tool: "edit", input: { command: "npm test" } }).match, false)
})

test("canResolveWith: same tool, different input solved it", () => {
  const record = guardrail({ tool: "bash", fingerprint: "npm test" })
  assert.equal(canResolveWith(record, { tool: "bash", input: { command: "bun test" } }), true)
  assert.equal(canResolveWith(record, { tool: "bash", input: { command: "npm test" } }), false)
  assert.equal(canResolveWith(record, { tool: "read", input: { filePath: "a.ts" } }), false)
})

test("jaccard + tokenSet basics", () => {
  assert.equal(jaccard(tokenSet("npm test"), tokenSet("npm test")), 1)
  assert.equal(jaccard(tokenSet("npm test"), tokenSet("npm run test")), 2 / 3)
  assert.equal(jaccard(tokenSet(""), tokenSet("npm")), 0)
})

test("errorText handles strings, errors, objects", () => {
  assert.equal(errorText("boom"), "boom")
  assert.equal(errorText(new Error("boom")), "boom")
  assert.equal(errorText({ code: 1 }), '{"code":1}')
})
