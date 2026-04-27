import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { syncWikiSkills, resolveWikiSkillsPath } from './container-runner.js';

// These tests exercise real filesystem ops in a per-test temp directory so the
// behaviour matches what runs inside buildVolumeMounts at container spawn.

let tmpRoot: string;
let wikiSkillsSrc: string;
let containerSkillsSrc: string;
let skillsDst: string;

function makeSkill(
  parent: string,
  name: string,
  files: Record<string, string>,
) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filename), content);
  }
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-wiki-sync-'));
  wikiSkillsSrc = path.join(tmpRoot, 'obsidian-wiki', '.skills');
  containerSkillsSrc = path.join(tmpRoot, 'container', 'skills');
  skillsDst = path.join(
    tmpRoot,
    'data',
    'sessions',
    'group',
    '.claude',
    'skills',
  );
  fs.mkdirSync(skillsDst, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('syncWikiSkills', () => {
  it('copies every wiki skill into the destination', () => {
    makeSkill(wikiSkillsSrc, 'wiki-query', {
      'SKILL.md': '---\nname: wiki-query\n---\nbody',
    });
    makeSkill(wikiSkillsSrc, 'wiki-ingest', {
      'SKILL.md': '---\nname: wiki-ingest\n---\nbody',
    });

    const result = syncWikiSkills(wikiSkillsSrc, containerSkillsSrc, skillsDst);

    expect(result.synced.sort()).toEqual(['wiki-ingest', 'wiki-query']);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(path.join(skillsDst, 'wiki-query', 'SKILL.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(skillsDst, 'wiki-ingest', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('does not overwrite a same-named skill from container/skills/', () => {
    // Container ships its own version of "wiki-query" (precedence).
    makeSkill(containerSkillsSrc, 'wiki-query', {
      'SKILL.md': 'CONTAINER_VERSION',
    });
    // Wiki has a colliding version.
    makeSkill(wikiSkillsSrc, 'wiki-query', { 'SKILL.md': 'WIKI_VERSION' });
    // …and a non-colliding one which should still flow through.
    makeSkill(wikiSkillsSrc, 'wiki-ingest', { 'SKILL.md': 'WIKI_INGEST' });

    // Pretend the container/skills/ sync already ran (matches real flow).
    fs.cpSync(
      path.join(containerSkillsSrc, 'wiki-query'),
      path.join(skillsDst, 'wiki-query'),
      { recursive: true },
    );

    const result = syncWikiSkills(wikiSkillsSrc, containerSkillsSrc, skillsDst);

    expect(result.synced).toEqual(['wiki-ingest']);
    expect(result.skipped).toEqual(['wiki-query']);
    expect(
      fs.readFileSync(path.join(skillsDst, 'wiki-query', 'SKILL.md'), 'utf-8'),
    ).toBe('CONTAINER_VERSION');
    expect(
      fs.readFileSync(path.join(skillsDst, 'wiki-ingest', 'SKILL.md'), 'utf-8'),
    ).toBe('WIKI_INGEST');
  });

  it('refreshes existing wiki-skill content on subsequent calls (no stale cache)', () => {
    // First sync.
    makeSkill(wikiSkillsSrc, 'wiki-query', { 'SKILL.md': 'v1' });
    let result = syncWikiSkills(wikiSkillsSrc, containerSkillsSrc, skillsDst);
    expect(result.synced).toEqual(['wiki-query']);

    // Bump the wiki's content as if obsidian-wiki was updated.
    fs.writeFileSync(path.join(wikiSkillsSrc, 'wiki-query', 'SKILL.md'), 'v2');

    // Second sync should pick up the change.
    result = syncWikiSkills(wikiSkillsSrc, containerSkillsSrc, skillsDst);
    expect(result.synced).toEqual(['wiki-query']);
    expect(
      fs.readFileSync(path.join(skillsDst, 'wiki-query', 'SKILL.md'), 'utf-8'),
    ).toBe('v2');
  });

  it('returns an empty result when wikiSkillsSrc does not exist', () => {
    const result = syncWikiSkills(
      path.join(tmpRoot, 'does-not-exist'),
      containerSkillsSrc,
      skillsDst,
    );
    expect(result).toEqual({ synced: [], skipped: [] });
    expect(fs.readdirSync(skillsDst)).toEqual([]);
  });

  it('treats a missing container/skills/ as no precedence (syncs everything)', () => {
    makeSkill(wikiSkillsSrc, 'wiki-query', { 'SKILL.md': 'q' });
    // containerSkillsSrc never created.

    const result = syncWikiSkills(wikiSkillsSrc, containerSkillsSrc, skillsDst);

    expect(result.synced).toEqual(['wiki-query']);
    expect(result.skipped).toEqual([]);
  });

  it('skips broken symlinks silently without throwing', () => {
    fs.mkdirSync(wikiSkillsSrc, { recursive: true });
    // Dangling symlink (target does not exist) — mirrors the macOS-style
    // symlinks documented in container/agents/librarian.md.
    fs.symlinkSync(
      '/nonexistent/target',
      path.join(wikiSkillsSrc, 'broken-link'),
    );
    makeSkill(wikiSkillsSrc, 'wiki-query', { 'SKILL.md': 'q' });

    const result = syncWikiSkills(wikiSkillsSrc, containerSkillsSrc, skillsDst);

    expect(result.synced).toEqual(['wiki-query']);
    expect(fs.existsSync(path.join(skillsDst, 'broken-link'))).toBe(false);
  });

  it('skips non-directory entries (stray files) without throwing', () => {
    fs.mkdirSync(wikiSkillsSrc, { recursive: true });
    fs.writeFileSync(path.join(wikiSkillsSrc, 'README.md'), 'not a skill dir');
    makeSkill(wikiSkillsSrc, 'wiki-query', { 'SKILL.md': 'q' });

    const result = syncWikiSkills(wikiSkillsSrc, containerSkillsSrc, skillsDst);

    expect(result.synced).toEqual(['wiki-query']);
    expect(fs.existsSync(path.join(skillsDst, 'README.md'))).toBe(false);
  });
});

describe('resolveWikiSkillsPath', () => {
  let tmpHome: string;
  let realHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-wiki-home-'));
    realHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reads OBSIDIAN_WIKI_REPO from ~/.obsidian-wiki/config (quoted value)', () => {
    fs.mkdirSync(path.join(tmpHome, '.obsidian-wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.obsidian-wiki', 'config'),
      'OBSIDIAN_VAULT_PATH="/some/vault"\nOBSIDIAN_WIKI_REPO="/custom/wiki/repo"\n',
    );

    expect(resolveWikiSkillsPath()).toBe('/custom/wiki/repo/.skills');
  });

  it('reads OBSIDIAN_WIKI_REPO without quotes', () => {
    fs.mkdirSync(path.join(tmpHome, '.obsidian-wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.obsidian-wiki', 'config'),
      'OBSIDIAN_WIKI_REPO=/no/quotes/repo\n',
    );

    expect(resolveWikiSkillsPath()).toBe('/no/quotes/repo/.skills');
  });

  it('falls back to ~/Projects/obsidian-wiki when config is missing', () => {
    expect(resolveWikiSkillsPath()).toBe(
      path.join(tmpHome, 'Projects', 'obsidian-wiki', '.skills'),
    );
  });

  it('falls back to ~/Projects/obsidian-wiki when config exists but lacks the variable', () => {
    fs.mkdirSync(path.join(tmpHome, '.obsidian-wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.obsidian-wiki', 'config'),
      'OBSIDIAN_VAULT_PATH="/some/vault"\n',
    );

    expect(resolveWikiSkillsPath()).toBe(
      path.join(tmpHome, 'Projects', 'obsidian-wiki', '.skills'),
    );
  });
});
