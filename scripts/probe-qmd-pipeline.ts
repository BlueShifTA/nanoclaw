/**
 * End-to-end verification: QMD semantic search works for BOTH host and
 * NanoClaw container, against the same vault content.
 *
 * Tests (no LLM in the loop — direct CLI + MCP probes only):
 *   1. Host: qmd status, qmd query --json -c wiki, qmd MCP tools/list + query.
 *   2. Container: same set of probes inside a one-shot container with the same
 *      mount layout the runtime uses.
 *   3. Cross-check: a query against the same keyword returns hits in both
 *      environments and at least one hit's basename overlaps. (Catches the
 *      case where one env has a stale or empty index.)
 *
 * Run: npx tsx scripts/probe-qmd-pipeline.ts
 *      npx tsx scripts/probe-qmd-pipeline.ts --query "<custom keyword>"
 */
import { execFileSync, spawnSync } from 'child_process';
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

// Default keyword expected to hit in both indexes. Override with --query.
const argIdx = process.argv.indexOf('--query');
const QUERY = argIdx !== -1 ? process.argv[argIdx + 1] : 'ArmLab';

let passes = 0;
let failures = 0;

function ok(msg: string) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
  passes++;
}
function fail(msg: string) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  failures++;
}
function info(msg: string) {
  console.log(`  ${msg}`);
}

interface QmdHit {
  docid?: string;
  score?: number;
  file?: string;
  title?: string;
  snippet?: string;
}

// ---------------------------------------------------------------------------
// Host probes
// ---------------------------------------------------------------------------

function hostProbe() {
  console.log('\n[1/3] HOST qmd probes\n');

  // 1a: status
  try {
    execFileSync('qmd', ['status'], { stdio: 'ignore' });
    ok('host: qmd status exits 0');
  } catch {
    fail('host: qmd status failed');
    return null;
  }

  // 1b: collection list contains wiki
  const cl = execFileSync('qmd', ['collection', 'list'], {
    encoding: 'utf-8',
  });
  if (/\bwiki\b/.test(cl)) ok('host: collection "wiki" registered');
  else fail('host: collection "wiki" missing from `qmd collection list`');

  // 1c: BM25 search returns ≥1 hit, JSON parses cleanly
  const out = execFileSync(
    'qmd',
    ['search', QUERY, '-c', 'wiki', '-n', '3', '--json'],
    { encoding: 'utf-8' },
  );
  let hits: QmdHit[];
  try {
    hits = JSON.parse(out);
  } catch (err) {
    fail(`host: qmd search --json output not valid JSON: ${(err as Error).message}`);
    return null;
  }
  if (Array.isArray(hits) && hits.length > 0 && hits[0].file) {
    ok(`host: qmd search "${QUERY}" -c wiki → ${hits.length} hit(s), first: ${hits[0].file}`);
  } else {
    fail(`host: qmd search "${QUERY}" -c wiki returned no hits`);
    return null;
  }

  // 1d: MCP tools/list responds with a `query` tool
  const mcpResult = probeMcp('host', ['qmd', 'mcp']);
  if (mcpResult) {
    ok(`host: qmd MCP server lists ${mcpResult.toolCount} tool(s); includes "query": ${mcpResult.hasQuery}`);
    if (!mcpResult.hasQuery) failures++;
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Container probes
// ---------------------------------------------------------------------------

function containerProbe() {
  console.log('\n[2/3] CONTAINER qmd probes\n');

  for (const p of [HOST_QMD_CACHE, VAULT, ARMLAB, ALTRUISTIC]) {
    if (!fs.existsSync(p)) {
      fail(`container probe: missing host dir ${p} (warm cache first?)`);
      return null;
    }
  }

  const indexPath = path.join(HOST_QMD_CACHE, 'qmd', 'index.sqlite');
  if (!fs.existsSync(indexPath)) {
    fail(`container probe: ${indexPath} missing — run scripts/warm-qmd-container-cache.ts first`);
    return null;
  }

  const uid = process.getuid?.();
  const gid = process.getgid?.();

  const baseArgs: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    `nanoclaw-qmd-probe-${Date.now()}`,
    ...hostGatewayArgs(),
    ...gpuArgs(),
  ];
  if (uid != null && uid !== 0) {
    baseArgs.push('--user', `${uid}:${gid}`, '-e', 'HOME=/home/node');
  }
  baseArgs.push(
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
  );

  // 2a: status + collection list + JSON search in a single bash invocation.
  const inspectResult = spawnSync(
    CONTAINER_RUNTIME_BIN,
    [
      ...baseArgs,
      '--entrypoint',
      '/bin/bash',
      CONTAINER_IMAGE,
      '-c',
      `
        set -e
        qmd --version
        echo '---STATUS_OK---'
        qmd status > /dev/null && echo OK
        echo '---COLLECTION_LIST---'
        qmd collection list
        echo '---SEARCH_JSON---'
        qmd search ${JSON.stringify(QUERY)} -c wiki -n 3 --json
      `,
    ],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (inspectResult.status !== 0) {
    fail(`container probe: bash exited ${inspectResult.status}`);
    info(inspectResult.stderr);
    return null;
  }

  const out = inspectResult.stdout;
  if (/---STATUS_OK---\s*OK/.test(out)) ok('container: qmd status exits 0');
  else fail('container: qmd status failed');

  if (/\bwiki\b/.test(
    out.split('---COLLECTION_LIST---')[1]?.split('---SEARCH_JSON---')[0] || '',
  ))
    ok('container: collection "wiki" registered');
  else fail('container: collection "wiki" missing');

  const jsonStart = out.indexOf('---SEARCH_JSON---');
  const jsonStr = out.slice(jsonStart + '---SEARCH_JSON---'.length).trim();
  let hits: QmdHit[];
  try {
    hits = JSON.parse(jsonStr);
  } catch (err) {
    fail(`container: qmd search --json output not valid JSON: ${(err as Error).message}`);
    info(jsonStr.slice(0, 200));
    return null;
  }
  if (Array.isArray(hits) && hits.length > 0 && hits[0].file) {
    ok(`container: qmd search "${QUERY}" -c wiki → ${hits.length} hit(s), first: ${hits[0].file}`);
  } else {
    fail(`container: qmd search "${QUERY}" -c wiki returned no hits`);
    return null;
  }

  // 2b: MCP smoke test inside container
  const mcpResult = probeMcp('container', [
    CONTAINER_RUNTIME_BIN,
    ...baseArgs,
    '--entrypoint',
    'qmd',
    CONTAINER_IMAGE,
    'mcp',
  ]);
  if (mcpResult) {
    ok(`container: qmd MCP server lists ${mcpResult.toolCount} tool(s); includes "query": ${mcpResult.hasQuery}`);
    if (!mcpResult.hasQuery) failures++;
  }

  return hits;
}

// ---------------------------------------------------------------------------
// MCP smoke test (host or container)
// ---------------------------------------------------------------------------

function probeMcp(label: string, cmd: string[]): { toolCount: number; hasQuery: boolean } | null {
  // Send JSON-RPC initialize + tools/list over stdio.
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1.0' },
    },
  });
  const initialized = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  const toolsList = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  const stdin = `${initialize}\n${initialized}\n${toolsList}\n`;

  const [bin, ...args] = cmd;
  const result = spawnSync(bin, args, {
    input: stdin,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  if (result.status !== 0 && result.status !== null) {
    fail(`${label}: qmd mcp exited ${result.status}`);
    info(result.stderr.slice(0, 400));
    return null;
  }

  // Parse JSON-RPC responses (one per line).
  const lines = result.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  let toolsResponse: { result?: { tools?: Array<{ name: string }> } } | undefined;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.id === 2 && obj.result) {
        toolsResponse = obj;
        break;
      }
    } catch {
      /* skip */
    }
  }

  if (!toolsResponse?.result?.tools) {
    fail(`${label}: qmd mcp tools/list response not parseable`);
    info(result.stdout.slice(0, 400));
    return null;
  }

  const tools = toolsResponse.result.tools;
  return {
    toolCount: tools.length,
    hasQuery: tools.some((t) => t.name === 'query'),
  };
}

