# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.2.3] — 2026-10-16

### Added

- **Tag-triggered releases** — pushing a `vX.Y.Z` tag runs checks and tests, verifies the version pins match the tag (`package.json`, `MEMORY_VERSION` in `src/index.ts`), and publishes a GitHub release using the matching changelog section as notes.

### Fixed

- **`/memory config` no longer opens the memory panel behind the editor** — the panel (injection log, config rows, footer hints) popping up uninvited read as "a second broken sidebar". The guided dialog chain now runs on its own; the panel opens only when you ask for it (`/memory`).
- **Editor dialogs can no longer have their keystrokes stolen by the panel keymap** — prompts refused `1`/`2`/`3` (bound to panel tabs) whenever the panel was open, so values like `2500` couldn't be typed. The keymap now stands down while a config dialog (picker, value prompt, scope select) is open.

### Security

- **Clean dependency audit** — the peer-pinned `solid-js@1.9.12` resolves `seroval@1.5.x`, which has two critical advisories with no in-range fix; an npm `overrides` entry now forces the patched `seroval`/`seroval-plugins` 1.6.9. `npm audit` reports zero vulnerabilities.

## [0.2.2] — 2026-10-16

### Fixed

- **Config picker dialog no longer renders config-file paths** — the long `footer` (e.g. `/private/var/folders/.../config.json`) wrapped over several lines and shoved the field list around. Rows now read `field · description · value · source` with a short source label (`default`, `plugin`, `global`, `project`), right-aligned.
- **Sidebar lines shortened so they can't wrap in narrow sidebars** — `6 memories · 2 recalled` (was `… · 2 recalled just now`), and full mode drops zero scopes: `3 project · 2 lessons` / `4 guardrails · 2 recalled · 436 tok` (was a 43-char line that wrapped at real sidebar widths).

### Changed

- The scope dialog (global vs project) now preselects the layer the field's value currently comes from, and the dashboard Config tab shows sources as `source: project` instead of a truncated path.

## [0.2.1] — 2026-10-16

### Changed

- **Sidebar redone for comprehension** — instead of cryptic counters (`P0 · J2 · L2 · G2`, `inj 436 tok · jit 2`) it now reads as plain language: `6 memories · 2 recalled just now`, with a red `● N guardrails failing again` attention line only when something needs attention, and `nothing remembered yet` as the empty state. The detailed counters remain available via the new `full` mode.
- **New config field `tui.sidebar`** (`compact` | `full` | `off`) — choose sidebar verbosity; the guided config editor offers the three values with descriptions.
- **Spelled-out totals** — the `/memory status` toast and the dashboard totals row no longer use `inj`/`fail`/`P-J-L-G` abbreviations (`9 injections · 2 failures · 1 fix · …`).
- Enum pickers in the config editor now explain each value (`block — reject matching calls before they run`).

## [0.2.0] — 2026-10-16

First release.

### Added

- **Two-scope memory** — personality (cross-project rules and machine facts) and project (facts, preferences, decisions, corrections) with the `memory_set`, `memory_read`, `memory_search`, `memory_learn`, `memory_forget`, and `memory_restore` tools. Routing validation keeps project-specific content out of personality.
- **Deterministic injection** — a turn-stable, budget-capped snapshot (guardrails → corrections → threads → personality → project → JIT → lessons → protocol) rebuilt only when the turn, config, or stores change. No LLM calls in the hot path; every section and truncation is logged.
- **Just-in-time recall** — entries matching conversation files or keywords surface under `RELEVANT THIS TURN` even when the always-on budget is full.
- **Automatic failure capture** — failing tool calls (thrown errors and nonzero exits) are fingerprinted and recorded without model cooperation; repeats coalesce into guardrails with error samples and verified fixes.
- **Enforcement ladder** — preflight matching ranks guardrails (exact / resolved fix / frequency); `warn` pins a reminder, `block` rejects the call; genuine success auto-resolves; post-fix reoccurrence flips guardrails to `regressed` with a coach pin.
- **Issue threads** — multi-turn work tracked with affected areas and verification commands (`memory_issue`), including `regressed` transitions.
- **Audit** — append-only injection log with retention pruning, per-entry effectiveness tracking, and self-evaluation via `memory_audit` / `memory_status`.
- **TUI integration** — sidebar counters (`P# · J# · L# · G#`) with a reoccurrence dot and session injection line; the `/memory` dashboard panel (injection timeline, effectiveness table, config view); guided `/memory config` editor; `b` toggles a guardrail between warn/block and inherit.
- **Config** — project and global JSON files overriding plugin `options` catching the defaults; 15-field catalog with validation, per-field `sources`, and `config.example.json` kept exact by a drift test.
- **Hygiene** — atomic writes, mtime-cached reads, in-repo project memory with an auto-seeded `.gitignore` hiding only the runtime audit log, recovery records for forgotten entries, and git-worktree-aware project root resolution.

## [0.1.0] — 2026-10-15

### Added

- Project scaffold: package layout, `memory` RPC contract, server plugin entry, TUI plugin entry (sidebar slot + `/memory` command).
