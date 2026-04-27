/**
 * One-shot script: pre-warm the in-container qmd cache.
 *
 * Spawns a throwaway container with the qmd-cache + vault + armlab + altruistic
 * mounts, runs `qmd collection add` for each, then `qmd update && qmd embed`.
 * The bind-mounted cache (`~/.config/nanoclaw/qmd-cache`) persists across
 * subsequent container spawns, so the agent's first real request is fast.
 *
 * Run: npx tsx scripts/warm-qmd-container-cache.ts
 *
 * Idempotent: re-running will refresh the index. Use `--force` to wipe the
 * cache first (rebuild from scratch).
 */
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE } from '../src/config.js';
import {
  CONTAINER_RUNTIME_BIN,
  gpuArgs,
  hostGatewayArgs,
} from '../src/container-runtime.js';

const HOME = os.homedir();
const HOST_QMD_CACHE = path.join(HOME, '.config/nanoclaw/qmd-cache');
const VAULT = path.join(HOME, 'Projects/ArmLabVault');
const ARMLAB = path.join(HOME, 'Projects/ArmLab.io');
const ALTRUISTIC = path.join(HOME, 'Projects/Altruistic');

const FORCE = process.argv.includes('--force');

function ok(msg: string) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}
function info(msg: string) {
  console.log(`  ${msg}`);
}
function fail(msg: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function main() {
  // Sanity: container runtime present
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['version'], { stdio: 'ignore' });
  } catch (err) {
    fail(`Container runtime not reachable: ${(err as Error).message}`);
  }

  // Sanity: vault exists
  for (const p of [VAULT, ARMLAB, ALTRUISTIC]) {
    if (!fs.existsSync(p)) fail(`Source dir missing: ${p}`);
  }

  ensureDir(HOST_QMD_CACHE);

  if (FORCE) {
    console.log('--force: wiping host qmd-cache...');
    for (const entry of fs.readdirSync(HOST_QMD_CACHE)) {
      const full = path.join(HOST_QMD_CACHE, entry);
      fs.rmSync(full, { recursive: true, force: true });
    }
    ok(`Wiped ${HOST_QMD_CACHE}`);
  }

  console.log('Spawning warm-cache container...');

  // Run as the host user so the bind-mounted cache is owned by us.
  const uid = process.getuid?.();
  const gid = process.getgid?.();

  const containerName = `nanoclaw-qmd-warm-${Date.now()}`;
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName,
    ...hostGatewayArgs(),
    ...gpuArgs(),
  ];

  if (uid != null && uid !== 0) {
    args.push('--user', `${uid}:${gid}`, '-e', 'HOME=/home/node');
  }

  args.push(
    '-v',
    `${HOST_QMD_CACHE}:/workspace/extra/qmd-cache`,
    '-v',
    `${VAULT}:/workspace/extra/vault`,
    '-v',
    `${ARMLAB}:/workspace/extra/armlab`,
    '-v',
    `${ALTRUISTIC}:/workspace/extra/altruistic`,
    '-e',
    'XDG_CACHE_HOME=/workspace/extra/qmd-cache',
    '--entrypoint',
    '/bin/bash',
    CONTAINER_IMAGE,
    '-c',
    `
      set -e
      echo '--- qmd version ---'
      qmd --version

      echo
      echo '--- (re)registering collections at container paths ---'
      # Idempotent: 'add' on an existing collection updates its config; safe to call repeatedly.
      qmd collection add /workspace/extra/vault       --name wiki       || true
      qmd collection add /workspace/extra/armlab      --name armlab     || true
      qmd collection add /workspace/extra/altruistic  --name altruistic || true

      echo
      echo '--- attaching collection contexts ---'
      qmd context add qmd://wiki/       'Compiled Obsidian second brain (ArmLabVault). Categories: concepts, entities, skills, references, synthesis, journal, projects. Affinity tags p1-p4 + altruistic + armlab-kb.' || true
      qmd context add qmd://armlab/     'Raw ArmLab.io operational corpus — engagement docs, source material before distillation.' || true
      qmd context add qmd://altruistic/ 'Per-project engagement docs for Altruistic delivery partner.' || true

      echo
      echo '--- update (rescan files) ---'
      qmd update

      echo
      echo '--- embed (generate vectors) ---'
      qmd embed

      echo
      echo '--- warming reranker + query-expansion models (qmd query downloads them lazily) ---'
      qmd query 'ArmLab' -c wiki -n 1 --json > /dev/null

      echo
      echo '--- final status ---'
      qmd status
    `,
  );

  const result = spawnSync(CONTAINER_RUNTIME_BIN, args, {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    fail(`Warm-cache container exited ${result.status}`);
  }

  // Check the index was created
  const indexPath = path.join(HOST_QMD_CACHE, 'qmd', 'index.sqlite');
  if (!fs.existsSync(indexPath)) {
    fail(`Expected ${indexPath} after warm — not found.`);
  }
  const stat = fs.statSync(indexPath);
  ok(`index.sqlite present: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const modelsDir = path.join(HOST_QMD_CACHE, 'qmd', 'models');
  if (fs.existsSync(modelsDir)) {
    const models = fs.readdirSync(modelsDir).filter((m) => m.endsWith('.gguf'));
    ok(`models cached: ${models.length} file(s)`);
    for (const m of models) info(`  ${m}`);
  }

  console.log(
    '\n\x1b[32m✓ Container qmd cache warmed.\x1b[0m Subsequent NanoClaw spawns will reuse this cache.\n',
  );
}

main();
