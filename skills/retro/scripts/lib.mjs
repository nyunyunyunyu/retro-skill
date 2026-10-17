// Shared by the hook (retro-nudge.mjs) and the helper CLI (retro.mjs). All project state lives in <root>/.retro/:
//   slot             one line, the background slot (route review or idea scout), "key=value ..." — see readSlot
//   slots            the executor slots the main agent chose for its goal (`retro.mjs slots`), JSON {n, at, why}
//   retro-done       ISO time of the last finished checkpoint, written by `retro.mjs done`
//   log.tsv          append-only event log (time, session, event, detail), for the progress desk and later analysis
//   sessions/<id>.json   sessions that hold an active /goal here, for the progress desk
//   tasks/<task>/report.md   executor reports; ideas.md, results.tsv, route-review.md, reviews/ are written by agents
//   user-inbox.jsonl what the user said at the progress desk, until the hook hands it over; then kept in user-said.md
// Per session, in the system temp dir (claude-retro-<session>.*): the goal cache, what the hook said when (.said),
// the last main tool call (.call) and Stop block (.blocked), and the subagent tracker (.agents/, see trackedAgents).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// RETRO_TIME_SCALE shrinks every interval, for tests only (e.g. 0.01 turns an hour into 36 s).
const scale = Number(process.env.RETRO_TIME_SCALE) > 0 ? Number(process.env.RETRO_TIME_SCALE) : 1;
const MIN = 60e3 * scale;
export const C = {
  CHECKPOINT_EVERY: 60 * MIN, REPEAT: 10 * MIN,
  SLOT_EVERY: 60 * MIN, SCOUT_EVERY: 240 * MIN, LAUNCH_MAX: 20 * MIN, REVIEW_MAX: 20 * MIN, SCOUT_MAX: 40 * MIN, GRACE: 2 * MIN,
  SEGMENT_MAX: 60 * MIN, SILENT: 20 * MIN, GONE: 60 * MIN, IDLE_GRACE: 5 * MIN, SLOTS_BY: 10 * MIN,
  // Subagents the harness allows at once, minus RESERVE (the background review/scout and two spare), must leave
  // MIN_SLOTS executors. Defaults: Codex 3 ([agents] max_concurrent_threads_per_session), Claude Code 20.
  RESERVE: 3, MIN_SLOTS: 2, CODEX_LIMIT: 3, CLAUDE_LIMIT: 20,
  PROGRESS_MAX: 4096, OPEN_IDEAS_MIN: 3, LOCK_STALE: 60e3, SAME_GOAL_GAP: 12 * 60 * MIN,
};
export const limitOf = type => (type === 'scout' ? C.SCOUT_MAX : C.REVIEW_MAX);
// Agents whose finishing is not progress on the task itself.
export const SLOT_AGENTS = new Set(['route-reviewer', 'idea-scout']);
export const EXIT_GONE = 2, EXIT_BUSY = 3;

// A directory inside a git worktree maps to the same place in the main checkout, so all worktrees share one .retro/.
// Anything else (a plain checkout, a submodule, no git) is returned as is: the project is where the session started.
export function mainCheckout(d) {
  d = path.resolve(d);
  for (let top = d; ; top = path.dirname(top)) {
    const g = path.join(top, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch {}
    if (st?.isFile()) {
      const m = read(g).match(/^gitdir:\s*(.+?)\s*$/m);
      const gitdir = m && path.resolve(top, m[1]);
      const common = gitdir && read(path.join(gitdir, 'commondir')).trim(); // only worktrees have one
      const main = common && path.resolve(gitdir, common);
      return main && path.basename(main) === '.git' ? path.join(path.dirname(main), path.relative(top, d)) : d;
    }
    if (st || path.dirname(top) === top) return d;
  }
}

export const dir = root => path.join(root, '.retro');
export const iso = t => new Date(t).toISOString();
export const safe = id => String(id).replace(/[^\w-]/g, '_');
export const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
export const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// Files the scripts and agents generate; kept out of git so worktrees don't carry stale copies.
const GENERATED = ['slot', 'slot.lock', 'slots', 'retro-done', 'log.tsv', 'sessions/', 'tasks/', 'reviews/', 'probes/', 'ideas.md', 'results.tsv', 'route-review.md', 'user-inbox.jsonl', 'user-said.md'];
// A new .retro/ ignores everything. An existing one (some projects commit parts of it) gets a .gitignore for the
// generated files only, unless it already has one.
export function ensureDir(root) {
  const d = dir(root);
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.gitignore'), '*\n');
  } else if (!fs.existsSync(path.join(d, '.gitignore'))) {
    fs.writeFileSync(path.join(d, '.gitignore'), GENERATED.join('\n') + '\n');
  }
  return d;
}

