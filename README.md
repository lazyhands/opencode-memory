# opencode-memory

Durable cross-session memory for [OpenCode](https://opencode.ai) v2. Two scopes — **personality** (cross-project rules and machine facts) and **project** (facts, learnings, guardrails, issue threads) — with deterministic injection, just-in-time recall, auto-captured failures, and an injection audit dashboard in the TUI.

> **Status: in development.** Phase 0 (scaffold + platform spikes) is in progress.
> The full design lives in the approved plan; this README is finalized in the last phase.

## What it does

- **Personality scope** — operating rules and machine/stack facts that should always be on, in every project.
- **Project scope** — this project's durable facts, preferences, decisions, corrections, learnings, and issue threads. Stored in-repo at `.opencode/memory/` so it can be committed and shared with your team (or gitignored to keep private).
- **Enforcement ladder** — always-injected guardrails, just-in-time relevance surfacing, failure coaching, and opt-in hard blocking of known failing calls.
- **Zero-context safety** — failures are captured automatically; multi-turn issues and stale-knowledge corrections resurface when the same files or topics are touched again.
- **Audit** — see exactly what was injected, when, and why (`/memory audit`); the model can self-evaluate with the `memory_audit` tool.

## Install

Once published to the git host:

```sh
opencode plugin add github:DeepakJangra239/opencode-memory          # latest
opencode plugin add github:DeepakJangra239/opencode-memory#v1.0.0   # pinned (recommended)
```

During development, point OpenCode at this repository directly in `opencode.json`:

```jsonc
{
  "plugins": ["/Users/<you>/Dev/ai/plugins/opencode/memory"]
}
```

## Configuration

Three ways, same files: `/memory config` in the TUI, `~/.config/opencode/memory/config.json` (global), or `<project>/.opencode/memory/config.json` (project, wins). Plugin `options` in `opencode.json` act as base defaults. See `config.example.json` for every key and its default.

## Development

Requires Node ≥ 24 (native TypeScript) and OpenCode v2.

```sh
npm install
npm run check   # typecheck
npm test        # unit tests
```

## License

[MIT](./LICENSE)
