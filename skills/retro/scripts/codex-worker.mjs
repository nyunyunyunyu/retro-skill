#!/usr/bin/env node
// Runs a retro executor task as a Codex thread (`codex exec --json`) for a main agent in another harness (Claude Code),
// and registers it as a worker (.retro/workers/, see lib.mjs): the hook counts it in the slots and notices a long
// segment, and the checkpoint sees it hand back. Silence is reported for the main agent to assess; only an explicit
// stop or the hard timeout ends a running turn. Every command takes --root <project>.
//   run <task> [--records <id>] [--brief <file>] [--cd <dir>] [--desc <name>] [--timeout <min>]
//                 a new thread on the brief (default <goal-records>/tasks/<task>/brief.md), working in --cd (default the project)
//   resume <task> <message> [--brief <file>] [--timeout <min>]   the same thread again, in the same directory: a
//                 follow-up, or more time
//   stop <task>   asks the run/resume driving the thread to stop it with its process tree (.retro/workers/<task>.stop)
// run and resume block until the turn ends, so start them in the background; they print how the turn ended and the
// thread's last message, and exit 0 only when the turn completed. The turn is stopped after --timeout (default
// WORKER_MAX). Codex runs in the workspace-write sandbox (RETRO_CODEX may override it) with approval_policy "never":
// nobody can answer a prompt, and without it commands hang waiting for one. Executors get what Claude's have: network
// (off by default in the sandbox) and commits (the sandbox keeps .git read-only, so the repository's git directory is
// added as a writable root).
// The codex command: RETRO_CODEX, else the Codex desktop app's copy on Windows, else codex (lib.mjs codexCommand).
// The thread's events go to the task directory (codex-events.jsonl), its last message to codex-last.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordDir, recordPath, sessions, goalCache, C, alive, codexCommand, dir, mainCheckout, mtime, read, readWorker, rolloutStep, safe, withLock, workerBeat, workerStart, workerStop,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ''; };
const rootArg = opt('--root'), briefArg = opt('--brief'), cdArg = opt('--cd'), descArg = opt('--desc'), timeoutArg = opt('--timeout');
const recordArg = opt('--records');
const [cmd, task, ...words] = args;
const root = mainCheckout(rootArg || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const SELF = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const again = sub => `node "${SELF}" ${sub} --root "${root.replace(/\\/g, '/')}"`;
const fail = msg => { console.log(msg); process.exit(1); };
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const win = process.platform === 'win32';
const TICK = Math.min(1000, C.SILENT / 20);

if (!['run', 'resume', 'stop'].includes(cmd) || !task) fail('用法：node codex-worker.mjs run <任务> [--brief <文件>] [--cd <目录>] [--desc <名字>] [--timeout <分钟>] | resume <任务> <话> | stop <任务>，都要加 --root <项目>');
if (safe(task) !== task) fail(`任务名只用字母、数字、_ 和 -：${task}`);
const prev = readWorker(root, task);
let records;
try {
  const active = sessions(root).filter(s => goalCache(s.session_id)?.active);
  if (recordArg && prev?.recordId && prev.recordId !== recordArg) fail('任务已属于另一份目标记录，请使用新的任务名');
  if (cmd === 'run' && prev?.recordId && !recordArg && (active.length !== 1 || path.basename(recordDir(root, active[0].session_id, goalCache(active[0].session_id).start)) !== prev.recordId)) fail('任务名已属于其他或未确认的目标，请用新任务名或显式 --records');
  if (recordArg || prev?.recordId) records = recordPath(root, recordArg || prev.recordId);
  else if (active.length === 1) records = recordDir(root, active[0].session_id, goalCache(active[0].session_id).start);
  else if (active.length > 1) fail('有多个活跃目标，必须用 --records <记录ID> 指定归属');
  else fail('请用 --records <记录ID> 指定任务归属');
  if (!mtime(path.join(records, 'goal.json'))) fail('目标记录不存在');
} catch (error) { fail(error.message); }
const recordId = path.basename(records);
const taskDir = path.join(records, 'tasks', task), workersDir = path.join(dir(root), 'workers');
const stopFile = path.join(workersDir, `${task}.stop`), lockFile = path.join(workersDir, `${task}.lock`);
const lastFile = path.join(taskDir, 'codex-last.md'), eventsFile = path.join(taskDir, 'codex-events.jsonl');
const isRunning = w => !!w && !w.stopAt && !!w.pid && alive(w.pid);
let exe, pre;
try { [exe, ...pre] = codexCommand(); } catch { fail('RETRO_CODEX 不是合法的 JSON 数组。'); }

if (cmd === 'stop') stop();

if (isRunning(prev)) fail(`${task} 还在跑（进程 ${prev.pid}）。要追问就等它这一轮结束后用 resume；要停就先 ${again(`stop ${task}`)}。`);
const resume = cmd === 'resume';
// A worker record pruned after a day: the thread and directory are still in the task's event log.
const logged = prev ? {} : fromEvents();
const thread0 = resume ? (prev ? prev.thread : logged.thread) : null;
if (resume && !thread0) fail(`${task} 没有可以接着的线程：先用 run 开始。`);
const prompt = briefArg !== null ? read(briefArg) : resume ? words.join(' ') : read(path.join(taskDir, 'brief.md'));
if (!prompt.trim()) fail(resume ? '没有要说的话：resume <任务> <话>，或者 --brief <文件>。' : `任务说明是空的：写进 ${path.join(taskDir, 'brief.md')}，或者用 --brief <文件>。`);
const cwd = path.resolve(cdArg || (resume && (prev?.cwd || logged.cwd)) || root);
if (!fs.existsSync(cwd)) fail(`目录不存在：${cwd}`);
const timeout = Number(timeoutArg) > 0 ? Number(timeoutArg) * 60e3 : C.WORKER_MAX;
// Sandbox settings RETRO_CODEX gives are left alone. approval_policy is always "never", since a prompt would hang.
const given = key => pre.some(a => String(a).startsWith(`${key}=`));
const config = given('sandbox_mode') ? [] : ['-c', 'sandbox_mode="workspace-write"'];
if (!given('sandbox_workspace_write.network_access')) config.push('-c', 'sandbox_workspace_write.network_access=true');
// The report goes under the project's .retro/, which a worktree or another directory doesn't contain.
const rel = path.relative(cwd, dir(root));
const writable = [(rel.startsWith('..') || path.isAbsolute(rel)) && dir(root), gitDir(cwd)].filter(Boolean);
const ownRoots = given('sandbox_workspace_write.writable_roots');
if (writable.length && !ownRoots) config.push('-c', `sandbox_workspace_write.writable_roots=[${writable.map(d => JSON.stringify(d.replace(/\\/g, '/'))).join(',')}]`);
const desc = descArg || (resume ? '' : clip(prompt.split('\n').find(l => l.trim())?.replace(/^#+\s*/, ''), 60));
fs.mkdirSync(taskDir, { recursive: true });
fs.mkdirSync(workersDir, { recursive: true });

// Check and register under a lock, so two runs of the same task can't both start.
const started = Date.now();
let seg, child = null, thread = thread0, said = '', error = '', stderr = '', why = null, buf = '', exited = false, exitCode = null;
let beat = 0, spawnError = null, launchedAt = 0, sign = 0;
const inflight = new Map(); // commands running now, by item id: Codex may run several at once
const out = new Map(); // tool calls the rollout shows without their output yet
const ro = { file: '', off: 0, rest: Buffer.alloc(0), lookedAt: 0, saved: '' };
const got = withLock(lockFile, () => {
  if (isRunning(readWorker(root, task))) return 'busy';
  for (const f of [lastFile, stopFile]) try { fs.unlinkSync(f); } catch {}
  seg = workerStart(root, task, { desc, type: 'codex', driver: 'codex-worker', pid: process.pid, thread: thread0, cwd, recordId }).seg;
  try {
    launch(thread0, prompt);
    workerBeat(root, task, { child: child.pid ?? null }, seg);
  } catch (e) {
    if (child) kill();
    workerStop(root, task, { why: 'launch-failed' }, seg);
    return e;
  }
  try { fs.appendFileSync(eventsFile, JSON.stringify({ type: 'retro.run', cwd, at: new Date(started).toISOString() }) + '\n'); } catch {}
  return 'ok';
}, 20);
if (got === undefined || got === 'busy') fail(`${task} 正在由另一个 run/resume 启动或在跑。`);
if (got !== 'ok') fail(`没能启动 codex（${got.code || got.message}）：RETRO_CODEX 要指向一个可执行文件（Windows 上是 .exe，不能是 .cmd）。`);

// Starts codex on `text`: a new thread, or an explicitly resumed thread t. Throws
// when it can't be spawned.
function launch(t, text) {
  const argv = [...pre, ...config, '-c', 'approval_policy="never"', 'exec', ...(t ? ['resume'] : []), '--json', '--skip-git-repo-check',
    ...(t ? [] : ['-C', cwd]), '-o', lastFile, ...(t ? [t] : []), '-'];
  // A thread resumed: only what it appends from now on (what a stopped turn left is done with). A new one: its whole
  // rollout, once it shows up.
  if (t && !ro.file) ro.file = prev?.rollout?.endsWith(`-${t}.jsonl`) && fs.existsSync(prev.rollout) ? prev.rollout : findRollout(t);
  if (t && ro.file) { ro.off = size(ro.file); ro.rest = Buffer.alloc(0); }
  const c = spawn(exe, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !win });
  child = c; exited = false; exitCode = null; buf = ''; launchedAt = sign = Date.now();
  inflight.clear(); out.clear();
  c.stdin.on('error', () => {});
  c.stdin.end(text);
  c.stdout.setEncoding('utf8');
  c.stderr.setEncoding('utf8');
  c.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) onLine(buf.slice(0, i));
  });
  c.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
  c.on('error', e => { spawnError = e; });
  let drain = null;
  c.on('exit', code => {
    exited = true; exitCode = code;
    // A process it left running in the background may hold its output pipes open: don't wait for that.
    drain = setTimeout(() => { c.stdout.destroy(); c.stderr.destroy(); }, 2000);
  });
  c.on('close', code => {
    clearTimeout(drain);
    onLine(buf); buf = '';
    finish(exitCode ?? code);
  });
}

