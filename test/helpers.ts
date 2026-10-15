/**
 * Shared test fixtures (TST-02). Not a test file itself — imported by the
 * `*.test.ts` files in this directory.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "../src/runtime.ts"
import type { MemoryRuntime } from "../src/runtime.ts"
import { serializeLearnings, serializeIssues } from "../src/core/learnings.ts"
import { serializeEntries } from "../src/core/store.ts"
import type { Entry, EntryKind } from "../src/core/store.ts"
import type { Guardrail, Issue, Learning } from "../src/core/learnings.ts"

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-memory-test-"))
}

/** Server runtime on an isolated temp workspace (project + global dirs). */
export interface ServerFixture {
  runtime: MemoryRuntime
  /** Raw (not realpath'd) project directory — what `resolveDirectory` returns. */
  root: string
  projectRoot: string
  projectDir: string
  globalDir: string
  events: { event: string; data: Record<string, unknown> }[]
}

export function makeServerFixture(options?: Record<string, unknown>): ServerFixture {
  const base = makeTmpDir()
  const root = join(base, "project")
  mkdirSync(root, { recursive: true })
  const configHome = join(base, "config")
  const projectRoot = realpathSync(root)
  const projectDir = join(projectRoot, ".opencode", "memory")
  const globalDir = join(configHome, "opencode", "memory")
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(globalDir, { recursive: true })
  const events: ServerFixture["events"] = []
  const runtime = createRuntime({
    options,
    resolveDirectory: async () => root,
    env: { configHome },
    emit: (event, data) => {
      events.push({ event, data })
    },
  })
  return { runtime, root, projectRoot, projectDir, globalDir, events }
}

/** Write one personality rule, two project entries, one lesson and one fixed thread. */
export function seedStores(fixture: ServerFixture): void {
  writeFileSync(
    join(fixture.globalDir, "personality.md"),
    serializeEntries([entry("rule", "Always run tests before claiming done")], "personality"),
  )
  writeFileSync(
    join(fixture.projectDir, "project.md"),
    serializeEntries(
      [entry("fact", "The API base URL is http://localhost:3000"), entry("decision", "Use SQLite for local caching")],
      "project",
    ),
  )
  writeFileSync(
    join(fixture.projectDir, "learnings.md"),
    serializeLearnings([lesson("failure", "npm test fails in this repo", "Use bun test instead — there is no npm test script")]),
  )
  writeFileSync(
    join(fixture.projectDir, "issues.md"),
    serializeIssues([
      issue({
        id: "i2",
        title: "Auth token refresh order",
        status: "fixed",
        areas: ["src/auth/**"],
        notes: [{ at: "2026-10-10", status: "fixed", text: "refresh must run before retry" }],
      }),
    ]),
  )
}

export function entry(kind: EntryKind, text: string): Entry {
  return { kind, text }
}

export function lesson(outcome: "success" | "failure", title: string, content: string): Learning {
  return { outcome, title, content }
}

export function guardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    id: "g1",
    sig: "bash::npm test::command not found",
    tool: "bash",
    fingerprint: "npm test",
    errorSample: "command not found: <n>",
    count: 1,
    firstSeen: "2026-10-01T00:00:00.000Z",
    lastSeen: "2026-10-01T00:00:00.000Z",
    sessions: [],
    state: "open",
    mode: "inherit",
    ...overrides,
  }
}

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    title: "Login redirect loop",
    status: "open",
    areas: ["src/auth/**"],
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
    regressions: 0,
    notes: [],
    ...overrides,
  }
}
