import { test } from "node:test"
import assert from "node:assert/strict"
import { displayValue, editableValue, parseFieldText } from "../src/tui-rpc.ts"

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
