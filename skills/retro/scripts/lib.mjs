// Shared by the hook (retro-nudge.mjs) and the helper CLI (retro.mjs). All project state lives in <root>/.retro/:
//   slot             one line, the background slot (route review or idea scout), "key=value ..." — see readSlot
//   slots            the executor slots the main agent chose for its goal (`retro.mjs slots`), JSON {n, at, why}
//   checkpoints/<session>/<goal-start>/   retro-done, inbox-at and previous review/scout starts, scoped to a goal
//   probes/          background agents' probe scripts and the notes behind their reports
//   workers/<task>.json   executors another harness runs (Codex threads driven by codex-worker.mjs), see workers()
//   log.tsv          append-only event log (time, session, event, detail), for the progress desk and later analysis
//   sessions/<id>.json   sessions that hold an active /goal here, for the progress desk
//   tasks/<task>/report.md   executor reports; ideas.md, backlog.md, results.tsv, route-review.md, reviews/ are written by agents
//   user-inbox.jsonl what the user said at the progress desk, until the hook hands it over; then kept in user-said.md
// Per session, in the system temp dir (claude-retro-<session>.*): the goal cache, what the hook and the watch said
// when (.said, see claimSaid), the subagent tracker
// (.agents/, see trackedAgents), elapsed tool calls (.tools/, see timedTools), and the background watch (.watch).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// RETRO_TIME_SCALE shrinks every interval, for tests only (e.g. 0.01 turns an hour into 36 s).
const scale = Number(process.env.RETRO_TIME_SCALE) > 0 ? Number(process.env.RETRO_TIME_SCALE) : 1;
const MIN = 60e3 * scale;
export const C = {
  CHECKPOINT_EVERY: 60 * MIN, REPEAT: 10 * MIN,
  SLOT_EVERY: 60 * MIN, SCOUT_EVERY: 240 * MIN, LAUNCH_MAX: 20 * MIN, REVIEW_MAX: 20 * MIN, SCOUT_MAX: 40 * MIN, GRACE: 2 * MIN,
  SEGMENT_MAX: 60 * MIN, GONE: 60 * MIN, IDLE_GRACE: 5 * MIN, SLOTS_BY: 10 * MIN,
  // Observation thresholds, not proof of a stall: allow more time while a tool is outstanding.
  SILENT: 5 * MIN, STUCK: 15 * MIN, SLOW_TOOL: 10 * MIN,
  // A backstop: codex-worker.mjs stops a Codex turn this long. The hook asks the main agent at SEGMENT_MAX.
  WORKER_MAX: 120 * MIN,
  CODEX_LIMIT: 3, CLAUDE_LIMIT: 20,
  PROGRESS_MAX: 4096, OPEN_IDEAS_MIN: 3, LOCK_STALE: 60e3, SAME_GOAL_GAP: 12 * 60 * MIN,
};
export const limitOf = type => (type === 'scout' ? C.SCOUT_MAX : C.REVIEW_MAX);
export const slotExpired = (slot, now) => now >= (slot.spawned
  ? slot.spawnedAt + limitOf(slot.type) + C.GRACE : slot.start + C.LAUNCH_MAX);
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
const GENERATED = ['slot', 'slot.lock', 'slots', 'retro-done', 'inbox-at', 'review-start', 'scout-start', 'checkpoints/', 'log.tsv', 'sessions/', 'tasks/', 'reviews/', 'probes/', 'workers/', 'recovery/', 'RUNBOOK.md', 'runbook/', 'ideas.md', 'backlog.md', 'results.tsv', 'route-review.md', 'user-inbox.jsonl', 'user-said.md'];
// A new .retro/ ignores everything. An existing one (some projects commit parts of it) gets a .gitignore for the
// generated files only, unless it already has one. A list we wrote earlier picks up names added since.
export function ensureDir(root) {
  const d = dir(root);
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.gitignore'), '*\n');
  } else if (!fs.existsSync(path.join(d, '.gitignore'))) {
    fs.writeFileSync(path.join(d, '.gitignore'), GENERATED.join('\n') + '\n');
  } else {
    const gi = path.join(d, '.gitignore'), raw = read(gi), have = raw.split(/\r?\n/).filter(Boolean);
    const add = GENERATED.filter(g => !have.includes(g));
    if (add.length && have.length && have.every(l => GENERATED.includes(l))) fs.appendFileSync(gi, (raw.endsWith('\n') ? '' : '\n') + add.join('\n') + '\n');
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

// What was said to a session's main agent when ({key: time}), by the hook and the background watch alike, so neither
// repeats the other. claimSaid says yes, and records it, only if ok(last time said) — checked again under a lock, so
// parallel tool calls don't both say it. A busy lock means "not now": a later call says it instead.
const saidFile = sessionId => path.join(os.tmpdir(), `claude-retro-${safe(sessionId)}.said`);
export function said(sessionId) { try { return JSON.parse(read(saidFile(sessionId))) || {}; } catch { return {}; } }
export function claimSaid(sessionId, key, ok, now = Date.now()) {
  if (!ok(said(sessionId)[key])) return false;
  return withLock(saidFile(sessionId) + '.lock', () => {
    const m = said(sessionId);
    if (!ok(m[key])) return false;
    m[key] = now;
    for (const k of Object.keys(m)) if (now - m[k] > 864e5) delete m[k];
    fs.writeFileSync(saidFile(sessionId), JSON.stringify(m));
    return true;
  }) === true;
}

// The background watch of a session (`retro.mjs watch`) rewrites <tmp>/claude-retro-<session>.watch (its pid) every
// WATCH_TICK while it runs.
export const WATCH_TICK = Math.min(10e3, C.SILENT / 30);
export const watchFile = sessionId => path.join(os.tmpdir(), `claude-retro-${safe(sessionId)}.watch`);
export const watching = sessionId => Date.now() - mtime(watchFile(sessionId)) < 3 * WATCH_TICK;

export function log(root, session, event, detail = '') {
  try {
    ensureDir(root);
    fs.appendFileSync(path.join(dir(root), 'log.tsv'),
      `${iso(Date.now())}\t${String(session || '-').slice(0, 8)}\t${event}\t${String(detail).replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } catch {}
}

export const checkpointDir = (root, sessionId, start) => sessionId && start
  ? path.join(dir(root), 'checkpoints', safe(sessionId), String(start)) : dir(root);
export const lastRetro = (root, sessionId, start) => Date.parse(read(path.join(checkpointDir(root, sessionId, start), 'retro-done')).trim().split(/\s/)[0]) || 0;

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

// Read only: null means no goal; undefined means the database is unavailable. Never infer permission to resume.
export function codexGoal(thread) {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const db = fs.readdirSync(home).filter(f => /^goals_\d+\.sqlite$/.test(f)).sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10)).pop();
    if (!db) return undefined;
    process.removeAllListeners('warning'); // node:sqlite is experimental in Node 22 and would say so on stderr
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const h = new DatabaseSync(path.join(home, db), { readOnly: true });
    try { return h.prepare('SELECT objective, status, created_at_ms FROM thread_goals WHERE thread_id = ?').get(String(thread)) ?? null; } finally { h.close(); }
  } catch { return undefined; }
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
    const last = mtime(path.join(d, f)); // a header caught mid-write reads as a fresh segment
    return { id, type: h.type || '?', seg: h.seg || last, tp: h.tp || '', last, stopAt, active: !stopAt };
  });
}

// Keep elapsed tool time separate from signs of life: output and polling do not restart a test's clock.
const toolsDir = sessionId => path.join(os.tmpdir(), `claude-retro-${safe(sessionId)}.tools`);
export function timedTools(sessionId) {
  let files = [];
  try { files = fs.readdirSync(toolsDir(sessionId)); } catch {}
  return files.filter(f => f.endsWith('.json')).flatMap(f => {
    const file = path.join(toolsDir(sessionId), f);
    try {
      const rec = JSON.parse(read(file));
      return Number.isFinite(rec?.at) && rec.at > 0 ? [{ ...rec, file }] : [];
    } catch { return []; }
  });
}
export function trackTool(input, goal, now = Date.now()) {
  if (!goal?.active) return;
  const ev = input.hook_event_name, name = String(input.tool_name || '').split('.').at(-1);
  if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(ev)) return;
  const args = input.tool_input || {}, sid = input.session_id;
  let result = input.tool_response || {};
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
  result ||= {};
  const output = typeof result === 'string' ? result : String(result.output || '');
  const exit = result.exit_code ?? output.match(/Process exited with code (-?\d+)/)?.[1];
  const finish = rec => {
    rec.ended ||= now;
    if (rec.ended - rec.at >= C.SLOW_TOOL) {
      const { file, ...data } = rec;
      fs.writeFileSync(file, JSON.stringify(data));
    } else try { fs.unlinkSync(rec.file); } catch {}
  };
  if (/^(write_stdin|TaskOutput|TaskStop)$/.test(name)) {
    if (ev !== 'PostToolUse') return;
    const job = args.session_id ?? args.task_id;
    const ended = name === 'TaskStop' || (name === 'write_stdin' ? exit != null : /^(completed|failed|stopped)$/.test(result.task?.status));
    if (job != null && ended) for (const rec of timedTools(sid)) if (rec.job === String(job)) finish(rec);
    return;
  }
  if (/^(wait|wait_agent|sleep)$/.test(name) || !input.tool_use_id) return;
  const command = args.command || args.cmd || args.description || name;
  // These are monitors/drivers, whose underlying commands are timed separately.
  if (/retro\.mjs["']?\s+watch\b|codex-worker\.mjs["']?\s+(run|resume)\b/.test(command)) return;
  const file = path.join(toolsDir(sid), `${safe(input.tool_use_id)}.json`);
  let rec;
  try { rec = JSON.parse(read(file)); } catch {}
  if (rec && rec.goal !== goal.start && ev !== 'PreToolUse') {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  if (!rec || rec.goal !== goal.start) rec = {
    id: input.tool_use_id, goal: goal.start, agent: input.agent_id || '', type: input.agent_type || '',
    name: clip(command, 200), at: now - (ev === 'PreToolUse' ? 0 : Math.max(0, Number(input.duration_ms) || 0)),
  };
  fs.mkdirSync(toolsDir(sid), { recursive: true });
  if (ev === 'PreToolUse') {
    fs.writeFileSync(file, JSON.stringify(rec));
    return;
  }
  const job = result.backgroundTaskId ?? result.shellId ?? (exit == null ? result.session_id ?? output.match(/Process running with session ID (\d+)/)?.[1] : null);
  if (job != null && ev !== 'PostToolUseFailure') {
    rec.job = String(job);
    fs.writeFileSync(file, JSON.stringify(rec));
  } else finish({ ...rec, file });
}
// External workers: executors another harness runs for this project, registered by their driver (codex-worker.mjs, or
// `retro.mjs worker start|beat|stop`). .retro/workers/<id>.json holds {desc, type, driver, seg, stopAt, pid (the
// driver process), child (the codex process) and childAt (when it started, if after seg), thread, rollout, cwd, cmd (the
// command running now), cmdAt, said (its last words), activityAt, waiting ({name, at})}; its mtime
// is the last sign of life. Written whole (temp file, then rename), so a reader never sees half a record.
// A worker whose driver process is gone (or, without a pid, silent for GONE) counts as stopped at its last sign.
const workersDir = root => path.join(dir(root), 'workers');
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// The codex command for workers, as [executable, ...leading args]. RETRO_CODEX wins: an executable, or a JSON array
// (throws if that isn't valid). Otherwise, on Windows, the Codex desktop app's own copy, newest first among
// %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\ that hold codex-code-mode-host.exe too, with the flags the app starts it
// with: its directory changes with every update, and a standalone CLI may lack the host and then runs no command.
// Else codex from PATH.
export function codexCommand(env = process.env, platform = process.platform) {
  const raw = env.RETRO_CODEX?.trim();
  if (raw) return raw.startsWith('[') ? JSON.parse(raw) : [raw];
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    let dirs = [];
    try { dirs = fs.readdirSync(bin).map(d => path.join(bin, d)); } catch {}
    const app = dirs.filter(d => fs.existsSync(path.join(d, 'codex.exe')) && fs.existsSync(path.join(d, 'codex-code-mode-host.exe')))
      .sort((a, b) => mtime(path.join(b, 'codex.exe')) - mtime(path.join(a, 'codex.exe')))[0];
    if (app) return [path.join(app, 'codex.exe'), '-c', 'features.code_mode_host=true', '-c', 'features.prefer_mxc=true'];
  }
  return ['codex'];
}

export function readWorker(root, id) {
  try { return JSON.parse(fs.readFileSync(path.join(workersDir(root), `${safe(id)}.json`), 'utf8')); } catch { return null; }
}
export function writeWorker(root, id, kv) {
  ensureDir(root);
  fs.mkdirSync(workersDir(root), { recursive: true });
  const w = { ...readWorker(root, id), ...kv };
  const f = path.join(workersDir(root), `${safe(id)}.json`), tmp = `${f}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(w)); fs.renameSync(tmp, f); } catch { try { fs.unlinkSync(tmp); } catch {} fs.writeFileSync(f, JSON.stringify(w)); }
  return w;
}
// A new segment: what the last one said and how it ended don't carry over. thread: undefined keeps the old one.
export function workerStart(root, id, { desc, type = 'external', driver = '', pid = null, child = null, thread, cwd } = {}) {
  const prev = readWorker(root, id) || {};
  const w = writeWorker(root, id, {
    desc: desc || prev.desc || '', type, driver, seg: Date.now(), stopAt: 0, pid, child, thread: thread === undefined ? prev.thread ?? null : thread,
    cwd: cwd ?? prev.cwd ?? null, rollout: '', childAt: 0, cmd: null, cmdAt: 0, said: '', asks: 0, exit: null, why: null, activityAt: 0, waiting: null,
  });
  log(root, '-', 'agent-start', `${safe(id)} ${type}`);
  return w;
}
// A sign of life, with what changed (cmd, said, thread…). False once it stopped.
export function workerBeat(root, id, kv = {}) {
  const w = readWorker(root, id);
  if (!w || w.stopAt) return false;
  writeWorker(root, id, kv);
  return true;
}
export function workerStop(root, id, kv = {}) {
  const w = readWorker(root, id);
  if (!w || w.stopAt) return false;
  writeWorker(root, id, { ...kv, stopAt: Date.now(), cmd: null });
  log(root, '-', 'agent-stop', safe(id));
  return true;
}
const seen = new Map(); // the hook asks several times per call; the watch once per tick
export function workers(root) {
  if (seen.has(root) && Date.now() - seen.get(root).at < 1000) return seen.get(root).out;
  let names = [];
  try { names = fs.readdirSync(workersDir(root)).filter(f => f.endsWith('.json')); } catch {}
  const now = Date.now();
  const out = names.map(f => {
    let w = null;
    try { w = JSON.parse(read(path.join(workersDir(root), f))); } catch {}
    if (!w?.seg) return null;
    const last = mtime(path.join(workersDir(root), f));
    const gone = !w.stopAt && (w.pid ? !alive(w.pid) : now - last >= C.GONE);
    return {
      id: f.slice(0, -5), worker: true, type: w.type || 'external', driver: w.driver || '', desc: w.desc || '', tp: '', seg: w.seg, last,
      stopAt: w.stopAt || (gone ? last : 0), active: !w.stopAt && !gone, gone, cmd: w.cmd || '', cmdAt: w.cmdAt || 0, said: w.said || '',
      asks: w.asks || 0, activityAt: Number(w.activityAt) || last, waiting: w.waiting || null,
    };
  }).filter(Boolean);
  seen.set(root, { at: now, out });
  return out;
}
const forget = (sessionId, root, a) => {
  const base = path.join(a.worker ? workersDir(root) : agentsDir(sessionId), a.id);
  for (const ext of ['json', 'stop']) try { fs.unlinkSync(`${base}.${ext}`); } catch {}
};

// The executors of a goal that started at `since` (tracked subagents, and the project's workers when root is given),
// and which of them are running: not stopped, and for a subagent heard from within GONE (one stopped without a
// SubagentStop looks like this). Read-only callers leave expired records for hook/watch maintenance.
export function goalAgents(sessionId, since, now = Date.now(), root = null, prune = true) {
  const all = [...trackedAgents(sessionId), ...(root ? workers(root) : [])];
  if (prune) for (const a of all) if (now - Math.max(a.last, a.stopAt) > 864e5) forget(sessionId, root, a);
  const agents = all.filter(a => Math.max(a.seg, a.last, a.stopAt) >= since && now - Math.max(a.last, a.stopAt) <= 864e5);
  return { agents, running: agents.filter(a => a.active && (a.worker || now - a.last < C.GONE)) };
}
// When executors handed back (subagents of the session and the project's workers): progress for the checkpoint.
export const handbacks = (sessionId, root) => [...trackedAgents(sessionId), ...workers(root)].map(a => a.stopAt).filter(Boolean);
// A name the main agent knows the subagent by. Claude Code: the description in subagents/agent-<id>.meta.json next to
// the main transcript. Codex: the agent path its rollout's first record names. A worker: what its driver called it.
// Else the id.
export function agentName(a) {
  if (a.desc) return a.desc;
  const tp = String(a.tp || '');
  const own = /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/.test(tp);
  const meta = own ? tp.replace(/\.jsonl$/, '.meta.json') : path.join(tp.replace(/\.jsonl$/, ''), 'subagents', `agent-${a.id}.meta.json`);
  try { const m = JSON.parse(read(meta)); if (m.description) return m.description; } catch {}
  const p = headOf(tp, 8192).match(/"agent_path":"([^"]*)"/)?.[1];
  return p ? path.basename(p) : a.id;
}

