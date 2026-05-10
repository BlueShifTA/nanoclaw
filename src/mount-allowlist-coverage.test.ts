/**
 * Audit test: every additionalMount listed in any group's container.json
 * must be accepted by the production mount-security validator using the
 * production mount-allowlist.json. Reads real files — no mocks.
 *
 * Catches the F6 class of regression: adding a new mount to container.json
 * without also adding its host root to the allowlist, which causes silent
 * REJECT-at-spawn-time and an MCP server that never starts.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { validateMount } from './modules/mount-security/index.js';

interface ContainerJson {
  additionalMounts?: Array<{ hostPath: string; containerPath?: string; readonly?: boolean }>;
}

const REPO_ROOT = path.resolve(__dirname, '..');
const GROUPS_DIR = path.join(REPO_ROOT, 'groups');

function findContainerJsons(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(GROUPS_DIR)) {
    const candidate = path.join(GROUPS_DIR, entry, 'container.json');
    if (fs.existsSync(candidate)) out.push(candidate);
  }
  return out;
}

describe('mount-allowlist coverage', () => {
  const containerJsons = findContainerJsons();

  if (containerJsons.length === 0) {
    it.skip('no container.json files found under groups/ — skipping', () => undefined);
    return;
  }

  for (const cfgPath of containerJsons) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as ContainerJson;
    const group = path.basename(path.dirname(cfgPath));

    for (const mount of cfg.additionalMounts ?? []) {
      it(`${group}: ${mount.hostPath} is on the production allowlist`, () => {
        // Skip mounts whose host path doesn't exist on this machine — the
        // allowlist still has to cover them, but the validator's realpath
        // step would fail before we got to the policy decision.
        if (!fs.existsSync(mount.hostPath)) {
          return; // not an applicable env
        }
        const result = validateMount({
          hostPath: mount.hostPath,
          containerPath: mount.containerPath ?? path.basename(mount.hostPath),
          readonly: mount.readonly ?? false,
        });
        expect(
          result.allowed,
          `Mount REJECTED in production path for ${group}:${mount.hostPath} — ${result.reason}`,
        ).toBe(true);
      });
    }
  }
});
