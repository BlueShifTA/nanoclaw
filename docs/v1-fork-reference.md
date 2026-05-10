# v1 Fork Reference

Generated 2026-05-10 during v1→v2 migration finishing.

This document indexes every customization on the v1 fork (`/home/armywander/Projects/nanoclaw-v1/`) that diverged from `qwibitai/nanoclaw` upstream — 42 commits ahead of `upstream/main`, of which 27 are non-merge customization commits.

For each commit, this doc records:
- **Files touched** in the v1 tree
- **What feature it added**
- **v2 status**: `superseded` (already provided by trunk or an `/add-*` skill), `port` (we want this in v2 — needs work), or `drop` (v1-specific tooling no longer relevant)
- **Edge cases** to be aware of when porting

---

## Summary table

| # | SHA | Subject | v2 status | Port priority |
|---|-----|---------|-----------|---------------|
| 1 | 66aa3e4 | skill/discord: Discord channel integration | **superseded** (`/add-discord` skill, installed during migration) | — |
| 2 | 77624a1 | ci: add upstream sync and merge-forward workflow | **superseded** (`/update-nanoclaw` skill) | — |
| 3 | 27e10c2 | ci: rename sync workflow | **superseded** | — |
| 4 | 8c5b584 | ci: remove old merge-forward-skills.yml | **superseded** | — |
| 5 | b5091c7 | fix: sync condition checks repo name | **superseded** | — |
| 6 | f98ff59 | fix: repair escaped newlines in fork-sync workflow | **superseded** | — |
| 7 | ab51a2b | fix: GitHub App token for fork-sync | **superseded** | — |
| 8 | da146b3 | fix: re-fetch before skill branch merges | **superseded** | — |
| 9 | c30b248 | fix: concurrency group for fork-sync | **superseded** | — |
| 10 | 853737f | docs: token count badge | **drop** (cosmetic) | — |
| 11 | ba9353c | chore: bump to v1.2.14 | **drop** (v1-only) | — |
| 12 | 7aa2b5e | feat: media attachment support for Discord | **port** | **HIGH** — explicit user ask |
| 13 | ab20c61 | feat: session commands `/ping /kill /reset /compact /last /btw` + drift detection | **port** (v2 only has `/compact`) | **HIGH** — explicit user ask |
| 14 | 296ad61 | feat: wire media + session commands into orchestrator | **port** (depends on 12+13) | **HIGH** |
| 15 | 872412a | chore: gitignore CLAUDE.local.md | **superseded** (v2 native) | — |
| 16 | 9576e62 | style: prettier on discord+ipc | **drop** (cosmetic) | — |
| 17 | cdf2b37 | feat: load CLAUDE.local.md into agent system prompt | **superseded** (v2 native — see `Migrated groups to CLAUDE.local.md model` in startup log) | — |
| 18 | 77bb330 | add uv | **port** | **HIGH** — explicit user ask |
| 19 | 13e8b41 | feat: codex CLI in container + host auth mount | **superseded** (`/add-codex` skill exists; not yet installed) | install skill |
| 20 | c8612ee | style: prettier on container-runner | **drop** (cosmetic) | — |
| 21 | 2ee8000 | feat: rtk + codeburn + karpathy-guidelines | **partial** — karpathy-guidelines already migrated; rtk + codeburn need port | **HIGH** (rtk only) |
| 22 | 1ee63d3 | feat: GitHub access via gh CLI + OneCLI vault | **port** | **HIGH** — explicit user ask |
| 23 | d257cdf | chore: expand `.gitignore` secret patterns | **port** (low effort) | LOW |
| 24 | 23c55d7 | feat: Serena + Context7 MCP servers | **partial** — Context7 already loaded for host Claude; both need wiring inside container | **HIGH** — explicit user ask |
| 25 | f1ae8b0 | feat: QMD semantic search across host + container with GPU passthrough | **partial** — QMD MCP server already loaded for host Claude; v2 has `upstream/skill/qmd` branch; container-side + GPU not yet ported | **HIGH** — explicit user ask |
| 26 | 378710c | style: prettier reformat tests | **drop** (cosmetic) | — |
| 27 | 82d8abb | docs(brain): teach agent about ArmLabVault, librarian, qmd | **superseded** — equivalent content already in `groups/discord_main/CLAUDE.local.md` | — |

**Result:** 17 superseded/dropped, **8 commits to port** representing **6 distinct features**.

---

## Detail: features that need to be ported to v2