// What a running executor is doing: its last sign of life, and the tool call it waits on ({name, at}) if any. A worker:
// what its driver reports (cmd is the command running now). A subagent: its last tool call (the tracker), and the tail
// of its own transcript (Claude Code: <main transcript>/subagents/agent-<id>.jsonl; Codex: its rollout), where a call
// without its result is out. Only its own steps and tool results count, not messages sent to it. The tail is long
// enough to see past a big tool result written while another call is out.
export function activity(a) {
  if (a.worker) return { last: a.activityAt || a.last, wait: a.waiting || (a.cmd ? { name: a.cmd, at: a.cmdAt || a.last } : null) };
  const tp = String(a.tp || ''), own = path.join(tp.replace(/\.jsonl$/, ''), 'subagents', `agent-${a.id}.jsonl`);
  const file = fs.existsSync(own) ? own : /[\\/](agent-|rollout-)[^\\/]*\.jsonl$/.test(tp) ? tp : '';
  let last = a.last;
  const out = new Map();
  for (const o of file ? tailRecords(file, 2 ** 21) : []) {
    const t = Date.parse(o.timestamp) || 0, c = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(c)) {
      last = Math.max(last, t);
      for (const b of c) if (b.type === 'tool_use') out.set(b.id, { name: `${b.name}${b.input?.description || b.input?.command ? `（${clip(b.input.description || b.input.command, 60)}）` : ''}`, at: t });
    } else if (o.type === 'user' && Array.isArray(c) && c.some(b => b.type === 'tool_result')) {
      last = Math.max(last, t);
      for (const b of c) if (b.type === 'tool_result') out.delete(b.tool_use_id);
    } else if (rolloutStep(o, out, t)) last = Math.max(last, t);
  }
  return { last, wait: [...out.values()].at(-1) || null };
}