// slot: "state=running|done|aborted|stalled type=review|scout|stall start=<ISO> by=<session> [spawned=<ISO>]
// [end=<ISO>] [lastScout=<ISO>]". Unknown keys are kept on rewrite. The time limit runs from `spawned`.
export function readSlot(root) {
  const kv = Object.fromEntries([...read(path.join(dir(root), 'slot')).matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]]));
  const start = Date.parse(kv.start) || 0;
  return {
    kv, state: kv.state || 'none', type: kv.type || '', start, by: kv.by || '',
    spawned: !!kv.spawned, spawnedAt: kv.spawned ? Date.parse(kv.spawned) || start : 0, lastScout: Date.parse(kv.lastScout) || 0,
  };
}
export function writeSlot(root, kv) {
  ensureDir(root);
  const line = Object.entries(kv).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join(' ');
  fs.writeFileSync(path.join(dir(root), 'slot'), line + '\n');
}

// Run fn(slot) under an exclusive lock file, so concurrent runs (other sessions, parallel tool calls, the CLI) can't
// interleave. Returns fn's result, or undefined when the lock stays busy; a lock older than LOCK_STALE is removed.
// withLock does the same for any lock file.
export function locked(root, fn, tries = 1) {
  return withLock(path.join(ensureDir(root), 'slot.lock'), () => fn(readSlot(root)), tries);
}
export function withLock(lock, fn, tries = 1) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
    } catch (e) {
      try { if (e.code === 'EEXIST' && Date.now() - fs.statSync(lock).mtimeMs > C.LOCK_STALE) fs.unlinkSync(lock); } catch {}
      if (i + 1 < tries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
  }
  return undefined;
}

export function log(root, session, event, detail = '') {
  try {
    ensureDir(root);
    fs.appendFileSync(path.join(dir(root), 'log.tsv'),
      `${iso(Date.now())}\t${String(session || '-').slice(0, 8)}\t${event}\t${String(detail).replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } catch {}
}

export const lastRetro = root => Date.parse(read(path.join(dir(root), 'retro-done')).trim().split(/\s/)[0]) || 0;

// Executor reports, newest first. Scout reports (tasks/scout-*) are flagged, since they aren't task progress.
export function reports(root) {
  const base = path.join(dir(root), 'tasks');
  let names = [];
  try { names = fs.readdirSync(base); } catch {}
  const out = [];
  for (const task of names) {
    const file = path.join(base, task, 'report.md');
    try {
      const s = fs.statSync(file);
      out.push({ task, file, scout: task.startsWith('scout-'), mtime: s.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Untested ideas in the pool ("- [ ] ..." lines), or null when the project has no pool.
export function openIdeas(root) {
  const f = path.join(dir(root), 'ideas.md');
  return fs.existsSync(f) ? (read(f).match(/^\s*[-*] \[ \]/gm) || []).length : null;
}

// The hook's cached goal state for a session ({active, cond, start, …} in the system temp dir), or null.
export function goalCache(sessionId) {
  try { return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-retro-${safe(sessionId)}.goal`), 'utf8')); } catch { return null; }
}

// The executor slots chosen for the current goal ({n, at, why}), or null.
export function readSlots(root) {
  try {
    const s = JSON.parse(read(path.join(dir(root), 'slots')));
    return s.n > 0 ? { ...s, at: Date.parse(s.at) || 0 } : null;
  } catch { return null; }
}

// How many subagents the harness lets a session run at once. Claude Code: CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, else
// 20. Codex: [agents] max_concurrent_threads_per_session in <CODEX_HOME>/config.toml, then the project's
// .codex/config.toml (it counts subagents only), else 3.
export function harnessLimit(codex, root) {
  if (!codex) {
    const n = parseInt(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, 10);
    return n > 0 ? n : C.CLAUDE_LIMIT;
  }
  let n = null;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  for (const f of [path.join(home, 'config.toml'), root && path.join(root, '.codex', 'config.toml')]) {
    const v = f && tomlInt(read(f), 'agents', 'max_concurrent_threads_per_session');
    if (v != null) n = v;
  }
  return n ?? C.CODEX_LIMIT;
}
// An integer from a TOML file: under [table], as table.key at the top level, or in an inline table
// (table = { key = n }); quoted or not. Enough for one known key.
function tomlInt(text, table, key) {
  let cur = '';
  const num = '"?(\\d+)"?';
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (h) { cur = h[1]; continue; }
    const m = line.match(new RegExp(`^\\s*([\\w.-]+)\\s*=\\s*${num}\\s*(#.*)?$`));
    if (m && ((cur === table && m[1] === key) || (cur === '' && m[1] === `${table}.${key}`))) return Number(m[2]);
    const inline = cur === '' && line.match(new RegExp(`^\\s*${table}\\s*=\\s*\\{[^}]*\\b${key}\\s*=\\s*${num}`));
    if (inline) return Number(inline[1]);
  }
  return null;
}

