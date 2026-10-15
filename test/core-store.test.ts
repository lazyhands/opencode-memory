import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  addEntry,
  charCount,
  displayEntry,
  findUniqueIndex,
  normalizeEntryContent,
  parseEntries,
  readEntries,
  readRecovery,
  removeEntry,
  replaceEntry,
  resolveKind,
  routingLint,
  serializeEntries,
  validateRouting,
  writeEntries,
  writeRecovery,
  deleteRecovery,
} from "../src/core/store.ts"
import { hasCode } from "../src/core/errors.ts"
import { entry, makeTmpDir } from "./helpers.ts"

const LIMITS = { perEntryCharLimit: 180, maxEntryLines: 3 }

test("parse/serialize round-trips canonical entries", () => {
  const entries = [entry("fact", "The API base URL is http://localhost:3000"), entry("pref", "Prefer bun over npm")]
  const text = serializeEntries(entries, "project")
  assert.deepEqual(parseEntries(text, "project"), entries)
})

test("parse preserves unknown tags and canonicalizes untagged bullets", () => {
  const parsed = parseEntries("- [weird] something\n- plain bullet", "project")
  assert.equal(parsed[0]?.kind, "unknown")
  assert.equal(parsed[0]?.text, "[weird] something")
  assert.equal(parsed[1]?.kind, "fact")
  // parse(serialize(parse(x))) is stable
  const rewritten = serializeEntries(parsed, "project")
  assert.deepEqual(parseEntries(rewritten, "project"), parsed)
})

test("multi-line entries survive round-trips", () => {
  const entries = [entry("decision", "Use SQLite for sessions\nbecause V2 has no list API")]
  const parsed = parseEntries(serializeEntries(entries, "project"), "project")
  assert.deepEqual(parsed, entries)
})

test("display and charCount count the canonical form", () => {
  const e = entry("rule", "Always research before working")
  assert.equal(displayEntry(e), "[rule] Always research before working")
  assert.equal(charCount([e]), displayEntry(e).length)
})

test("validate: empty, too many lines, too long", () => {
  assert.throws(() => normalizeEntryContent("   ", LIMITS), (error) => hasCode(error, "invalid_content"))
  assert.throws(() => normalizeEntryContent("a\nb\nc\nd", LIMITS), (error) => hasCode(error, "too_many_lines"))
  assert.throws(() => normalizeEntryContent("x".repeat(181), LIMITS), (error) => hasCode(error, "entry_too_long"))
  assert.equal(normalizeEntryContent("  ok \n", LIMITS), "ok")
})

test("addEntry rejects duplicates and overflows with a full entry list", () => {
  const first = addEntry([], entry("fact", "one"), 100)
  assert.equal(first.duplicate, false)
  const duplicate = addEntry(first.entries, entry("fact", "one"), 100)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.entries.length, 1)

  try {
    addEntry([entry("fact", "x".repeat(30))], entry("fact", "y".repeat(30)), 50)
    assert.fail("expected overflow")
  } catch (error) {
    assert.ok(hasCode(error, "overflow"))
    const detail = (error as { detail: { used: number; cap: number; entries: string[] } }).detail
    assert.equal(detail.cap, 50)
    assert.ok(detail.entries.length === 2)
  }
})

test("replaceEntry: unique match replaces, ambiguous and missing throw", () => {
  const entries = [entry("fact", "login uses cookies"), entry("pref", "login page dark mode"), entry("fact", "deploy on friday")]
  const result = replaceEntry(entries, "deploy on friday", "deploy on monday", 1000)
  assert.equal(result.index, 2)
  assert.equal(result.entries[2]?.text, "deploy on monday")

  assert.throws(() => replaceEntry(entries, "login", "x", 1000), (error) => hasCode(error, "ambiguous_match"))
  assert.throws(() => replaceEntry(entries, "missing", "x", 1000), (error) => hasCode(error, "not_found"))

  // replace keeps the previous kind unless overridden
  const kept = replaceEntry(entries, "deploy on friday", "deploy on monday", 1000)
  assert.equal(kept.entries[2]?.kind, "fact")
})