function onLine(line) {
  if (!line.trim()) return;
  let e = null;
  try { e = JSON.parse(line); } catch {}
  const it = e?.item || {}, kv = {};
  // Command output can be huge; the log keeps its start.
  const keep = line.length > 20000 && it.aggregated_output ? JSON.stringify({ ...e, item: { ...it, aggregated_output: clip(it.aggregated_output, 4000) } }) : line;
  try { fs.appendFileSync(eventsFile, keep + '\n'); } catch {}
  if (!e) return;
  sign = Date.now();
  if (e.type === 'thread.started' && e.thread_id) kv.thread = thread = e.thread_id;
  if (it.type === 'command_execution') {
    // Codex quotes the shell's full path ("C:\\…\\powershell.exe" -Command '…'): its name is enough.
    if (e.type === 'item.started') inflight.set(it.id, { cmd: clip(String(it.command).replace(/^"[^"]*?([^"\\/]+)"/, '$1'), 300), at: Date.now() });
    if (e.type === 'item.completed') inflight.delete(it.id);
    const cur = [...inflight.values()][0];
    Object.assign(kv, { cmd: cur?.cmd ?? null, cmdAt: cur?.at ?? 0 });
  }
  if (it.type === 'agent_message' && e.type === 'item.completed' && it.text?.trim()) {
    said = it.text; kv.said = clip(it.text, 300);
  }
  if (it.type === 'error' && /code-mode host/i.test(it.message)) stderr += it.message;
  if (e.type === 'turn.failed' || e.type === 'error') error = e.error?.message || e.message || line;
  ping(kv);
}

// A sign of life for the worker record; one that changes nothing, once a second is enough.
function ping(kv = {}) {
  if (!Object.keys(kv).length && Date.now() - beat < 1000) return;
  beat = Date.now();
  const command = [...inflight.values()][0];
  const waiting = [...out.values()][0] || (command ? { name: command.cmd, at: command.at } : null);
  workerBeat(root, task, { ...kv, activityAt: sign, waiting, childAt: launchedAt }, seg);
}

// The thread's rollout: every step Codex takes, including each poll of a command still running, which the --json
// events leave out. A response item is its own step; a tool call stays out until its output.
function follow() {
  if (!ro.file) {
    if (!thread || Date.now() - ro.lookedAt < Math.min(5000, 5 * TICK)) return;
    ro.lookedAt = Date.now();
    if (!(ro.file = findRollout(thread))) return;
  }
  if (ro.saved !== ro.file) ping({ rollout: (ro.saved = ro.file) });
  const n = size(ro.file);
  if (n <= ro.off) return;
  const b = Buffer.alloc(n - ro.off);
  try { const fd = fs.openSync(ro.file, 'r'); fs.readSync(fd, b, 0, b.length, ro.off); fs.closeSync(fd); } catch { return; }
  ro.off = n;
  const all = Buffer.concat([ro.rest, b]), cut = all.lastIndexOf(10) + 1;
  ro.rest = all.subarray(cut);
  for (const line of all.toString('utf8', 0, cut).split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (rolloutStep(o, out, Date.now())) sign = Date.now();
  }
  ping();
}

// Only while it runs: once it exited, its pid may belong to another process. A stop landing after it exited (while
// its output drains) doesn't change how the turn ended. Elsewhere than Windows, a codex that ignores SIGTERM gets
// SIGKILL 10 s later.
function end(reason) {
  if (why || exited) return;
  why = reason;
  if (!exited) kill();
}
function kill() {
  const c = child;
  killTree(c.pid);
  if (!win) setTimeout(() => { if (c === child && !exited) try { process.kill(-c.pid, 'SIGKILL'); } catch {} }, 10e3).unref();
}
const timer = setTimeout(() => end('timeout'), timeout);
const ticker = setInterval(() => {
  if (read(stopFile).trim() === String(seg)) end('stopped');
  follow();
  ping();
}, TICK);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => end('stopped'));

