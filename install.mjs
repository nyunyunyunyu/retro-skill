#!/usr/bin/env node
// Installs retro for Claude Code and/or Codex: copies the skills and agents and registers the hook.
//   node install.mjs [--claude] [--codex] [--dry-run]     (no flag: every tool whose config dir exists)
// Existing settings are kept; the hook entries are added only if missing, and the file is backed up first.
// In Codex, each added entry needs trusting once in /hooks; entries already trusted stay trusted.
// It also warns when the tool lets a session run too few subagents at once for retro's minimum slots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { C, harnessLimit } from './skills/retro/scripts/lib.mjs';

const repo = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const flags = new Set(process.argv.slice(2));
const dry = flags.has('--dry-run');
const want = t => flags.has(`--${t}`) || (!flags.has('--claude') && !flags.has('--codex') && fs.existsSync(path.join(home, t === 'claude' ? '.claude' : '.codex')));
const slash = p => p.replace(/\\/g, '/');
const say = m => console.log((dry ? '[dry-run] ' : '') + m);

function copyDir(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (!dry) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(s, d); }
  }
}
function writeJson(file, obj) {
  if (dry) return;
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-retro');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
// A missing or empty file is {}; one that exists but isn't plain JSON (JSONC, comments) is left alone rather than
// rewritten without the user's other settings: that tool's hooks are skipped and the install exits with 1.
function readJson(f) {
  if (!fs.existsSync(f)) return {};
  const text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) {
    console.error(`${f} is not plain JSON (${e.message}). Nothing was written to it; add the hook entries by hand (see README).`);
    process.exitCode = 1;
    return null;
  }
}
const hasRetro = groups => (groups || []).some(g => (g.hooks || []).some(h => JSON.stringify(h).includes('retro-nudge.mjs')));
// The hook's events and their matchers. SessionStart only after a compaction.
const EVENTS = { PostToolUse: '*', Stop: null, SubagentStop: null, SessionStart: 'compact' };
const need = C.RESERVE + C.MIN_SLOTS;

function installSkills(skillsDir) {
  for (const name of ['retro', 'retro-status']) {
    copyDir(path.join(repo, 'skills', name), path.join(skillsDir, name));
    say(`skill ${name} -> ${path.join(skillsDir, name)}`);
  }
}

if (want('claude')) {
  const base = path.join(home, '.claude');
  installSkills(path.join(base, 'skills'));
  for (const f of fs.readdirSync(path.join(repo, 'agents', 'claude'))) {
    if (!dry) { fs.mkdirSync(path.join(base, 'agents'), { recursive: true }); fs.copyFileSync(path.join(repo, 'agents', 'claude', f), path.join(base, 'agents', f)); }
    say(`agent ${f} -> ${path.join(base, 'agents')}`);
  }
  const file = path.join(base, 'settings.json'), s = readJson(file);
  const script = slash(path.join(base, 'skills', 'retro', 'scripts', 'retro-nudge.mjs'));
  let changed = false;
  for (const [ev, matcher] of s ? Object.entries(EVENTS) : []) {
    s.hooks ||= {};
    if (hasRetro(s.hooks[ev])) continue;
    const entry = { hooks: [{ type: 'command', command: 'node', args: [script], timeout: 10 }] };
    if (matcher) entry.matcher = matcher;
    (s.hooks[ev] ||= []).push(entry);
    changed = true;
    say(`hook ${ev} added to ${file}`);
  }
  if (!s) say(`hooks not added to ${file}`);
  else if (changed) writeJson(file, s);
  else say(`hooks already in ${file}`);
  const limit = parseInt(s?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, 10);
  if (limit > 0 && limit < need) say(`WARNING: CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is ${limit}; retro needs at least ${need} (the background review, two spare, ${C.MIN_SLOTS} executors). Raise it or remove it (default 20).`);
}

if (want('codex')) {
  installSkills(path.join(home, '.agents', 'skills'));
  const dir = path.join(home, '.codex', 'agents');
  for (const f of fs.readdirSync(path.join(repo, 'agents', 'claude'))) {
    const md = fs.readFileSync(path.join(repo, 'agents', 'claude', f), 'utf8').replace(/\r\n/g, '\n');
    const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const fm = Object.fromEntries(m[1].split('\n').map(l => l.split(/:\s*(.*)/s)).map(([k, v]) => [k, v]));
    const toml = `name = ${JSON.stringify(fm.name)}\ndescription = ${JSON.stringify(fm.description)}\nmodel_reasoning_effort = ${JSON.stringify(fm.effort || 'high')}\ndeveloper_instructions = '''\n${m[2].trim()}\n'''\n`;
    if (!dry) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, f.replace(/\.md$/, '.toml')), toml); }
    say(`agent ${f.replace(/\.md$/, '.toml')} -> ${dir}`);
  }
  // Codex trusts each entry by a hash of its event, matcher and handler (not the script's contents), so entries
  // already there are never rewritten: only missing events are appended, and only those need trusting in /hooks.
  const file = path.join(home, '.codex', 'hooks.json'), h = readJson(file);
  const added = [];
  for (const [ev, matcher] of h ? Object.entries(EVENTS) : []) {
    if (hasRetro(h.hooks?.[ev])) continue;
    const entry = { hooks: [{ type: 'command', command: 'node "$HOME/.agents/skills/retro/scripts/retro-nudge.mjs"', commandWindows: `node "${slash(path.join(home, '.agents', 'skills', 'retro', 'scripts', 'retro-nudge.mjs'))}"`, timeout: 10 }] };
    if (ev === 'SessionStart') entry.matcher = matcher;
    ((h.hooks ||= {})[ev] ||= []).push(entry);
    added.push(ev);
  }
  if (!h) say(`hooks not added to ${file}`);
  else if (!added.length) say(`hooks already in ${file}`);
  else {
    writeJson(file, h);
    say(`hooks ${added.join(', ')} added to ${file} — open /hooks in Codex and trust them; until then Codex skips them`);
  }
  const limit = harnessLimit(true, null);
  if (limit < need) say(`WARNING: Codex lets a session run only ${limit} subagents at once; retro needs at least ${need} (the background review, two spare, ${C.MIN_SLOTS} executors) and stops a goal until it has them. Add to ~/.codex/config.toml:  [agents]  max_concurrent_threads_per_session = 12`);
}
