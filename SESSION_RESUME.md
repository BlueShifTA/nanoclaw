# Session resume — nanoclaw v1→v2 + fork ports

**Session label:** `nanoclaw-v2-port-2026-05-10`
**Claude Code session ID:** `178f85b3-77ba-446a-baf7-96816c6077d3`
**Working dir:** `/home/armywander/Projects/nanoclaw`
**Branch:** `migrate-v2`
**Paused:** 2026-05-10

## How to resume

From a terminal in this repo:

```bash
claude --resume 178f85b3-77ba-446a-baf7-96816c6077d3
```

Or interactively, run `claude --resume` and pick `178f85b3...` from the list (it's the most recent).

Once Claude reattaches, just say "continue" — it'll have the full conversation context (including this doc, the queue below, and what F1–F3 already touched).

There's also a one-liner alias if you want it on your shell:

```bash
alias resume-nanoclaw='claude --resume 178f85b3-77ba-446a-baf7-96816c6077d3'
```

## What's done

- Migration finished (Phases 0–4 of `/migrate-from-v1`). Bot routes Discord, replies with v1 memory intact (`continuation:claude=ff847f68-0bf5-41d4-8a01-d59d23937441`).
- **F1 uv** — pinned to 0.11.11 in container Dockerfile.
- **F2 codex CLI** — pinned to 0.128.0; `~/.codex/auth.json` mounted; `NO_PROXY` default in container env.
- **F3 gh CLI + OneCLI** — installed gh 2.92.0 in Dockerfile; `GH_TOKEN=gho_dummy` default; OneCLI agent `79eec2d8-cc6a-4b5b-aae2-afb40459842a` flipped to `mode=all`. Verified via Discord: `gh api user` returns `BlueShifTA`.
- **F4 RTK** (2026-05-10, commit 15dd5a3) — host RTK config mount + container path. Binary stays on persistent volume.
- **F5 Serena + Context7 MCP** (2026-05-10, commit 972cf48) — Dockerfile installs `serena` via uv tool (UV_TOOL_BIN_DIR=/usr/local/bin) and `context7-mcp@2.2.4` via pnpm. Smoke-tested in `nanoclaw-agent-v2-8d820e2c:latest`. Per-group registration is via container.json `mcpServers`.
- **F6 QMD container MCP** (2026-05-10) — Dockerfile installs `@tobilu/qmd@2.1.0` via pnpm (better-sqlite3 added to build-script allowlist). Symlinks `/home/armywander/{Projects,.cache,.config}` → `/workspace/extra/{vault,armlab,altruistic,qmd-cache,qmd-config}` so the host index's stored paths resolve inside the container; `/home/node/.{cache,config}/qmd` symlinked through to the same. Host `~/.cache/qmd` + `~/.config/qmd` mounted RO via container.json. MCP stdio handshake verified: `query`, `get`, `multi_get`, `status` tools exposed; 888 docs (wiki/armlab/altruistic). Path stub bakes the `armywander` username — fork-specific.

## What's pending — F7

F8 (send_media MCP tool) is **superseded** — v2 ships `mcp__nanoclaw__send_file` (`container/agent-runner/src/mcp-tools/core.ts:135`) with outbox staging (`src/delivery.ts:351`) and chat-sdk-bridge file upload (`src/channels/chat-sdk-bridge.ts:492-505`). Channel-agnostic and multi-destination; covers all v1 send_media behaviour except the explicit 25MB pre-check (deferred to adapter). No direct unit test for send_file — only indirect coverage via outbox/delivery integration. Optional follow-ups: add 25MB pre-check + dedicated unit test, rename `mcp__nanoclaw__send_media` mention in `groups/discord_main/CLAUDE.local.md`, OR add a `send_media` alias in core.ts.


Each is a separate task-run, sequential, with TDD where it makes sense. Pick up by reading `docs/v1-fork-reference.md` (full index) and starting the next one.

| # | Feature | Touches | Est | Notes for next session |
|---|---------|---------|-----|------------------------|
| F7 | Session commands `/ping /kill /reset /last /btw` + drift detection | host-only: `src/command-gate.ts` + new handlers + tests | 6h | TDD-friendly. v2 only has `/compact` today. |

Total remaining ≈ 6h.

## Key state references

| What | Where |
|------|-------|
| v1 fork commit index | `docs/v1-fork-reference.md` |
| Migration log | `docs/migration-2026-05-09.md` |
| v1 (read-only) | `~/Projects/nanoclaw-v1/` |
| Owner | `discord:411869224999583746` (Surapat Ek-In) |
| OneCLI agent for v2 group | id `79eec2d8-cc6a-4b5b-aae2-afb40459842a`, identifier `ag-1778359154253-avycjw`, mode=all |
| GitHub vault secret id | `0ccfb06d-b10a-435b-bf19-bfc579f8c5f3` |
| Bot Discord identity | `ArmyThinkBook` (app id `1483587024257679362`) |
| Service unit | `nanoclaw.service` (legacy v1 name; bot runs from v2 path; rename to `nanoclaw-v2-<slug>.service` is a low-priority follow-up) |

## Code touched on the migration branch (uncommitted)

```
M  setup/migrate-v2/sessions.ts        — symlink-handling fix for copyTree (load-bearing)
M  container/Dockerfile                — uv 0.11.11, codex 0.128.0, gh 2.92.0
M  src/container-runner.ts             — codex auth mount, NO_PROXY default, GH_TOKEN default
A  docs/v1-fork-reference.md           — fork commit index
A  docs/migration-2026-05-09.md        — migration log
A  SESSION_RESUME.md                   — this file
```

Commit before next port — clean history per F-series feature.