// ---------------------------------------------------------------------------
// Cross-check
// ---------------------------------------------------------------------------

function crossCheck(hostHits: QmdHit[] | null, containerHits: QmdHit[] | null) {
  console.log('\n[3/3] Cross-check\n');

  if (!hostHits || !containerHits) {
    fail('cross-check skipped (one or both environments failed)');
    return;
  }

  const basename = (s?: string) => (s ? path.basename(s) : '');
  const hostBases = new Set(hostHits.map((h) => basename(h.file)));
  const containerBases = new Set(containerHits.map((h) => basename(h.file)));

  const overlap = [...hostBases].filter((b) => containerBases.has(b));
  if (overlap.length > 0) {
    ok(`host ↔ container query "${QUERY}" share ${overlap.length} hit basename(s): ${overlap.slice(0, 3).join(', ')}`);
  } else {
    fail(
      `host ↔ container query "${QUERY}" share zero basenames — index drift suspected.\n  host:      ${[...hostBases].join(', ')}\n  container: ${[...containerBases].join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Sanity: container runtime present
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['version'], { stdio: 'ignore' });
  } catch (err) {
    fail(`Container runtime not reachable: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`Probing brain pipeline with query: "${QUERY}"`);

  const hostHits = hostProbe();
  const containerHits = containerProbe();
  crossCheck(hostHits, containerHits);

  console.log('\n========================================');
  if (failures === 0) {
    console.log(`\x1b[32m✓ All ${passes} checks passed.\x1b[0m`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m✗ ${failures} check(s) failed, ${passes} passed.\x1b[0m`);
    process.exit(1);
  }
}

main();
