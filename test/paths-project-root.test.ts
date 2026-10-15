import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalProjectRoot, clearProjectRootCache } from "../src/core/paths.ts"
import { makeTmpDir } from "./helpers.ts"

test("plain directory resolves to itself (realpath'd)", () => {
  const dir = makeTmpDir()
  assert.equal(canonicalProjectRoot(dir), realpathSync(dir))
})

test("a .git directory marks the repo root from any subdirectory", () => {
  const root = makeTmpDir()
  mkdirSync(join(root, ".git"))
  const nested = join(root, "src", "deep", "nest")
  mkdirSync(nested, { recursive: true })
  assert.equal(canonicalProjectRoot(root), realpathSync(root))
  assert.equal(canonicalProjectRoot(nested), realpathSync(root))
})

test("a worktree .git file resolves to the main worktree root", () => {
  const main = makeTmpDir()
  const gitdir = join(main, ".git")
  mkdirSync(join(gitdir, "worktrees", "feature"), { recursive: true })
  const worktree = join(makeTmpDir(), "wt")
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(gitdir, "worktrees", "feature")}\n`)
  assert.equal(canonicalProjectRoot(worktree), realpathSync(main))
})

test("a nested repo wins over the outer repo", () => {
  const outer = makeTmpDir()
  mkdirSync(join(outer, ".git"))
  const inner = join(outer, "vendor", "lib")
  mkdirSync(join(inner, ".git"), { recursive: true })
  assert.equal(canonicalProjectRoot(inner), realpathSync(inner))
})

test("directories without any .git resolve to themselves", () => {
  const dir = makeTmpDir()
  const deeper = join(dir, "a", "b", "c")
  mkdirSync(deeper, { recursive: true })
  assert.equal(canonicalProjectRoot(deeper), realpathSync(deeper))
})

test("cache is cleared without changing results", () => {
  const dir = makeTmpDir()
  const first = canonicalProjectRoot(dir)
  clearProjectRootCache()
  assert.equal(canonicalProjectRoot(dir), first)
})

test("a real git worktree resolves to the main worktree root", () => {
  const base = makeTmpDir()
  const main = join(base, "main")
  mkdirSync(main, { recursive: true })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", main, "-c", "commit.gpgsign=false", ...args], { stdio: "pipe", env })
  }
  git("init", "-q")
  git("-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-qm", "init")
  const worktree = join(base, "wt")
  git("worktree", "add", "-q", "--detach", worktree)

  clearProjectRootCache()
  assert.equal(canonicalProjectRoot(worktree), realpathSync(main))

  const nested = join(worktree, "src", "nested")
  mkdirSync(nested, { recursive: true })
  assert.equal(canonicalProjectRoot(nested), realpathSync(main))

  // The main worktree still resolves to itself.
  clearProjectRootCache()
  assert.equal(canonicalProjectRoot(main), realpathSync(main))
})
