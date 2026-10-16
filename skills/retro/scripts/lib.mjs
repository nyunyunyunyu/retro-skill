// Shared by the hook (retro-nudge.mjs) and the helper CLI (retro.mjs). All project state lives in <root>/.retro/:
//   slot             one line, the background slot (route review or idea scout), "key=value ..." — see readSlot
//   retro-done       ISO time of the last finished retro, written by `retro.mjs done`
//   log.tsv          append-only event log (time, session, event, detail), for the progress desk and later analysis
//   sessions/<id>.json   sessions that hold an active /goal here, for the progress desk
//   tasks/<task>/report.md   executor reports; ideas.md, results.tsv, route-review.md, reviews/ are written by agents
import fs from 'node:fs';
import path from 'node:path';

// RETRO_TIME_SCALE shrinks every interval, for tests only (e.g. 0.01 turns an hour into 36 s).
const scale = Number(process.env.RETRO_TIME_SCALE) > 0 ? Number(process.env.RETRO_TIME_SCALE) : 1;
const MIN = 60e3 * scale;
export const C = {
  RETRO_AFTER: 60 * MIN, RETRO_RESULTS: 4, RETRO_CALLS: 40, REPEAT: 10,
  SLOT_EVERY: 60 * MIN, SCOUT_EVERY: 240 * MIN, LAUNCH_MAX: 20 * MIN, REVIEW_MAX: 20 * MIN, SCOUT_MAX: 40 * MIN,
  GRACE: 2 * MIN, PROGRESS_MAX: 4096, OPEN_IDEAS_MIN: 3, LOCK_STALE: 60e3, SAME_GOAL_GAP: 12 * 60 * MIN,
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
export const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
export const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// Files the scripts and agents generate; kept out of git so worktrees don't carry stale copies.
const GENERATED = ['slot', 'slot.lock', 'retro-done', 'log.tsv', 'sessions/', 'tasks/', 'reviews/', 'probes/', 'ideas.md', 'results.tsv', 'route-review.md'];
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
export function locked(root, fn, tries = 1) {
  const lock = path.join(ensureDir(root), 'slot.lock');
  for (let i = 0; i < tries; i++) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
    } catch (e) {
      try { if (e.code === 'EEXIST' && Date.now() - fs.statSync(lock).mtimeMs > C.LOCK_STALE) fs.unlinkSync(lock); } catch {}
      if (i + 1 < tries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try { return fn(readSlot(root)); } finally { try { fs.unlinkSync(lock); } catch {} }
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

// Executor reports, newest first. `born` (creation time) counts a report once even when it is rewritten; `mtime`
// shows activity. Scout reports (tasks/scout-*) are flagged, since they aren't task progress.
export function reports(root) {
  const base = path.join(dir(root), 'tasks');
  let names = [];
  try { names = fs.readdirSync(base); } catch {}
  const out = [];
  for (const task of names) {
    const file = path.join(base, task, 'report.md');
    try {
      const s = fs.statSync(file);
      out.push({ task, file, scout: task.startsWith('scout-'), mtime: s.mtimeMs, born: s.birthtimeMs > 0 ? Math.min(s.birthtimeMs, s.mtimeMs) : s.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Untested ideas in the pool ("- [ ] ..." lines), or null when the project has no pool.
export function openIdeas(root) {
  const f = path.join(dir(root), 'ideas.md');
  return fs.existsSync(f) ? (read(f).match(/^\s*[-*] \[ \]/gm) || []).length : null;
}

// Sessions that recorded an active /goal in this project, most recently active first.
export function sessions(root) {
  const d = path.join(dir(root), 'sessions');
  let names = [];
  try { names = fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch {}
  return names.map(f => { try { return JSON.parse(read(path.join(d, f))); } catch { return null; } })
    .filter(Boolean).map(s => ({ ...s, active: mtime(s.transcript_path) })).sort((a, b) => b.active - a.active);
}

// Newest sign of task progress in the project: a task report, a ledger row, a commit on any branch or worktree, or
// one of `extra` (times subagents came back).
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