function finish(code) {
  clearTimeout(timer); clearInterval(ticker);
  // Serialize stop-file cleanup with run/resume, so an old driver cannot erase a new segment's stop request.
  const saved = withLock(lockFile, () => {
    if (readWorker(root, task)?.seg !== seg) return false;
    workerStop(root, task, { exit: code, why }, seg);
    try { fs.unlinkSync(stopFile); } catch {}
    return true;
  }, 50);
  if (saved === undefined) fail(`无法登记 ${task} 的结束状态：状态仍被占用，请用 status 核对。`);
  const report = path.join(taskDir, 'report.md');
  const how = spawnError ? `没能启动 codex（${spawnError.code || spawnError.message}）：检查 RETRO_CODEX 和工作目录 ${cwd}`
    : why === 'timeout' ? `超过 ${Math.round(timeout / 60e3)} 分钟，已停止` : why === 'stopped' ? '已被停止'
    : code === 0 ? '这一轮结束' : `异常结束（退出码 ${code}）`;
  const lines = [`Codex 执行者 ${task}：${how}。线程 ${thread || '无'}，用时 ${Math.round((Date.now() - started) / 60e3)} 分钟。`];
  if (error) lines.push(`错误：${clip(error, 600)}`);
  if (/code-mode host/i.test(stderr)) lines.push(`这个 codex（${exe}）缺 codex-code-mode-host，跑不了命令：装上 Codex 桌面版，或者把 RETRO_CODEX 指向带它的 codex（见 retro 的 README）。`);
  else if (code !== 0 && !why && stderr.trim()) lines.push(`codex 的报错（末尾）：${clip(stderr.slice(-1500), 1500)}`);
  if (writable.length && ownRoots) lines.push(`注意：RETRO_CODEX 自己设了 writable_roots，驱动没有加 ${writable.join('、')}：要提交或写回报，那里面得有它们。`);
  lines.push(mtime(report) >= started ? `回报：${report}` : '这一轮没有写 report.md。');
  if (why && thread) lines.push(`需要补阶段回报时，可在后台运行 ${again(`resume ${task} "整理现有结果，交阶段回报，不继续执行"`)}。`);
  const last = read(lastFile).trim() || said.trim();
  lines.push(`最后的话：\n${last.length > 4000 ? `${last.slice(0, 4000)}…（全文见 ${lastFile}）` : last || '（无）'}`);
  console.log(lines.join('\n'));
  process.exit(why || spawnError ? 1 : code ?? 1);
}

