# opencode-memory

Durable cross-session memory for [OpenCode](https://opencode.ai) v2. Two scopes — **personality** (cross-project rules and machine facts) and **project** (facts, learnings, guardrails, issue threads) — with deterministic injection, just-in-time recall, auto-captured failures, and an injection audit dashboard in the TUI.

## What it does

- **Personality scope** — operating rules and machine/stack facts that should always be on, in every project. Lives in `~/.config/opencode/memory/`.
- **Project scope** — this project's durable facts, preferences, decisions, corrections, learnings, and issue threads. Stored in-repo at `.opencode/memory/` so it can be committed and shared with your team (or gitignored to keep private).
- **Deterministic injection** — a budget-capped snapshot is built once per turn and injected before every model call: guardrails, corrections, open threads, both scopes, just-in-time material, lessons, and the protocol block. Every section and every truncation is logged (no LLM calls in the hot path).
- **Just-in-time recall** — entries whose files or keywords appear in the conversation surface under `RELEVANT THIS TURN` even when the always-on budget is full.
- **Auto-captured failures** — a failed tool call (thrown error or nonzero exit) is recorded without the model doing anything. Repeats coalesce into a guardrail with an error sample and, once fixed, a verified fix.
- **Enforcement ladder** — `warn` pins a preflight reminder into the next snapshot; `block` rejects a known-failing call before it runs. Genuine success auto-resolves the guardrail; reoccurrence after a fix flips it back to `open` and shows a coach pin.
- **Issue threads** — multi-turn work opens a thread with affected areas; fixes are verified, regressions flip the thread to `regressed`.
- **Audit** — see exactly what was injected, when, and why (`/memory` panel); the model can self-evaluate with the `memory_audit` tool.

## Install

OpenCode installs straight from git — no npm release needed:

```sh
opencode plugin add github:DeepakJangra239/opencode-memory          # latest main
opencode plugin add github:DeepakJangra239/opencode-memory#v0.2.0   # pinned tag (recommended)
opencode plugin list                                                # verify: RPC + TUI active
```

Local development uses the checkout directly in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": [
    { "package": "file:/absolute/path/to/opencode-memory" }
  ]
}
```

The first session in a project creates `.opencode/memory/` with the project stores and a `.gitignore` that hides only the runtime audit log.

## Tools

The model gets nine tools. All are non-throwing: failures come back as typed results, and memory content can never block a session.

| Tool | Purpose |
| --- | --- |
| `memory_set` | Add or replace an entry (`target`, `kind`, `action`, `content`, `old_text`). Enforces routing: project-specific content is rejected from personality. |
| `memory_read` | List entries for a scope, optionally filtered by `kind`. |
| `memory_search` | Recall across entries, lessons, threads, and guardrails (BM25-lite, no LLM). |
| `memory_learn` | Distill a one-line lesson after a success **or** failure. |
| `memory_forget` | Remove an entry (matched by a unique substring); returns a recovery id. |
| `memory_restore` | Restore a forgotten entry by recovery id. |
| `memory_issue` | Open / update / list issue threads with affected areas and a verification command. |
| `memory_status` | Health report: store usage vs caps, lesson/thread/guardrail counts, injection totals, open issues. |
| `memory_audit` | Self-evaluation over the injection log: what was injected, how often, what reoccurred, what to consolidate. |

## TUI

- **Sidebar** — `memory`, scope counters (`P# · J# · L# · G#`), a red dot when unresolved guardrails have reoccurred, and the session injection line (`inj N tok · jit N`).
- **`/memory`** — opens the dashboard panel:
  - `1` Injections — the session's injection timeline with per-section breakdowns and truncation reasons.
  - `2` Effectiveness — guardrail/lesson table: injected ×, reoccurred ×, state, mode, and the recorded fix.
  - `3` Config — every field with its effective value and where the value came from.
  - Keys: `1`/`2`/`3` tabs · `↑`/`↓` or `j`/`k` select · `b` toggle the selected guardrail between warn/block and inherit · `r` refresh · `f` fullscreen · `esc` close.