### F1. uv in container Dockerfile (commit 77bb330)
**v1 file:** `container/Dockerfile` — added `uv` install line.
**Why we need it:** Python tooling under the agent uses `uv` for fast venv/pkg management. The v1 `.uv-cache` directory we migrated has a Python venv built with uv.
**Port plan:** Add equivalent line in `container/Dockerfile` of v2. Pin version. Check `pnpm` global-install pattern v2 already uses for Node CLIs (CLAUDE.md "Adding a Node CLI" gotcha). For uv this is a curl-based install — keep as is.
**Edge cases:**
- Image-build cache: any Dockerfile change forces a rebuild (`./container/build.sh`).
- v2 uses `minimumReleaseAge: 4320` for npm; uv install is curl-based and outside that policy — fine.
**Estimated effort:** 30 min including rebuild.

### F2. Codex CLI install in container (commit 13e8b41)
**v1 files:** `container/Dockerfile` + `src/container-runner.ts` (mount host auth).
**Why we need it:** Reviewer agent (④ in your 8-agent org) runs Codex CLI for adversarial code review.
**v2 superseded by:** `/add-codex` skill is shipped in v2 trunk (`.claude/skills/add-codex/SKILL.md` exists).
**Port plan:** Run `/add-codex` skill — no manual port needed. Skill copies provider module from `upstream/providers` branch and wires container.
**Edge cases:**
- The `/add-codex` skill is for using Codex as agent provider (per its description). Your v1 use was Codex as a *CLI tool inside the Claude container*. Need to confirm whether `/add-codex` covers the CLI install or only the provider switch. If only provider, port the Dockerfile install line manually.
**Estimated effort:** 1 hour to install + verify CLI is callable from inside the container.

### F3. gh CLI + OneCLI vault injection (commit 1ee63d3)
**v1 files:** `container/Dockerfile` + `src/container-runner.ts`.
**Why we need it:** Container agent runs git operations against private repos using a GitHub token from OneCLI.
**v2 superseded by:** OneCLI vault is native in v2. The `gh` CLI install + per-request token injection is not.
**Port plan:**
1. Add `gh` install line to v2 `container/Dockerfile` (debian package, follow CLAUDE.md "Adding a Node CLI" pattern but for apt).
2. Verify OneCLI `host_pattern` for `api.github.com` exists in vault; if not, register a secret with that pattern and `selective`-mode bypass instructions in CLAUDE.md gotcha section.
3. Confirm that v2's existing OneCLI proxy handles `api.github.com` requests transparently — `gh` should "just work" once it picks the proxy CA cert.
**Edge cases:**
- OneCLI agent secret-mode gotcha (CLAUDE.md): newly-created agent groups start in `selective` mode. After install, run `onecli agents set-secret-mode --id <agent-id> --mode all` (or assign GitHub secret explicitly).
- `gh auth login` flow: must NOT prompt — must read token from env var (`GH_TOKEN`) which is what OneCLI proxy injects.
**Estimated effort:** 2 hours including OneCLI vault setup + container rebuild + verification (`gh repo view` from inside the container).

### F4. RTK token-saving CLI (subset of commit 2ee8000)
**v1 files:** `container/Dockerfile` + `~/.bashrc` + `~/.profile` + `settings.json` PreToolUse hook (the `karpathy-guidelines` part of this commit is already migrated as a container skill).
**Why we need it:** RTK transparently rewrites Bash tool calls (e.g., `git status` → `rtk git status`) to compress output, saving 60-90% tokens on dev workflows. Documented in user's global RTK.md memory.
**v2 superseded by:** Nothing — RTK is a v1-fork-specific addition.
**Port plan:**
1. Install RTK binary into container at `/workspace/extra/armlab/bin/rtk` (already on persistent volume per Session 2026-04-17T10-56-52 memory).
2. Add PATH export to container `.bashrc` BEFORE the non-interactive guard (memory note: this was the load-bearing fix).
3. Wire PreToolUse hook in v2's container settings.json equivalent.
**Edge cases:**
- The user's RTK install path is already persistent (`/workspace/extra/armlab/bin/rtk`) — survives container rebuilds.
- Hook failure mode: if rtk hook is wired but binary not on PATH, **all** Bash calls fail with exit 127. Critical to test.
- v2's container settings.json model may differ from v1 — need to inspect where v2 stores per-container hooks.
**Estimated effort:** 2 hours, mostly verification because the binary is already on disk.