// Asks the driver to stop this segment: it holds its child, so it can't hit another process that got the pid. A driver
// that is gone took its codex with it on Windows (a child dies with node's job object); elsewhere codex runs in its own
// process group and may live on, so end that group if it is still the one this segment started.
function stop() {
  if (!prev || prev.stopAt) fail(`${task} 没有在跑。`);
  fs.mkdirSync(workersDir, { recursive: true });
  const requested = withLock(lockFile, () => {
    if (readWorker(root, task)?.seg !== prev.seg) return false;
    fs.writeFileSync(stopFile, String(prev.seg));
    return true;
  }, 50);
  if (requested === undefined) fail(`${task} 状态被占用，请重试 stop。`);
  if (!requested) fail(`${task} 已经开始了新的一段，没有停它；要停就再运行一次 stop。`);
  const live = isRunning(prev);
  const cur = () => readWorker(root, task);
  for (const t0 = Date.now(); live && Date.now() - t0 < 15e3 && !cur()?.stopAt && cur()?.seg === prev.seg; ) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  if (cur()?.seg !== prev.seg) fail(`${task} 已经开始了新的一段，没有停它；要停就再运行一次 stop。`);
  if (cur()?.stopAt) { console.log(`已停止 ${task}。在后台跑它的 run/resume 会交出输出。`); process.exit(0); }
  const own = !win && sameProcess(prev.child, prev.childAt || prev.seg);
  if (own) killTree(prev.child);
  const stopped = withLock(lockFile, () => {
    if (readWorker(root, task)?.seg !== prev.seg) return false;
    workerStop(root, task, { why: 'stopped' }, prev.seg);
    try { fs.unlinkSync(stopFile); } catch {}
    return true;
  }, 50);
  if (stopped === undefined) fail(`${task} 状态被占用，请重试 stop。`);
  if (!stopped) fail(`${task} 已经开始了新的一段，没有停它；要停就再运行一次 stop。`);
  const what = win ? (live ? '没有结束任何进程（这个进程号可能已经是别的程序）' : 'Codex 进程随它一起结束；它起的命令如果还在跑，要手动结束')
    : own ? '直接结束了 Codex 进程组' : 'Codex 进程也已经不在了';
  console.log(`已停止 ${task}：${live ? '驱动没有响应' : '驱动已经不在了'}，${what}。`);
  process.exit(0);
}