- **`/memory config [path]`** — guided editor: pick a field (searchable) → edit the value → choose project or global scope. Equivalent to editing the JSON files by hand.
- **`/memory status`**, **`/memory audit`**, **`/memory injections`** — quick toasts and tab jumps.

## Guardrails

1. **Capture** — every failing tool call is fingerprinted (tool + normalized arguments) and recorded; repeats increment a counter and keep the newest error sample.
2. **Distill** — when the same failure reoccurs with a fix applied, the guardrail becomes `resolved` with `errorSample` and `fix`.
3. **Preflight** — before each tool call, open guardrails matching tool + arguments are ranked (exact match, resolved fix, frequency). `warn` pins a reminder into the next injection; `block` rejects the call outright (the session continues; only that call fails).
4. **Auto-resolve** — a genuine success on a matching call resolves the guardrail.

Modes are per guardrail (`warn` / `block` / `inherit`) with the global default in `guardrails.mode`. Start with `warn` — it changes nothing about execution. Toggle the selected guardrail in the dashboard with `b`, or via `memory_issue`/config.

## Configuration

Resolution order (first wins): project `<project>/.opencode/memory/config.json` → global `~/.config/opencode/memory/config.json` → this plugin's `options` in `opencode.json` → built-in defaults. `config.example.json` lists every key with its default (a drift test keeps it exact).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `personalityCharLimit` | int | 1500 | Total char cap for personality entries. |
| `projectCharLimit` | int | 4000 | Total char cap for project entries. |
| `perEntryCharLimit` | int | 180 | Max chars for a single entry. |
| `maxEntryLines` | int | 3 | Max lines for a single entry. |
| `maxInjectChars` | int | 2400 | Budget for the injected snapshot per turn. |
| `jit` | bool | true | Just-in-time surfacing of entries matching the conversation. |
| `learnings.maxIndexTitles` | int | 12 | Lesson titles listed in the snapshot index. |
| `capture.toolErrors` | bool | true | Auto-capture failing tool calls. |
| `capture.ignoreTools` | string[] | `[]` | Tools never captured (in addition to built-ins). |
| `capture.maxRecords` | int | 200 | Cap for captured records. |
| `guardrails.mode` | string | `"warn"` | Global enforcement mode: `warn` or `block`. |
| `autoDistillOnCompact` | bool | false | Prompt a distillation pass when the context compacts. |
| `audit.enabled` | bool | true | Write the injection audit log. |
| `audit.retentionDays` | int | 30 | Audit retention window. |
| `protocol` | string | `"full"` | Protocol block verbosity injected into snapshots: `full`, `short`, or `off`. |

## Files

Project scope (`<project>/.opencode/memory/`): `project.md`, `learnings.md`, `issues.md`, `guardrails.jsonl`, `config.json`, and `audit.jsonl` (runtime log, auto-gitignored); forgotten entries are kept under `recovery/`. The personality scope lives in `~/.config/opencode/memory/` (`personality.md`, `config.json`). All writes are atomic (temp + rename), reads are cached by mtime — safe across concurrent sessions.

## Troubleshooting

- **Edited the plugin source and nothing changed** — while most config directories hot-reload, arbitrary paths do not: run `opencode service restart` (or restart the TUI). `opencode plugin list` shows whether the plugin is active and which entry points resolved.
- **RPC methods look "unknown" or the sidebar shows `unavailable`** — a stale server generation is still running: `opencode service restart`.
- **Two checkouts fight each other** — remove one entry from the `plugins` array in `opencode.json`; a global config entry and the git-installed spec both register the same plugin id.
- **Worktrees** — a linked `git worktree` resolves to the main worktree root, so all worktrees of a repository share one project memory (by design).
- **Too noisy** — set `guardrails.mode` to `inherit` and toggle individual guardrails, or raise `maxInjectChars`.

## Development

Requires Node ≥ 24 (native TypeScript) and OpenCode v2.

```sh
npm install
npm run check   # typecheck (tsc --noEmit)
npm test        # unit tests (node --test)
```

CI runs both on every push. The package ships TypeScript as-is (loaded natively by OpenCode and Node ≥ 24) with pinned `@opencode/plugin` internals for the server/TUI adapters; the `src/core/` domain layer is pure and platform-free.

## License

[MIT](./LICENSE)
