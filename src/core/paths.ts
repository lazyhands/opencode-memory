/**
 * Path resolution and file IO for the memory stores (ARC-01 / PAT-05).
 *
 * Resolution is pure — roots come in, paths go out — so tests and callers can
 * override the home/config roots. Reads go through a small mtime+size
 * read-through cache (PERF-02): stores are read on every model call and
 * written rarely. Writes are atomic (temp + rename, DAT-02 single-writer),
 * so readers never observe partial files.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

export interface PathEnv {
  /** Overrides `os.homedir()` (tests). */
  home?: string
  /** Overrides `XDG_CONFIG_HOME` (tests). */
  configHome?: string
}

/** Store file names — single place to look for the on-disk layout. */
export const STORE_FILES = {
  personality: "personality.md",
  project: "project.md",
  learnings: "learnings.md",
  issues: "issues.md",
  guardrails: "guardrails.jsonl",
  audit: "audit.jsonl",
} as const

/** `~/.config/opencode` (XDG-aware). */
export function globalOpencodeDir(env: PathEnv = {}): string {
  const configHome = env.configHome ?? process.env["XDG_CONFIG_HOME"]
  const base = configHome ? resolve(configHome) : join(env.home ?? homedir(), ".config")
  return join(base, "opencode")
}

/** Global memory directory: `~/.config/opencode/memory`. */
export function globalMemoryDir(env: PathEnv = {}): string {
  return join(globalOpencodeDir(env), "memory")
}

/** Project memory directory: `<projectRoot>/.opencode/memory`. */
export function projectMemoryDir(projectRoot: string): string {
  return join(resolve(projectRoot), ".opencode", "memory")
}

// ---------------------------------------------------------------------------
// Project root resolution (worktree-aware)
// ---------------------------------------------------------------------------

const projectRootCache = new Map<string, string>()

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Canonical project root for a working directory.
 *
 * Walks up to the nearest `.git`:
 *   - `.git` directory → that directory is the repo root;
 *   - `.git` file (a git worktree) → parse `gitdir:` and resolve the *main*
 *     worktree root, so all worktrees of one repo share one project memory;
 *   - nothing found → the directory itself (realpath'd).
 *
 * Deterministic and pure modulo the filesystem; cached per directory.
 */
export function canonicalProjectRoot(directory: string): string {
  const resolved = realpathOrSelf(resolve(directory))
  const cached = projectRootCache.get(resolved)
  if (cached !== undefined) return cached
  const root = findProjectRoot(resolved)
  projectRootCache.set(resolved, root)
  return root
}

function findProjectRoot(start: string): string {
  let dir = start
  for (;;) {
    const gitPath = join(dir, ".git")
    let stat: ReturnType<typeof statSync> | null = null
    try {
      stat = statSync(gitPath)
    } catch {
      stat = null
    }
    if (stat?.isDirectory()) return dir
    if (stat?.isFile()) {
      const text = readText(gitPath)
      const match = text?.match(/^gitdir:\s*(.+?)\s*$/m)
      const gitdir = match?.[1] ? realpathOrSelf(resolve(dir, match[1])) : null
      if (gitdir) {
        const worktree = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.exec(gitdir)
        if (worktree?.[1]) return realpathOrSelf(worktree[1])
        if (basename(gitdir) === ".git") return realpathOrSelf(dirname(gitdir))
      }
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** Test/maintenance hook — forget cached project roots. */
export function clearProjectRootCache(): void {
  projectRootCache.clear()
}

export function personalityPath(globalDir: string): string {
  return join(globalDir, STORE_FILES.personality)
}

export function projectEntriesPath(projectDir: string): string {
  return join(projectDir, STORE_FILES.project)
}

export function learningsPath(projectDir: string): string {
  return join(projectDir, STORE_FILES.learnings)
}

export function issuesPath(projectDir: string): string {
  return join(projectDir, STORE_FILES.issues)
}

export function guardrailsPath(projectDir: string): string {
  return join(projectDir, STORE_FILES.guardrails)
}

export function auditPath(projectDir: string): string {
  return join(projectDir, STORE_FILES.audit)
}

/** `config.json` inside any memory directory (global or project). */
export function configPath(memoryDir: string): string {
  return join(memoryDir, "config.json")
}

/** Recovery records live next to the store file they belong to. */
export function recoveryDirFor(storePath: string): string {
  return join(dirname(storePath), "recovery")
}

// ---------------------------------------------------------------------------
// Cached reads + atomic writes
// ---------------------------------------------------------------------------

interface FileCacheEntry {
  mtimeMs: number
  size: number
  text: string
}

const fileCache = new Map<string, FileCacheEntry>()

/** Read a text file, or `null` when missing/unreadable. Cached by mtime+size. */
export function readText(path: string): string | null {
  try {
    const stat = statSync(path)
    const cached = fileCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text
    const text = readFileSync(path, "utf8")
    fileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text })
    return text
  } catch {
    return null
  }
}

/** Write atomically: temp file + rename in the same directory, then drop the read cache. */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, path)
  invalidateReadCache(path)
}

export function invalidateReadCache(path: string): void {
  fileCache.delete(path)
}

/** Test/maintenance hook — forget every cached read. */
export function clearReadCache(): void {
  fileCache.clear()
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** Remove a file if it exists — never throws for a missing file. */
export function removeFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* ignore */
  }
  invalidateReadCache(path)
}

/** File names in a directory; `[]` when the directory does not exist. */
export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