### F5. Serena + Context7 MCP servers in container (commit 23c55d7)
**v1 files:** `container/Dockerfile` + `container/agent-runner/src/index.ts` + `container/skills/capabilities/SKILL.md` + `groups/main/CLAUDE.md`.
**Why we need it:** Serena is symbol-aware code navigation (60-90% read savings). Context7 fetches current library docs.
**v2 superseded by:** Context7 is loaded **for the host Claude Code session** (per session start). Inside the per-agent container, neither is wired.
**Port plan:**
1. Install Serena via `pip` in container Dockerfile (it's a Python MCP server). Pin version.
2. Register both as MCP servers in `container/agent-runner/src/mcp-tools/index.ts` (or wherever v2 declares container-side MCP servers).
3. Update `container/skills/capabilities/SKILL.md` to mention them.
**Edge cases:**
- Container MCP server lifecycle: v2 container architecture may differ; double-check that MCP server processes are spawned per-session and cleaned up on container exit.
- Serena needs symlinks to the project tree to read source — confirm mount layout still matches.
**Estimated effort:** 3 hours (Dockerfile + MCP wiring + smoke test).

### F6. QMD semantic search with GPU passthrough (commit f1ae8b0)
**v1 files:** 12 — Dockerfile, container/agent-runner/src/index.ts, container/agents/librarian.md, scripts/probe-qmd-pipeline.ts, scripts/probe-vault-mounts.ts, scripts/warm-qmd-container-cache.ts, src/container-runner.ts, src/container-runner.test.ts, src/container-runtime.test.ts.
**Why we need it:** QMD provides BM25 + vector search over the wiki corpus (888 docs, 132 wiki + 612 armlab + 144 altruistic). Backbone of the librarian sub-agent.
**v2 superseded by:**
- QMD MCP server is loaded **for the host Claude Code session** (per session start: `qmd` server, `mcp__qmd__*` tools available).
- `upstream/skill/qmd` branch exists — there is likely an `/add-qmd` style skill.
- Container-side QMD + GPU passthrough not yet wired.
**Port plan:**
1. **First**: check `upstream/skill/qmd` — if it covers container-side install + GPU, just install via that skill.
2. If not, port the v1 work:
   - Dockerfile: add QMD install + CUDA/ROCm libs as needed.
   - container-runner.ts: add `--device` flags for GPU passthrough (Docker `--gpus` for NVIDIA, `--device=/dev/dri` for Intel/AMD ROCm).
   - container/agent-runner/src/index.ts: register QMD MCP server in container-side MCP-server table.
   - librarian.md sub-agent: already migrated via `.claude-shared/agents/`.
   - `scripts/probe-qmd-pipeline.ts`, `probe-vault-mounts.ts`, `warm-qmd-container-cache.ts`: port if useful for diagnostics; otherwise drop.
3. Verify QMD index location: v1 used `/home/armywander/.config/nanoclaw/qmd-cache` (already mounted in v2 `container.json`).
**Edge cases:**
- GPU detection: this machine — verify with `nvidia-smi` or `lspci | grep -i vga` whether GPU passthrough is wanted at all.
- Qmd-cache permissions: container runs as non-root user; bind mount must be writeable by that uid.
- The `qmd-cache` mount is already in `container.json:additionalMounts` — good.
**Estimated effort:** 4 hours assuming `upstream/skill/qmd` covers half the work; 8 hours if porting from scratch.

### F7. Session commands `/ping /kill /reset /last /btw` + drift detection (commits ab20c61 + 296ad61)
**v1 files:** `src/config.ts`, `src/db.ts`, `src/drift-state.ts`, `src/group-queue.ts`, `src/session-commands.test.ts`, `src/index.ts`.
**Why we need it:**
- `/ping` — health check
- `/kill` — force-stop running container
- `/reset` — clear continuation, start fresh session
- `/last` — show last interaction
- `/btw` — append context to current session without triggering reply
- Drift detection — auto-detect when conversation has drifted off-topic and propose split

**v2 superseded by:** Only `/compact` is in v2's admin commands set.
**Port plan:**
1. Locate v2's command-gate.ts: `src/command-gate.ts` already has the `ADMIN_COMMANDS` set. Add the missing commands.
2. Implement handlers — these go in the host (not the container) because they manipulate session state, not chat content. Look at how `/compact` is wired and follow the pattern.
3. `/reset` writes a row to `outbound.db.session_state.continuation:claude` deletion (clear the resume pointer).
4. `/kill` calls `docker stop <containerName>` for the session's running container.
5. `/ping` writes a fixed reply directly to `messages_out` without spawning a container.
6. Drift detection — port from v1 `src/drift-state.ts`. Consult journal at `data/drift-state.json`.
7. Add tests using vitest (host side) — check existing v2 test patterns.

**Edge cases:**
- v2 uses `user_roles` for command gate (CLAUDE.md). Ensure all commands respect `canAccessAgentGroup`.
- `/reset` must clear the per-session `outbound.db.session_state` AND optionally kill the running container so the next message starts truly fresh.
- v2's session DB layout differs from v1's monolithic `messages.db`. Port references must use `outbound.db` / `inbound.db` properly.
**Estimated effort:** 6 hours including TDD tests.

### F8. Discord media attachment support (commits 7aa2b5e + 296ad61)
**v1 files:** `container/agent-runner/src/ipc-mcp-stdio.ts`, `src/channels/discord.ts`, `src/container-runner.ts`, `src/ipc.ts`, `src/router.ts`, `src/types.ts`.
**Why we need it:** `mcp__nanoclaw__send_media` MCP tool — agent sends PDFs/images/videos directly to Discord. Heavily used by your deck/video workflows.
**v2 superseded by:** Nothing — v2 has no `send_media` MCP tool yet.
**Port plan:**
1. v1 used IPC for media transfer. v2 has no IPC — must use the outbound DB instead.
2. Extend `messages_out` to accept media attachments (probably already supports `fileCount` field per host log line "fileCount=undefined").
3. Add MCP tool `send_media(file_path, filename?, caption?)` in `container/agent-runner/src/mcp-tools/`. Tool writes message to `messages_out` with attachment metadata + path inside container.
4. Host delivery: extend `src/delivery.ts` to read attachment metadata, copy file out of container's mounted outbox, send via Discord adapter.
5. Discord adapter (`src/channels/discord.ts`): use `@chat-adapter/discord`'s media-send API.
6. 25 MB limit per Discord — enforce in MCP tool.

**Edge cases:**
- Discord file limits depend on server boost level (8/50/100 MB). Default 25 MB is safe.
- Container/outbox file paths: agent writes to `/workspace/.../outbox/`, host reads via mount. Make sure path is in `container.json:additionalMounts` already.
- Path traversal protection: validate `file_path` is inside `/workspace/` before reading.
- Other channels (Slack, Telegram, etc.): port `send_media` so it works channel-agnostically. Channel adapters declare `supportsMedia: true/false`.

**Estimated effort:** 8 hours (MCP tool + DB schema bump + delivery wire + adapter call + tests).

---

## Already migrated (no action needed)

| Item | Where it lives in v2 | Notes |
|------|----------------------|-------|
| `karpathy-guidelines` container skill | `container/skills/karpathy-guidelines/SKILL.md` | Copied during migration |
| `librarian` sub-agent | `data/v2-sessions/ag-1778359154253-avycjw/.claude-shared/agents/librarian.md` | Migrated via `.claude-shared/` |
| `capabilities`, `status`, `agent-browser`, `slack-formatting` container skills | `container/skills/<name>/` | All present |
| Discord channel | `src/channels/discord.ts` + `@chat-adapter/discord@4.26.0` | Installed via `/add-discord` |
| Group `CLAUDE.local.md` model | Native in v2 | Auto-loaded; we saw `Migrated groups to CLAUDE.local.md model` in startup log |
| Mounts (ArmLab, Altruistic, Vault, wiki-framework, etc.) | `groups/discord_main/container.json` | All 9 host paths verified |

## Dropped

| Item | Reason |
|------|--------|
| Fork-sync GitHub workflows (8 commits) | v2 uses `/update-nanoclaw` skill instead |
| Token-count badge | Cosmetic |
| Prettier reformats (3 commits) | Cosmetic / merge-noise |

---

## Source-level files preserved as reference

If you want to read the v1 implementation while porting:

| Feature | v1 file(s) |
|---------|-----------|
| Session commands | `nanoclaw-v1/src/session-commands.test.ts` (covers full behavior) |
| Drift detection | `nanoclaw-v1/src/drift-state.ts` |
| Discord media IPC | `nanoclaw-v1/src/ipc.ts` + `nanoclaw-v1/container/agent-runner/src/ipc-mcp-stdio.ts` |
| QMD probes | `nanoclaw-v1/scripts/probe-qmd-pipeline.ts`, `probe-vault-mounts.ts`, `warm-qmd-container-cache.ts` |
| RTK setup | Memory: `~/.claude/RTK.md`, plus journal `Session 2026-04-17T10-56-52` |

The v1 tree at `/home/armywander/Projects/nanoclaw-v1/` is read-only reference. Do not modify.

---

## Recommended port order (lowest risk → highest value)

1. **F1 uv** (30 min) — single Dockerfile line. Unblocks Python tools.
2. **F2 codex CLI** (1h) — runs `/add-codex` skill. Unblocks reviewer agent.
3. **F3 gh CLI** (2h) — Dockerfile + OneCLI. Unblocks git ops in container.
4. **F4 RTK** (2h) — binary already exists; just hook wiring.
5. **F7 session commands** (6h) — TDD-friendly host-only changes; no container rebuild needed.
6. **F8 send_media** (8h) — touches DB schema + delivery + adapter.
7. **F5 Serena+Context7 MCP** (3h) — container MCP wiring.
8. **F6 QMD** (4-8h) — last because depends on `upstream/skill/qmd` branch state.

Total: 26.5–30.5 hours of focused work.