test("removeEntry removes by unique substring and reports the removed entry", () => {
  const entries = [entry("fact", "one"), entry("fact", "two")]
  const result = removeEntry(entries, "two")
  assert.equal(result.removed.text, "two")
  assert.deepEqual(result.entries.map((e) => e.text), ["one"])
  assert.throws(() => removeEntry(entries, "nope"), (error) => hasCode(error, "not_found"))
})

test("findUniqueIndex reports match positions on ambiguity", () => {
  const entries = [entry("fact", "alpha"), entry("fact", "alpha beta")]
  try {
    findUniqueIndex(entries, "alpha")
    assert.fail("expected ambiguous_match")
  } catch (error) {
    assert.ok(hasCode(error, "ambiguous_match"))
    assert.deepEqual((error as { detail: { matches: number[] } }).detail.matches, [1, 2])
  }
})

test("kind resolution enforces scope", () => {
  assert.equal(resolveKind("project", undefined), "fact")
  assert.equal(resolveKind("personality", undefined), "rule")
  assert.equal(resolveKind("project", "correction"), "correction")
  assert.throws(() => resolveKind("personality", "fact"), (error) => hasCode(error, "invalid_kind"))
  assert.throws(() => resolveKind("project", "unknown"), (error) => hasCode(error, "invalid_kind"))
  assert.equal(resolveKind("personality", "machine"), "machine")
})

test("routing: personality writes reject project-specific content", () => {
  assert.throws(
    () => validateRouting({ scope: "personality", kind: "rule", content: "deploy opencode-memory via tags", projectTerms: ["opencode-memory"] }),
    (error) => hasCode(error, "routing_violation"),
  )
  // project scope is unconstrained
  validateRouting({ scope: "project", kind: "fact", content: "opencode-memory is the repo", projectTerms: ["opencode-memory"] })
  // short terms are ignored (noise)
  validateRouting({ scope: "personality", kind: "rule", content: "use api tokens", projectTerms: ["ab"] })
})

test("routingLint flags suspected misplacements", () => {
  const personality = [entry("rule", "Always run the myapp-memory tests first")]
  const project = [entry("fact", "Always deploy on friday"), entry("fact", "bun works → keep using it"), entry("correction", "webclient: use WebClient.builder()")]
  const lint = routingLint(personality, project, ["myapp"])
  assert.equal(lint.length, 4)
  assert.match(lint[0]?.suggestion ?? "", /move to target=project/)
  assert.match(lint[1]?.suggestion ?? "", /personality/)
  assert.match(lint[2]?.suggestion ?? "", /memory_learn/)
  assert.match(lint[3]?.suggestion ?? "", /wrong:/)
})

test("store IO round-trips through real files and invalidates the cache", () => {
  const dir = makeTmpDir()
  const path = `${dir}/project.md`
  writeEntries(path, [entry("fact", "first")], "project")
  assert.deepEqual(readEntries(path, "project").map((e) => e.text), ["first"])
  writeEntries(path, [entry("fact", "second")], "project")
  assert.deepEqual(readEntries(path, "project").map((e) => e.text), ["second"])
  const raw = readFileSync(path, "utf8")
  assert.match(raw, /type: project/)
})

test("recovery records round-trip; malformed ids are rejected", () => {
  const dir = `${makeTmpDir()}/recovery`
  const id = writeRecovery(dir, { target: "project", removed: ["gone"], at: "2026-10-01T00:00:00.000Z", reason: "stale" })
  assert.match(id, /^r[0-9a-z]+-[0-9a-z]{4}$/)
  const record = readRecovery(dir, id)
  assert.deepEqual(record?.removed, ["gone"])
  assert.equal(readRecovery(dir, "../../etc/passwd"), null)
  deleteRecovery(dir, id)
  assert.equal(readRecovery(dir, id), null)
})
