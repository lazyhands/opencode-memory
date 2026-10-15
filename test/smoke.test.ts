import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"

const root = new URL("../", import.meta.url)

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, root), "utf8")) as Record<string, unknown>
}

test("package exports point at existing files", () => {
  const pkg = readJson("package.json")
  const exports = pkg["exports"] as Record<string, string>
  for (const [key, target] of Object.entries(exports)) {
    assert.ok(existsSync(new URL(target, root)), `export "${key}" -> ${target} must exist`)
  }
})

test("config.example.json parses and carries documented defaults", () => {
  const config = readJson("config.example.json")
  assert.equal((config["guardrails"] as Record<string, unknown>)["mode"], "warn")
  assert.equal(config["protocol"], "full")
  assert.equal(config["jit"], true)
  assert.equal(config["perEntryCharLimit"], 180)
})