// POSIX: pid is still the codex process started at `at` (pids get reused).
function sameProcess(pid, at) {
  if (!pid || !alive(pid)) return false;
  const [etimes, comm] = spawnSync('ps', ['-p', String(pid), '-o', 'etimes=,comm='], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
  return !!comm && path.parse(comm).name === path.parse(exe).name && Math.abs(Date.now() - Number(etimes) * 1000 - at) < 10e3;
}

// The process and everything it started: Codex runs commands in child processes.
function killTree(pid) {
  if (!pid) return;
  if (win) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-pid, 'SIGTERM'); } catch {}
}

// The thread's rollout, <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl under the local date it started (a
// resumed thread appends to its own), looked for in the past week; '' if it isn't there.
function findRollout(id) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), d = new Date();
  for (let i = 0; i < 8; i++, d.setDate(d.getDate() - 1)) {
    const day = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try { const n = fs.readdirSync(day).find(x => x.endsWith(`-${id}.jsonl`)); if (n) return path.join(day, n); } catch {}
  }
  return '';
}
function size(f) { try { return fs.statSync(f).size; } catch { return 0; } }

// The repository's git directory, shared by its worktrees (commits write there), or '' outside a repository.
function gitDir(d) {
  const r = spawnSync('git', ['-C', d, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.resolve(d, r.stdout.trim()) : '';
}

// The last thread and working directory in the task's event log.
function fromEvents() {
  const out = {};
  for (const l of read(eventsFile).split('\n')) {
    if (l.includes('"thread.started"')) out.thread = l.match(/"thread_id":"([^"]+)"/)?.[1] || out.thread;
    if (l.startsWith('{"type":"retro.run"')) try { out.cwd = JSON.parse(l).cwd; } catch {}
  }
  return out;
}
