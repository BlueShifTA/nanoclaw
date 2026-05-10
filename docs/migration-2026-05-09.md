# v1 → v2 migration log — 2026-05-09 / 2026-05-10

Completed across two sessions. v1 left intact at `/home/armywander/Projects/nanoclaw-v1/` (read-only reference).

## Deterministic side (`migrate-v2.sh`, 2026-05-09 22:42 UTC)

| Step | Status | Notes |
|------|--------|-------|
| 1a-env | ✅ | .env keys merged |
| 1b-db | ✅ | v2.db seeded — 1 agent group, 1 messaging group, 1 wiring |
| 1c-groups | ✅ | `groups/discord_main/` copied; v1 CLAUDE.md → CLAUDE.local.md |
| 1d-sessions | ❌ → ✅ | Failed on EISDIR (uv-cache lib64 symlink). Fixed `setup/migrate-v2/sessions.ts:39` to handle symlinks-to-dirs. Re-run copied 10,368 files. |
| 1e-tasks | ✅ | Scheduled tasks ported |
| 2b-channel-auth | ✅ | Discord auth state copied |
| 2c-install-discord | ❌ → ✅ | Failed on `git fetch origin channels` (this fork has channels on `upstream`, not `origin`). Re-run manually with `upstream/channels`. |
| 3c-auth | ✅ | OneCLI healthy |
| 3e-build | ✅ | Container image built |

## Interactive side (`/migrate-from-v1` skill, 2026-05-10)

| Phase | Status | Notes |
|-------|--------|-------|
| 0a — fix blockers | ✅ | Discord adapter installed, session copy fixed |
| 0b — service switchover & smoke test | ✅ | Service started; round-trip Discord → container → reply confirmed |
| 1 — owner & access policy | ✅ | Owner: `discord:411869224999583746` (Surapat Ek-In). Policy left at `public`. |
| 2 — clean up CLAUDE.local.md | ✅ | No cleanup needed — file is fully customized; no stock template residue. |
| 3 — verify container.json mounts | ✅ | All 9 host paths exist; matches mount-allowlist. |
| 4 — fork triage | ✅ | Wrote `docs/v1-fork-reference.md` — 27 fork commits indexed; 8 features marked for porting (F1–F8). |

## Key fix during migration

**Conversation memory loss diagnosed and fixed.** Root cause: v2's router auto-upgrades wiring `shared` → `per-thread` when the adapter supports threads AND `is_group=1` (`src/router.ts:411`). The migration script created the continuation pointer on the `shared`-mode session (thread_id=NULL); new messages spawned a per-thread session with no pointer. Patched by overwriting `outbound.db.session_state.continuation:claude` on the per-thread session to `ff847f68-0bf5-41d4-8a01-d59d23937441` (v1's last session). Verified with memory-probe test — bot referenced "Three-Lineages historical review (P3-A, 30-iter autoresearch)" from v1 sessions on 2026-05-04 / 2026-05-07.

## Code changes during migration

- `setup/migrate-v2/sessions.ts:39` — `copyTree()` now recreates symlinks instead of `copyFileSync`-ing through them. Was load-bearing for migrating .uv-cache (Python venv with `lib64 -> lib`).

## Outstanding work

1. Service rename: running unit is `nanoclaw.service` (legacy v1 name); v2 expects `nanoclaw-v2-<slug>.service`. Functionally identical, just a name. Run `setup/index.ts --step service` to migrate when convenient.
2. v1 fork ports: see `docs/v1-fork-reference.md` — F1 (uv) through F8 (send_media). Total ~27 h of focused work.
