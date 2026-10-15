/**
 * Shared test fixtures (TST-02). Not a test file itself — imported by the
 * `*.test.ts` files in this directory.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Entry, EntryKind } from "../src/core/store.ts"
import type { Guardrail, Issue, Learning } from "../src/core/learnings.ts"

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-memory-test-"))
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
