import { test } from "node:test"
import assert from "node:assert/strict"
import { searchDocs, tokenize } from "../src/core/search.ts"

test("tokenize lowercases and drops single chars", () => {
  assert.deepEqual(tokenize("Fix the AUTH redirect-loop!"), ["fix", "the", "auth", "redirect", "loop"])
})

test("search ranks docs matching more query terms first", () => {
  const docs = [
    { name: "a", text: "login redirect loop in the auth module" },
    { name: "b", text: "database migration notes" },
    { name: "c", text: "auth tokens expire after 24h" },
  ]
  const hits = searchDocs(docs, "auth redirect", 5)
  assert.equal(hits[0]?.name, "a")
  assert.equal(hits.length, 2)
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0))
})

test("search returns nothing for empty queries or docs", () => {
  assert.deepEqual(searchDocs([], "auth", 5), [])
  assert.deepEqual(searchDocs([{ name: "a", text: "auth" }], "", 5), [])
  assert.deepEqual(searchDocs([{ name: "a", text: "auth" }], "nomatch", 5), [])
})

test("search snippets center on the first match", () => {
  const body = `${"prefix ".repeat(30)}auth redirect here ${"suffix ".repeat(30)}`
  const hits = searchDocs([{ name: "big", text: body }], "auth", 1)
  const snippet = hits[0]?.snippet ?? ""
  assert.ok(snippet.includes("auth redirect here"))
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"))
})

test("search respects the limit", () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, text: "auth tokens" }))
  assert.equal(searchDocs(docs, "auth", 3).length, 3)
})