// The subagent tracker the hook keeps per session: <tmp>/claude-retro-<session>.agents/<agent>.json holds
// {type, seg (when its current segment started), tp (a transcript to name it by)} and its mtime is the agent's last
// tool call; <agent>.stop exists while it is stopped (it finished its turn), its mtime being when.
export const agentsDir = sessionId => path.join(os.tmpdir(), `claude-retro-${safe(sessionId)}.agents`);
export function trackedAgents(sessionId) {
  const d = agentsDir(sessionId);
  let names = [];
  try { names = fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch {}
  return names.map(f => {
    const id = f.slice(0, -5);
    let h = {};
    try { h = JSON.parse(read(path.join(d, f))); } catch {}
    const stopAt = mtime(path.join(d, `${id}.stop`));
    return { id, type: h.type || '?', seg: h.seg || 0, tp: h.tp || '', last: mtime(path.join(d, f)), stopAt, active: !stopAt };
  });
}
// The tracked executors of a goal that started at `since`, and which of them are running: not stopped, and heard from
// within GONE (a subagent stopped without a SubagentStop looks like this). Entries idle for a day are removed.
export function goalAgents(sessionId, since, now = Date.now()) {
  const all = trackedAgents(sessionId);
  for (const a of all) {
    if (now - Math.max(a.last, a.stopAt) > 864e5) for (const ext of ['json', 'stop']) try { fs.unlinkSync(path.join(agentsDir(sessionId), `${a.id}.${ext}`)); } catch {}
  }
  const agents = all.filter(a => Math.max(a.seg, a.last, a.stopAt) >= since && now - Math.max(a.last, a.stopAt) <= 864e5);
  return { agents, running: agents.filter(a => a.active && now - a.last < C.GONE) };
}
// A name the main agent knows the subagent by. Claude Code: the description in subagents/agent-<id>.meta.json next to
// the main transcript. Codex: the agent path its rollout's first record names. Else the id.
export function agentName(a) {
  const tp = String(a.tp || '');
  const own = /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/.test(tp);
  const meta = own ? tp.replace(/\.jsonl$/, '.meta.json') : path.join(tp.replace(/\.jsonl$/, ''), 'subagents', `agent-${a.id}.meta.json`);
  try { const m = JSON.parse(read(meta)); if (m.description) return m.description; } catch {}
  const p = headOf(tp, 8192).match(/"agent_path":"([^"]*)"/)?.[1];
  return p ? path.basename(p) : a.id;
}

export function headOf(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch { return ''; }
}

// When a transcript was last written: its mtime, or the timestamp of its last record if later. Codex keeps its
// rollout file open, and on Windows the mtime then stays at the session's start.
export function lastWrite(file) {
  let t = mtime(file);
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, 65536);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    fs.closeSync(fd);
    const m = [...buf.toString('utf8').matchAll(/"timestamp":"([^"]+)"/g)].pop();
    if (m) t = Math.max(t, Date.parse(m[1]) || 0);
  } catch {}
  return t;
}

// Sessions that recorded an active /goal in this project, most recently active first.
export function sessions(root) {
  const d = path.join(dir(root), 'sessions');
  let names = [];
  try { names = fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch {}
  return names.map(f => { try { return JSON.parse(read(path.join(d, f))); } catch { return null; } })
    .filter(Boolean).map(s => ({ ...s, active: lastWrite(s.transcript_path) })).sort((a, b) => b.active - a.active);
}

// Newest sign of task progress in the project: a task report, a ledger row, a commit on any branch or worktree, or
// one of `extra` (times subagents finished).
export function newestResult(root, extra = []) {
  return Math.max(0, ...extra, ...reports(root).filter(r => !r.scout).map(r => r.mtime),
    mtime(path.join(dir(root), 'results.tsv')), mtime(path.join(root, 'results.tsv')), gitActivity(root));
}

function gitActivity(root) {
  const git = path.join(root, '.git');
  let t = mtime(path.join(git, 'logs', 'HEAD'));
  const walk = (d, depth) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isFile()) t = Math.max(t, mtime(path.join(d, e.name)));
      else if (e.isDirectory() && depth > 0) walk(path.join(d, e.name), depth - 1);
    }
  };
  walk(path.join(git, 'logs', 'refs', 'heads'), 2);
  let wts = [];
  try { wts = fs.readdirSync(path.join(git, 'worktrees')); } catch {}
  for (const w of wts) t = Math.max(t, mtime(path.join(git, 'worktrees', w, 'logs', 'HEAD')));
  return t;
}

// The goal text recorded in PROGRESS.md ("目标（同 /goal）：… · 怎么证明：…"), for when a session lost track of it.
export function progressGoal(root) {
  const m = read(path.join(root, 'PROGRESS.md')).match(/^目标[^：:\n]*[：:]\s*(.+)$/m);
  return m ? m[1].split(' · ')[0].trim() : '';
}