// One record of a Codex rollout, applied to `out` (the tool calls out, by call_id: {name, at}). Returns 'step' for
// Codex's own step (reasoning, a message, a tool call), 'result' for a tool's output, '' for anything else (what it was
// told, bookkeeping). A turn starting or ending clears what is out.
export function rolloutStep(o, out, at) {
  const p = o.payload || {};
  if (o.type === 'event_msg' && /^(task_started|turn_aborted|task_complete)$/.test(p.type)) out.clear();
  if (o.type !== 'response_item' || (p.type === 'message' && p.role !== 'assistant')) return '';
  if (/_output$/.test(p.type)) { out.delete(p.call_id); return 'result'; }
  if (p.call_id && /_call$/.test(p.type)) out.set(p.call_id, { name: p.name || p.type, at });
  return 'step';
}

// What the main agent should hear about its running executors, as [{who, text}]: a segment past SEGMENT_MAX; silence
// (see C.SILENT), with optional follow-up actions for the main agent to choose. The hook says each once per session
// and logs it. wake: for the background watch, which only wakes the main agent so that the hook says it (the main
// agent doesn't see a background command's output): what the hook hasn't said yet, each once. codex: the main agent
// runs in Codex. wcmd(sub): a codex-worker.mjs command line.
export function executorNotes(running, { now = Date.now(), sessionId, root, codex = false, wcmd, wake = false }) {
  const notes = [], min = t => Math.round((now - t) / 60e3), had = said(sessionId);
  const once = key => (wake ? !had[key] && claimSaid(sessionId, `wake ${key}`, l => !l, now) : claimSaid(sessionId, key, l => !l, now));
  const goal = goalCache(sessionId);
  const timed = timedTools(sessionId).filter(t => goal?.active && t.goal === goal.start);
  // A driver's oldest running command has a stable start even while Codex keeps polling it.
  for (const a of running) if (a.worker && a.cmd && a.cmdAt) timed.push({
    id: `worker ${a.id} ${a.seg}`, at: a.cmdAt, agent: a.id, type: a.type, name: a.cmd,
  });
  for (const t of timed) {
    const elapsed = (t.ended || now) - t.at;
    if (elapsed < C.SLOW_TOOL) continue;
    const key = `slow ${t.id} ${t.at}`;
    const who = t.agent ? `执行者「${t.agent}」` : '主 agent';
    if (once(key)) {
      notes.push({ who, text: `瓶颈检查：${who}的「${t.name}」${t.ended ? '已返回，用时' : '启动后尚未收到完成记录，已经'} ${Math.floor(elapsed / 60e3)} 分钟。输出或轮询不会重置这段计时。让执行者核对有效进度、预计剩余时间和 CPU/GPU/内存占用，回报测试、构建、资源排队或重复验证的耗时证据；主 agent 决定继续等待、缩小验证或优化流程。把证据、决定和复查点记进 notes.md；有正常进度的长任务不要仅因这条提醒而停止或重跑。` });
      if (!wake) log(root, sessionId, 'tool-slow', `${t.agent || 'main'} ${Math.floor(elapsed / 60e3)}min ${t.name}`);
    }
    if (!wake && t.ended && (had[key] || said(sessionId)[key])) try { fs.unlinkSync(t.file); } catch {}
  }
  for (const a of running) {
    const driven = a.driver === 'codex-worker', over = now - a.seg >= C.SEGMENT_MAX;
    // Silence counts from its last sign of life, never earlier than its last tool call.
    const quiet = now - (a.activityAt || a.last) >= C.SILENT;
    if (!over && !quiet) continue;
    const who = a.worker ? `${a.type === 'codex' ? 'Codex 执行者' : '外部执行者'}「${agentName(a)}」（任务 ${a.id}）` : `子代理「${agentName(a)}」（${a.type}）`;
    const say = (text, event = '', detail = '') => {
      if (event && !wake) log(root, sessionId, event, detail);
      notes.push({ who, text: who + text });
    };
    // Offer commands only after the main agent chooses interruption; the hook never stops an executor.
    const ask = what => a.worker
      ? `它跑着的时候收不到消息：${driven ? `用 ${wcmd(`stop ${a.id}`)} 停掉，再在后台运行 ${wcmd(`resume ${a.id} "${what}"`)}` : `用它的驱动停掉，再让同一个线程接着做：“${what}”`}，上下文还在。`
      : codex ? `用 interrupt_agent 打断它，再用 followup_task 对它说：“${what}”，它会带着上下文接着做。`
      : `用 TaskStop 停掉它（${a.id}），再用 SendMessage 对它说：“${what}”，它会带着上下文接着做。`;
    if (over && once(`over ${a.id} ${a.seg}`)) {
      say(a.worker
        ? `这一段已经连续跑了 ${min(a.seg)} 分钟，还没有交回。${a.cmd ? `它正在跑命令「${clip(a.cmd, 120)}」（${min(a.cmdAt)} 分钟）。` : ''}核对约定预算和有效进度，再决定继续或要求阶段回报；一小时是观察提醒，不是统一停止期限。决定打断后可用：${ask('整理现有进度与剩余工作，交阶段回报')}`
        : `这一段已经连续跑了 ${min(a.seg)} 分钟，还没有交阶段回报。核对约定预算和有效进度，再决定继续、追问或停止；不要只因一小时提醒而换人。`);
    }
    if (!quiet) continue;
    const { last, wait } = activity(a);
    const limit = wait ? C.STUCK : C.SILENT, key = `quiet ${a.id} ${a.seg} ${last}`, asked = had[key];
    if (!asked && now - last >= limit && once(key)) {
      say(wait
        ? `在等的工具调用 ${wait.name} 已经 ${min(wait.at)} 分钟没有返回。先核对进度、资源和预算；决定打断后可用：${ask(`说明 ${wait.name} 的进度、剩余时间和是否需要调整`)}`
        : `已经 ${min(last)} 分钟没有任何动静，也不在等工具。这只是活动信号，先核对任务；决定打断后可用：${ask('说明当前进度、阻塞和下一步建议')}`,
      'agent-quiet', `${a.id} ${min(last)}min${wait ? ' tool' : ''}`);
    } else if (asked && now - Math.max(asked, last) >= limit && once(`stuck ${a.id} ${a.seg} ${last}`)) {
      say(`上次提醒之后又 ${min(asked)} 分钟没有动静。核对是否已处理以及 notes.md 中的进度，再决定继续等待、追问或另派；脚本没有自动停止它。`, 'agent-stuck', a.id);
    }
  }
  return notes;
}

// The complete JSON records in the last `bytes` of a JSONL file.
export function tailRecords(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (n < size) lines.shift(); // partial first line
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

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
