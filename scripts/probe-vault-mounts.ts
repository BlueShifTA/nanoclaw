/**
 * Probe script: validate the vault + wiki + librarian pipeline.
 *
 * 1. Loads the mount allowlist and validates the new ArmLabVault and obsidian-wiki paths.
 * 2. Forces a sync of container/skills/ and container/agents/ into the
 *    discord_main session directory by invoking the same logic the runtime uses.
 *    (Done inline here to avoid coupling to private exports.)
 * 3. Spawns a one-shot docker container with the same mount layout the
 *    runtime would use, and runs `ls /workspace/extra/vault` plus a couple
 *    of sanity checks. Prints results.
 *
 * Run: npx tsx scripts/probe-vault-mounts.ts
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { validateMount } from '../src/mount-security.js';
import { CONTAINER_IMAGE, DATA_DIR } from '../src/config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from '../src/container-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Match the actual discord_main containerConfig — readonly:false is what the
// DB stores, so the probe should validate the same shape.
const PROBE_MOUNTS = [
  {
    hostPath: '/home/armywander/Projects/ArmLabVault',
    containerPath: 'vault',
    readonly: false,
  },
  {
    hostPath: '/home/armywander/Projects/obsidian-wiki',
    containerPath: 'wiki-framework',
    readonly: false,
  },
];

function ok(msg: string) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}
function fail(msg: string) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
}
function info(msg: string) {
  console.log(`  ${msg}`);
}

function step1_validateAllowlist() {
  console.log('\n[1/3] Validating mount allowlist…');
  for (const m of PROBE_MOUNTS) {
    const result = validateMount(m, true);
    if (result.allowed) {
      ok(`${m.hostPath} → ${result.resolvedContainerPath} (rw=${!result.effectiveReadonly})`);
    } else {
      fail(`${m.hostPath} REJECTED: ${result.reason}`);
      process.exit(1);
    }
  }
}

function step2_syncAgents() {
  console.log('\n[2/3] Syncing container/agents/ into discord_main session…');

  const sessionsRoot = path.join(DATA_DIR, 'sessions', 'discord_main', '.claude');
  const agentsSrc = path.join(PROJECT_ROOT, 'container', 'agents');
  const agentsDst = path.join(sessionsRoot, 'agents');

  if (!fs.existsSync(agentsSrc)) {
    fail(`Source missing: ${agentsSrc}`);
    process.exit(1);
  }

  fs.mkdirSync(agentsDst, { recursive: true });
  for (const entry of fs.readdirSync(agentsSrc)) {
    const srcPath = path.join(agentsSrc, entry);
    const dstPath = path.join(agentsDst, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      fs.cpSync(srcPath, dstPath, { recursive: true });
    } else if (entry.endsWith('.md')) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }

  const synced = fs.readdirSync(agentsDst);
  if (!synced.includes('librarian.md')) {
    fail(`librarian.md not synced. Got: ${synced.join(', ')}`);
    process.exit(1);
  }
  ok(`librarian.md present at ${agentsDst}/librarian.md (size=${fs.statSync(path.join(agentsDst, 'librarian.md')).size})`);
}

function step3_dockerProbe() {
  console.log('\n[3/3] Docker probe with vault + wiki mounts…');

  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    `nanoclaw-probe-${Date.now()}`,
    ...hostGatewayArgs(),
    '-v',
    `${PROBE_MOUNTS[0].hostPath}:/workspace/extra/vault`,
    '-v',
    `${PROBE_MOUNTS[1].hostPath}:/workspace/extra/wiki-framework`,
    '-v',
    `${path.join(DATA_DIR, 'sessions', 'discord_main', '.claude')}:/home/node/.claude:ro`,
    '--entrypoint',
    '/bin/bash',
    CONTAINER_IMAGE,
    '-c',
    `
      set -e
      echo '--- vault contents ---'
      ls /workspace/extra/vault | head -20
      echo
      echo '--- vault hot.md exists ---'
      test -f /workspace/extra/vault/hot.md && echo OK
      echo
      echo '--- wiki framework skills ---'
      ls /workspace/extra/wiki-framework/.skills | head -10
      echo
      echo '--- wiki-query SKILL.md exists ---'
      test -f /workspace/extra/wiki-framework/.skills/wiki-query/SKILL.md && echo OK
      echo
      echo '--- librarian agent visible in container ---'
      test -f /home/node/.claude/agents/librarian.md && echo OK
      head -3 /home/node/.claude/agents/librarian.md
      echo
      echo '--- vault is writable from container? ---'
      probe="/workspace/extra/vault/.nanoclaw-probe-$(date +%s)"
      if touch "$probe" 2>/dev/null; then
        echo OK_writable
        rm -f "$probe"
      else
        echo NOT_writable
      fi
    `,
  ];

  const result = spawnSync(CONTAINER_RUNTIME_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    fail(`Docker probe exited ${result.status}`);
    info(result.stderr);
    process.exit(1);
  }

  console.log(result.stdout);

  const out = result.stdout;
  const checks: Array<[string, boolean]> = [
    ['vault hot.md visible', /vault hot\.md exists ---\s*OK/.test(out)],
    [
      'wiki-query SKILL.md visible',
      /wiki-query SKILL\.md exists ---\s*OK/.test(out),
    ],
    ['librarian agent visible', /librarian agent visible[^]*?OK/.test(out)],
    ['vault writable', /OK_writable/.test(out)],
  ];

  let allOk = true;
  for (const [label, passed] of checks) {
    if (passed) ok(label);
    else {
      fail(label);
      allOk = false;
    }
  }
  if (!allOk) process.exit(1);
}

function main() {
  // Sanity: docker present
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['version'], { stdio: 'ignore' });
  } catch (err) {
    fail(`Docker not reachable: ${(err as Error).message}`);
    process.exit(1);
  }

  step1_validateAllowlist();
  step2_syncAgents();
  step3_dockerProbe();

  console.log(
    '\n\x1b[32m✓ All checks passed.\x1b[0m Vault + wiki framework + librarian agent are wired into nanoclaw.\n',
  );
}

main();
