import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  activeIssues,
  appendLearningText,
  capGuardrails,
  dismissGuardrail,
  findIssue,
  learningTitles,
  lessonRef,
  nextGuardrailId,
  nextIssueId,
  normalizeLearning,
  openIssue,
  parseGuardrails,
  parseIssues,
  parseLearnings,
  readGuardrails,
  readIssues,
  readLearnings,
  regressionWatchIssues,
  resolveGuardrail,
  serializeGuardrails,
  serializeIssues,
  setGuardrailMode,
  updateIssue,
  upsertGuardrail,
  writeGuardrails,
  writeIssues,
  writeLearnings,
} from "../src/core/learnings.ts"
import { hasCode } from "../src/core/errors.ts"
import { guardrail, issue, lesson, makeTmpDir } from "./helpers.ts"

// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

test("learnings append/parse/titles round-trip", () => {
  const first = appendLearningText(null, lesson("failure", "npm test is wrong here", "The repo uses bun test."))
  const second = appendLearningText(first, lesson("success", "Bun test is fast", "Ran bun test --watch."))
  const parsed = parseLearnings(second)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]?.outcome, "failure")
  assert.equal(parsed[0]?.content, "The repo uses bun test.")
  assert.deepEqual(learningTitles(parsed), ["npm test is wrong here", "Bun test is fast"])
})

test("learnings validation enforces caps", () => {
  assert.throws(() => normalizeLearning(lesson("success", "  ", "x")), (e) => hasCode(e, "invalid_content"))
  assert.throws(() => normalizeLearning(lesson("success", "t", " ")), (e) => hasCode(e, "invalid_content"))
  assert.throws(() => normalizeLearning(lesson("success", "x".repeat(81), "y")), (e) => hasCode(e, "entry_too_long"))
  assert.throws(() => normalizeLearning(lesson("success", "t", "a\nb\nc\nd")), (e) => hasCode(e, "too_many_lines"))
  assert.throws(() => normalizeLearning(lesson("success", "t", "x".repeat(241))), (e) => hasCode(e, "entry_too_long"))
})

test("learnings file round-trip", () => {
  const path = join(makeTmpDir(), "learnings.md")
  writeLearnings(path, [lesson("failure", "A", "one line")])
  assert.equal(readLearnings(path).length, 1)
})

test("lesson refs are stable", () => {
  const a = lessonRef(lesson("success", "Same title", "x"))
  const b = lessonRef(lesson("success", "Same title", "different content"))
  assert.equal(a, b)
  assert.match(a, /^l:[0-9a-f]{8}$/)
})

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

test("guardrail upsert: new record, dedupe by sig, reoccur after resolve", () => {
  const observation = { tool: "bash", sig: "bash::npm test::not found", fingerprint: "npm test", errorSample: "not found", sessionID: "s1" }
  const created = upsertGuardrail([], observation, "2026-10-01T00:00:00.000Z")
  assert.equal(created.isNew, true)
  assert.equal(created.record.id, "g1")
  assert.equal(created.record.state, "open")

  const again = upsertGuardrail(created.records, observation, "2026-10-02T00:00:00.000Z")
  assert.equal(again.isNew, false)
  assert.equal(again.record.count, 2)
  assert.deepEqual(again.record.sessions, ["s1"])
  assert.equal(again.reoccurred, false)

  const resolved = resolveGuardrail(again.records, "g1", { input: "bun test" }, "2026-10-03T00:00:00.000Z")
  assert.equal(resolved.record.state, "resolved")

  const reoccurred = upsertGuardrail(resolved.records, observation, "2026-10-04T00:00:00.000Z")
  assert.equal(reoccurred.reoccurred, true)
  assert.equal(reoccurred.record.state, "open")
  assert.equal(reoccurred.record.fix?.input, "bun test")

  const dismissed = dismissGuardrail(reoccurred.records, "g1", "2026-10-05T00:00:00.000Z")
  assert.equal(dismissed.record.state, "dismissed")
  const afterDismiss = upsertGuardrail(dismissed.records, observation, "2026-10-06T00:00:00.000Z")
  assert.equal(afterDismiss.record.state, "dismissed", "dismissed stays dismissed")
  assert.equal(afterDismiss.reoccurred, false)
})

test("guardrail transitions and mode changes are validated", () => {
  const open = [guardrail({ state: "open" })]
  const dismissed = dismissGuardrail(open, "g1", "now")
  assert.throws(() => dismissGuardrail(dismissed.records, "g1", "now"), (e) => hasCode(e, "invalid_status"))
  assert.throws(() => resolveGuardrail([], "g1", { input: "x" }, "now"), (e) => hasCode(e, "not_found"))

  const block = setGuardrailMode(open, "g1", "block")
  assert.equal(block.record.mode, "block")
  assert.throws(() => setGuardrailMode(open, "g1", "nope" as never), (e) => hasCode(e, "invalid_config"))
})

