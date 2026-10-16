import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_FIELD_PATHS, DEFAULT_CONFIG, loadConfig } from "../src/core/config.ts"
import { makeTmpDir } from "./helpers.ts"

test("config.example.json documents exactly the defaults", () => {
  const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"))
  assert.deepEqual(example, DEFAULT_CONFIG)
})

test("layered precedence: plugin options < global < project", () => {
  const dir = makeTmpDir()
  const globalPath = join(dir, "global.json")
  const projectPath = join(dir, "project.json")
  writeFileSync(globalPath, JSON.stringify({ maxInjectChars: 5000, guardrails: { mode: "block" } }))
  writeFileSync(projectPath, JSON.stringify({ maxInjectChars: 6000 }))

  const loaded = loadConfig({ options: { maxInjectChars: 3000, personalityCharLimit: 900 }, globalPath, projectPath })
  assert.equal(loaded.config.maxInjectChars, 6000, "project wins")
  assert.equal(loaded.config.personalityCharLimit, 900, "plugin options apply where files are silent")
  assert.equal(loaded.config.guardrails.mode, "block", "nested fields merge per leaf")
  assert.equal(loaded.sources.maxInjectChars, projectPath)
  assert.equal(loaded.sources.personalityCharLimit, "plugin options")
  assert.equal(loaded.sources.projectCharLimit, "default")
  assert.equal(loaded.warnings.length, 0)
})

test("invalid values keep the previous layer and warn", () => {
  const dir = makeTmpDir()
  const globalPath = join(dir, "global.json")
  writeFileSync(globalPath, JSON.stringify({ maxInjectChars: "huge", jit: "yes", protocol: "verbose", tui: { sidebar: "tiny" } }))
  const loaded = loadConfig({ options: { maxInjectChars: 3000, jit: false }, globalPath })
  assert.equal(loaded.config.maxInjectChars, 3000)
  assert.equal(loaded.config.jit, false)
  assert.equal(loaded.config.protocol, "full")
  assert.equal(loaded.config.tui.sidebar, "compact")
  assert.equal(loaded.sources.maxInjectChars, "plugin options")
  assert.equal(loaded.warnings.filter((w) => w.includes("invalid_config")).length, 4)
})

test("malformed JSON skips only that layer", () => {
  const dir = makeTmpDir()
  const globalPath = join(dir, "global.json")
  const projectPath = join(dir, "project.json")
  writeFileSync(globalPath, "{ not json")
  writeFileSync(projectPath, JSON.stringify({ maxInjectChars: 1234 }))
  const loaded = loadConfig({ globalPath, projectPath })
  assert.equal(loaded.config.maxInjectChars, 1234)
  assert.ok(loaded.warnings.some((w) => w.includes("malformed JSON")))
})

test("non-object layers and unknown keys are ignored", () => {
  const loaded = loadConfig({ options: [] as unknown as Record<string, unknown> })
  assert.deepEqual(loaded.config, DEFAULT_CONFIG)
  assert.ok(loaded.warnings.some((w) => w.includes("not a JSON object")))

  const unknown = loadConfig({ options: { futureKey: true } })
  assert.deepEqual(unknown.config, DEFAULT_CONFIG)
  assert.equal(unknown.warnings.length, 0)
})

test("every field is tracked and validated", () => {
  assert.equal(CONFIG_FIELD_PATHS.length, 16)
  const sources = loadConfig({ options: { capture: { ignoreTools: ["write"] } } })
  assert.equal(sources.sources["capture.ignoreTools"], "plugin options")
  assert.deepEqual(sources.config.capture.ignoreTools, ["write"])
})
