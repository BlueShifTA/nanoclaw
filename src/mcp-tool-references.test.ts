/**
 * Audit test: every `mcp__nanoclaw__<name>` reference in agent-facing
 * markdown (group CLAUDE.local.md + skills) must resolve to a real tool
 * registered in container/agent-runner/src/mcp-tools/*.ts. Reads real
 * files — no mocks.
 *
 * Catches the F8 class of regression: renaming/removing an MCP tool
 * without updating the prompts that tell the agent to call it. The agent
 * silently fails or fabricates output.
 *
 * conversations/ markdown is excluded — those are historical chat logs,
 * not prompts. Drift there is unavoidable and harmless.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_TOOLS_DIR = path.join(REPO_ROOT, 'container/agent-runner/src/mcp-tools');
const GROUPS_DIR = path.join(REPO_ROOT, 'groups');

function listRegisteredToolNames(): Set<string> {
  if (!fs.existsSync(MCP_TOOLS_DIR)) return new Set();
  const names = new Set<string>();
  for (const entry of fs.readdirSync(MCP_TOOLS_DIR)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const src = fs.readFileSync(path.join(MCP_TOOLS_DIR, entry), 'utf-8');
    for (const m of src.matchAll(/\bname:\s*'([a-z_][a-z0-9_]*)'/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

function findAgentMarkdown(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Skip conversation logs — drift there is historical, not load-bearing.
      if (entry.name === 'conversations' || entry.name === 'logs' || entry.name === 'patches') continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  walk(GROUPS_DIR);
  return out;
}

describe('agent-prompt MCP tool references', () => {
  const registered = listRegisteredToolNames();
  const mdFiles = findAgentMarkdown();

  it('has a non-empty MCP tool registry', () => {
    expect(registered.size).toBeGreaterThan(0);
  });

  if (mdFiles.length === 0) {
    it.skip('no group markdown found — skipping reference scan', () => undefined);
    return;
  }

  // Collect every (file, tool name) reference so failures point at the
  // exact prompt that needs updating.
  const refs: Array<{ file: string; tool: string; line: number }> = [];
  for (const file of mdFiles) {
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/mcp__nanoclaw__([a-z_][a-z0-9_]*)/g)) {
        refs.push({ file: path.relative(REPO_ROOT, file), tool: m[1], line: i + 1 });
      }
    }
  }

  it('every reference resolves to a registered tool', () => {
    const unresolved = refs.filter((r) => !registered.has(r.tool));
    expect(unresolved, `${unresolved.length} unresolved references:\n${unresolved
      .map((r) => `  ${r.file}:${r.line}  mcp__nanoclaw__${r.tool}`)
      .join('\n')}\n\nRegistered tools: ${[...registered].sort().join(', ')}`).toEqual([]);
  });
});