test("capGuardrails evicts dismissed, then resolved, then oldest open", () => {
  const records = [
    guardrail({ id: "g1", lastSeen: "2026-10-01", state: "open" }),
    guardrail({ id: "g2", lastSeen: "2026-10-02", state: "resolved" }),
    guardrail({ id: "g3", lastSeen: "2026-10-03", state: "dismissed" }),
    guardrail({ id: "g4", lastSeen: "2026-10-04", state: "open" }),
  ]
  const capped = capGuardrails(records, 2)
  assert.deepEqual(capped.map((r) => r.id), ["g1", "g4"])
})

test("guardrails file round-trip tolerates malformed lines", () => {
  const dir = makeTmpDir()
  const path = join(dir, "guardrails.jsonl")
  writeGuardrails(path, [guardrail(), guardrail({ id: "g2" })])
  assert.equal(readGuardrails(path).length, 2)
  writeFileSync(path, "not json\n" + serializeGuardrails([guardrail()]))
  assert.equal(readGuardrails(path).length, 1)
  assert.equal(parseGuardrails(null).length, 0)
})

test("guardrail ids increment", () => {
  assert.equal(nextGuardrailId([]), "g1")
  assert.equal(nextGuardrailId([guardrail({ id: "g7" })]), "g8")
})

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

test("issues parse/serialize round-trip with notes and verifyWith", () => {
  const issues = [
    issue({
      id: "i2",
      title: "Login redirect loop",
      status: "fixed",
      areas: ["src/auth/**", "auth"],
      createdAt: "2026-10-01",
      updatedAt: "2026-10-03",
      regressions: 1,
      verifyWith: "bun test test/auth",
      notes: [
        { at: "2026-10-01", status: "open", text: "root cause X" },
        { at: "2026-10-03", status: "fixed", text: "guarded Z" },
      ],
    }),
  ]
  assert.deepEqual(parseIssues(serializeIssues(issues)), issues)
})

test("openIssue validates and assigns ids", () => {
  const opened = openIssue([], { title: "First", areas: ["src/**"], note: "start" }, "2026-10-01")
  assert.equal(opened.issue.id, "i1")
  assert.equal(opened.issue.status, "open")
  assert.equal(opened.issue.notes.length, 1)

  const second = openIssue(opened.issues, { title: "Second", areas: ["auth"] }, "2026-10-02")
  assert.equal(second.issue.id, "i2")
  assert.equal(nextIssueId(second.issues), "i3")

  assert.throws(() => openIssue([], { title: "x", areas: [] }, "now"), (e) => hasCode(e, "invalid_content"))
  assert.throws(() => openIssue([], { title: "x".repeat(101), areas: ["a"] }, "now"), (e) => hasCode(e, "entry_too_long"))
  assert.throws(
    () => openIssue([], { title: "x", areas: ["a"], note: "n".repeat(241) }, "now"),
    (e) => hasCode(e, "entry_too_long"),
  )
})

test("issue transitions are enforced and regressions counted", () => {
  const opened = openIssue([], { title: "Bug", areas: ["src/**"] }, "2026-10-01")
  assert.throws(
    () => updateIssue(opened.issues, "i1", { status: "regressed" }, "2026-10-02"),
    (e) => hasCode(e, "invalid_status"),
  )

  const fixed = updateIssue(opened.issues, "#i1", { status: "fixed", note: "guarded Z", verifyWith: "bun test" }, "2026-10-03")
  assert.equal(fixed.issue.status, "fixed")
  assert.equal(fixed.issue.verifyWith, "bun test")

  const regressed = updateIssue(fixed.issues, "i1", { status: "regressed", note: "Z came back" }, "2026-10-04")
  assert.equal(regressed.regressed, true)
  assert.equal(regressed.issue.regressions, 1)

  const reopened = updateIssue(updateIssue(regressed.issues, "i1", { status: "closed" }, "2026-10-05").issues, "i1", { status: "open" }, "2026-10-06")
  assert.equal(reopened.issue.status, "open")

  assert.throws(() => updateIssue(opened.issues, "i9", {}, "now"), (e) => hasCode(e, "not_found"))
  assert.equal(findIssue(opened.issues, "#i1")?.title, "Bug")
})

test("issue filters + file round-trip", () => {
  const issues = [
    issue({ id: "i1", status: "open" }),
    issue({ id: "i2", status: "fixed" }),
    issue({ id: "i3", status: "regressed" }),
    issue({ id: "i4", status: "closed" }),
  ]
  assert.deepEqual(activeIssues(issues).map((i) => i.id), ["i1", "i3"])
  assert.deepEqual(regressionWatchIssues(issues).map((i) => i.id), ["i2", "i4"])

  const path = join(makeTmpDir(), "issues.md")
  writeIssues(path, issues)
  assert.deepEqual(readIssues(path).map((i) => i.id), ["i1", "i2", "i3", "i4"])
})
