#!/usr/bin/env node
// Hook for Claude Code and Codex (PostToolUse, Stop, SubagentStop) that enhances /goal. It only acts while the session
// has an active /goal, read from the session transcript (Claude Code: goal_status attachments and "Goal cleared"
// records; Codex: thread_goal_updated events, overruled by its goal database). These are internal formats; if they
// change, it goes quiet.
//
// Retro: due once, since max(goal start, last `retro.mjs done`), 60 min have passed, 4 results came back (distinct
// subagents finishing, or new task reports) or the main agent made 40 tool calls. Then it nudges on the first main
// tool call and every 10 after, and blocks the main agent's Stop (once per stretch of tool calls) until marked done.
// Background slot: one route review or idea scout at a time per project, state in .retro/slot. Only this hook reserves
// it (under an exclusive lock): at goal start (a scout), then hourly; a scout when none ran for 4 h or the idea pool
// runs low, otherwise a review. If nothing new came back in the past hour it reserves nothing and reports a stall.
// A reservation must be launched within 20 min; the review/scout then has 20/40 min. Any session voids overdue ones.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  C, SLOT_AGENTS, ensureDir, iso, lastRetro, limitOf, locked, log, mainCheckout, newestResult, openIdeas, progressGoal,
  read, readSlot, reports, sessions, writeSlot,
} from './lib.mjs';

const now = Date.now();
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch {}
const event = input.hook_event_name || 'PostToolUse';
// Diagnostics: while <tmp>/claude-retro-debug exists, log each event's metadata to claude-retro-debug.log.
const debug = path.join(os.tmpdir(), 'claude-retro-debug');
if (fs.existsSync(debug)) {
  try {
    const { session_id, agent_id, agent_type, stop_hook_active, tool_name, background_tasks, cwd, transcript_path } = input;
    const toolKeys = input.tool_input && typeof input.tool_input === 'object' ? Object.keys(input.tool_input) : typeof input.tool_input;
    fs.appendFileSync(debug + '.log', JSON.stringify({ t: iso(now), event, session_id, agent_id, agent_type, stop_hook_active, tool_name, background_tasks, cwd, transcript_path, keys: Object.keys(input), toolKeys }) + '\n');
  } catch {}
}
if (!['PostToolUse', 'Stop', 'SubagentStop'].includes(event) || typeof input.transcript_path !== 'string') process.exit(0);

const sid = String(input.session_id).replace(/[^\w-]/g, '_');
const base = path.join(os.tmpdir(), `claude-retro-${sid}`);
const me = `${now} ${process.pid}`;
const ts = l => parseInt(l, 10);
const RESUME = /^\s*\/?(resume|continue|restart|unpause|go on|恢复|继续)\s*[.!。！]?\s*$/i;

if (event === 'SubagentStop') {
  // A subagent finished: a result, keyed by agent id so follow-ups to the same agent count once. Skip the
  // review/scout agents, internal ones (/btw, prompt suggestions) that report an empty agent_type, and Codex's
  // approval reviewers.
  if (input.agent_type && !SLOT_AGENTS.has(input.agent_type) && !/guardian/i.test(input.agent_type)) {
    try { fs.appendFileSync(base + '.log', `${me} r ${String(input.agent_id || process.pid).replace(/\s/g, '')}\n`); } catch {}
  }
  process.exit(0);
}
// Tool calls inside a subagent share the session id; a nudge there would reach the subagent, not the main agent.
if (input.agent_id) process.exit(0);

const goal = goalState(input.transcript_path, base + '.goal');
if (!goal.active || goal.child) process.exit(0);

const stopping = event === 'Stop';
const root = mainCheckout(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const CLI = fileURLToPath(new URL('./retro.mjs', import.meta.url)).replace(/\\/g, '/');
const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url)).replace(/\\/g, '/');
const cmd = sub => `\`node "${CLI}" ${sub} --root "${root.replace(/\\/g, '/')}"\``;
const notes = [];

// One line per main tool call ("<ms> <pid>") and per result ("<ms> <pid> r <agent>"), appended so parallel calls
// don't lose counts. A tool call counts only up to its own line, so parallel calls neither skip nor duplicate a nudge.
let lines = [];
try {
  if (!stopping) fs.appendFileSync(base + '.log', me + '\n');
  lines = read(base + '.log').split('\n').filter(Boolean);
} catch {}
const isResult = l => / r( |$)/.test(l);
const calls = lines.filter(l => !isResult(l));
const upTo = stopping ? calls : calls.slice(0, calls.lastIndexOf(me) + 1);
const resultLines = lines.filter(isResult);

// /goal blocks every unfinished Stop, so stop_hook_active stays true for the whole run and can't tell turns apart.
// Speak at a Stop only if the main agent made a tool call since this hook last blocked; otherwise change nothing.
const lastBlock = read(base + '.blocked').trim();
if (stopping && lastBlock !== '' && calls.length <= Number(lastBlock)) process.exit(0);

try { if (!stopping) launched(); } catch {}
try { userInbox(); } catch {}
try { goalNote(); } catch {}
try { sessionFile(); } catch {}
try { retroNudge(); } catch {}
try { slot(); } catch {}

if (notes.length) {
  const text = notes.join('\n');
  if (stopping) {
    try { fs.writeFileSync(base + '.blocked', String(calls.length)); } catch {}
    process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
  } else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
  }
}

// The main agent just launched the reserved review/scout: mark it started, so a Stop right after isn't told otherwise.
// Only an exact agent name counts: Claude Code's Agent (formerly Task) tool names it in subagent_type; another spawn
// tool (Codex) in some field. Todo tools (TaskCreate…) and prompts that merely mention the name don't.
function launched() {
  const ti = input.tool_input || {};
  const tool = String(input.tool_name);
  const named = /^(Agent|Task)$/.test(tool) ? [ti.subagent_type] : /spawn/i.test(tool) ? Object.values(ti) : [];
  if (!named.length) return;
  const s = readSlot(root);
  if (s.state !== 'running' || s.spawned || s.by !== sid) return;
  if (!named.includes(s.type === 'scout' ? 'idea-scout' : 'route-reviewer')) return;
  if (locked(root, t => {
    if (t.state !== 'running' || t.spawned || t.kv.start !== s.kv.start) return false;
    writeSlot(root, { ...t.kv, spawned: iso(now) });
    return true;
  })) log(root, sid, 'launched', `${s.type} ${s.kv.start}`);
}

// What the user said at the progress desk (`retro.mjs tell`): messages addressed to this session are handed over
// once and kept in user-said.md; ones nobody picked up within 6 h go there too, marked undelivered.
function userInbox() {
  const inbox = path.join(root, '.retro', 'user-inbox.jsonl');
  if (!fs.existsSync(inbox) || !fs.statSync(inbox).size) return;
  const mine = locked(root, () => {
    const keep = [], got = [], said = [];
    for (const l of read(inbox).split('\n').filter(Boolean)) {
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      if (m.to === input.session_id) { got.push(m.text); said.push(`- ${m.at} ${m.text}`); }
      else if (now - Date.parse(m.at) > 6 * 3600e3) said.push(`- ${m.at} （没有送达）${m.text}`);
      else keep.push(l + '\n');
    }
    if (said.length) fs.appendFileSync(path.join(root, '.retro', 'user-said.md'), said.join('\n') + '\n');
    fs.writeFileSync(inbox, keep.join(''));
    return got;
  });
  if (!mine?.length) return;
  const text = mine.join('\n');
  log(root, sid, 'told', text);
  notes.push(`用户在进度台说了下面的话，转给你（按 retro skill 第 1 节优先处理：先分清是指令、想法还是问题；长期有效的指令马上记进 PROGRESS.md 的“用户指令”；需要回答的，在回复里回答）：\n${text}`);
}

// Record the session holding the goal, so the progress desk can find its transcript.
// `unfinished` is the last goal this session replaced before it was done, for "/goal resume" in a later session.
function sessionFile() {
  const f = path.join(root, '.retro', 'sessions', `${sid}.json`);
  const want = JSON.stringify({ session_id: input.session_id, transcript_path: input.transcript_path, cwd: root, goal: goal.cond, goal_start: iso(goal.start), unfinished: goal.unfinished || undefined });
  const had = read(f);
  if (had === want) return;
  ensureDir(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.writeFileSync(f, want, { flag: had ? 'w' : 'wx' }); } catch { return; } // parallel first calls: one logs
  let old = {};
  try { old = JSON.parse(had); } catch {}
  if (old.goal !== goal.cond || old.goal_start !== iso(goal.start)) log(root, sid, 'goal', goal.cond);
}

// Once per goal: warn when "/goal resume" was taken literally, or a new /goal replaced an unfinished one.
function goalNote() {
  const resumeLike = RESUME.test(goal.cond);
  if (!resumeLike && !(goal.prev && goal.replaced)) return;
  if (read(base + '.told') === String(goal.start)) return;
  fs.writeFileSync(base + '.told', String(goal.start));
  if (resumeLike) {
    // PROGRESS.md holds the long-term goal; a temporary goal set in between may be the most recent one.
    const all = sessions(root);
    const orig = [progressGoal(root), goal.unfinished, ...all.map(s => s.unfinished), goal.prev, ...all.map(s => s.goal), ...goal.past.map(p => p.cond).reverse()]
      .find(g => g && !RESUME.test(g));
    notes.push(`注意：当前 /goal 的条件只是字面上的「${goal.cond}」。Claude Code 的 /goal 没有恢复子命令，这样设的是一个新目标，评估器会按这几个字判断是否达成，原来的目标并没有恢复。请在回复里告诉用户：要恢复原目标，用 /goal 加原文重新设置。${orig ? `原目标是「${orig}」。` : '原文可以从 PROGRESS.md 的“目标”一栏找到。'}`);
  } else {
    notes.push(`注意：/goal 刚被换成新条件，原来未完成的目标被替换了。原目标是「${goal.prev}」。如果新目标只是临时任务，完成时在回复里提醒用户用 /goal 加原文恢复。`);
  }
}

function retroNudge() {
  const R = Math.max(goal.start, lastRetro(root));
  // When each result first came back after R: per distinct subagent, and per new task report.
  const first = new Map();
  for (const l of resultLines) {
    const [t, pid, , id] = l.split(' ');
    const k = id || `${pid}:${t}`;
    if (+t > R && !(first.get(k) <= +t)) first.set(k, +t);
  }
  const back = [...first.values()];
  const rep = reports(root).filter(r => !r.scout && r.born > R).map(r => r.born);
  const resultsAt = t => Math.max(back.filter(x => x <= t).length, rep.filter(x => x <= t).length);
  const dueAt = (t, k) => k >= C.RETRO_CALLS || resultsAt(t) >= C.RETRO_RESULTS || t - R >= C.RETRO_AFTER;
  const since = upTo.filter(l => ts(l) > R);
  if (!dueAt(now, since.length)) return;
  let nudge = stopping;
  if (!stopping) {
    // The first call at which it became due, then every REPEAT calls: decided by the log alone, so parallel calls agree.
    const firstDue = since.findIndex((l, i) => dueAt(ts(l), i + 1));
    const k = since.length - 1;
    nudge = firstDue >= 0 && (k - firstDue) % C.REPEAT === 0;
    if (nudge && k === firstDue) log(root, sid, 'retro-due', `${Math.round((now - R) / 60e3)}min ${resultsAt(now)}results ${since.length}calls`);
  }
  if (!nudge) return;
  let text = `复盘到期（距上次复盘或目标开始 ${Math.round((now - R) / 60e3)} 分钟，期间交回 ${resultsAt(now)} 个结果，主会话 ${since.length} 次工具调用）。先做完手头这一步，不要打断正在进行的事；到下一个断点时按 retro skill（${SKILL}）复盘：先运行 ${cmd('inbox')} 收集交回的内容，最后运行 ${cmd('done')}，这个提醒随之停止。`;
  const size = fs.existsSync(path.join(root, 'PROGRESS.md')) ? fs.statSync(path.join(root, 'PROGRESS.md')).size : 0;
  if (size > C.PROGRESS_MAX) text += ` PROGRESS.md 现在 ${(size / 1024).toFixed(1)} KB，超过 4 KB：这次复盘先压缩它（命令和环境移到 RUNBOOK.md，过程细节移到任务笔记）。`;
  notes.push(text);
}

function slot() {
  let s = readSlot(root);
  const mine = () => s.by === sid;
  const repeat = stopping || (upTo.length > 0 && upTo.length % C.REPEAT === 0);
  const spawnText = (type, start) => {
    const name = type === 'scout' ? 'idea-scout' : 'route-reviewer';
    const how = goal.codex
      ? `用 spawn_agent 启动 ${name} 子代理（agent_type 设为 "${name}"，fork_turns 设为 "none"），message 写`
      : `在后台启动 ${name} 子代理（Agent 工具，subagent_type 设为 ${name}，run_in_background 设为 true），提示写`;
    return `${how}：“${type === 'scout' ? '侦察本项目' : '评审本项目的路线'}。开始时间 ${start}；脚本 ${CLI}；项目 ${root.replace(/\\/g, '/')}”。`;
  };
  const stopNote = '你启动的后台评审/侦察超过时间上限，已自动作废。能停就停掉它（Claude Code 用 TaskStop，Codex 用对应的停止子代理工具）；停不掉也没关系，它交结论时会发现已作废，不会写入。';
  // Tell the owner once to stop a voided subagent it launched, then drop `spawned` so it isn't told again.
  const tellOwner = start => locked(root, t => {
    if (t.state !== 'aborted' || t.kv.start !== start || !t.spawned || t.by !== sid) return false;
    writeSlot(root, { ...t.kv, spawned: null });
    return true;
  });

  if (s.state === 'running') {
    // My own reservation, never launched, left over from an earlier goal. A launched one runs to its deadline; another
    // session's waits out its 20 minutes. The deadline includes the grace `finish` allows.
    const stale = s.start < goal.start && !s.spawned && mine();
    const late = s.spawned ? now - s.spawnedAt >= limitOf(s.type) + C.GRACE : now - s.start >= C.LAUNCH_MAX;
    if (stale || late) {
      // Any session may void it (keeping `spawned`, so the owner still learns to stop it).
      const voided = locked(root, t => {
        if (t.state !== 'running' || t.kv.start !== s.kv.start) return false;
        writeSlot(root, { ...t.kv, state: 'aborted', end: iso(now) });
        return true;
      });
      if (voided) log(root, sid, stale ? 'slot-stale' : s.spawned ? 'slot-timeout' : 'slot-unlaunched', `${s.type} ${s.kv.start}`);
      if (voided && mine() && s.spawned && tellOwner(s.kv.start)) notes.push(stopNote);
      if (!stale) return;
      s = readSlot(root);
    } else {
      if (!s.spawned && mine() && repeat) notes.push(`你登记的后台${s.type === 'scout' ? '侦察' : '评审'}还没有启动：${spawnText(s.type, s.kv.start)}已经启动过就不用管。`);
      return;
    }
  }
  if (s.state === 'aborted' && s.spawned && mine()) {
    if (tellOwner(s.kv.start)) notes.push(stopNote);
    return;
  }
  const resultTimes = resultLines.map(ts);
  const plan = t => {
    if (t.state === 'running') return null;
    const first = t.start < goal.start; // nothing reserved yet for this goal
    if (!first && now - t.start < C.SLOT_EVERY) return null;
    if (!first && newestResult(root, resultTimes) < t.start) return { stall: true };
    const lastScout = t.lastScout >= goal.start ? t.lastScout : 0;
    const open = openIdeas(root);
    const scout = !lastScout || now - lastScout >= C.SCOUT_EVERY || (open !== null && open < C.OPEN_IDEAS_MIN && t.type !== 'scout');
    return { type: scout ? 'scout' : 'review' };
  };
  if (!plan(s)) return;
  const got = locked(root, t => {
    const p = plan(t);
    if (!p) return null;
    const start = iso(now);
    if (p.stall) writeSlot(root, { state: 'stalled', type: 'stall', start, by: sid, lastScout: t.kv.lastScout });
    else writeSlot(root, { state: 'running', type: p.type, start, by: sid, lastScout: p.type === 'scout' ? start : t.kv.lastScout });
    return { ...p, start };
  });
  if (!got) return;
  if (got.stall) {
    log(root, sid, 'stall', '');
    notes.push('过去 1 小时没有任何新结果（子代理交回、任务回报、总表、提交都没有），这一轮不做路线评审。先查原因：名额是不是空着、任务是不是太大又没有阶段回报、是不是在串行地等、资源是不是在排队；然后补上任务，并把原因写进下次复盘。');
  } else {
    log(root, sid, 'slot-reserved', `${got.type} ${got.start}`);
    notes.push(`已为你登记一次后台${got.type === 'scout' ? '侦察' : '评审'}（同一项目同一时间只有一个）：到下一个断点时${spawnText(got.type, got.start)}要在 20 分钟内启动，不要等它，接着调度。`);
  }
}

// The thread's goal row in Codex's goal database (<CODEX_HOME>/goals_<n>.sqlite, table thread_goals): the agent
// completing it, a token or usage limit, and /goal clear (which deletes the row) show only there. Returns the row,
// null when the thread has none, undefined when the database can't be read (then the rollout is all there is).
function codexGoal(thread) {
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

// Latest goal state of the transcript. The cache keeps the byte offset already scanned, so each run reads only what
// was appended since; a corrupt or missing cache just means one full scan. A goal is identified by its condition
// text (Codex: its createdAt), so the goal_status record Claude Code rewrites on resume or compaction doesn't restart
// it; a condition that extends the current one ("…，成功后…") counts as the same goal, and so does one set again
// within 12 h after it stopped (paused with /goal clear, or set aside for a temporary goal): it keeps its start.
// Codex's rollout only records what the user sets, pauses or resumes, so its goal database has the last word.
function goalState(transcript, cacheFile) {
  // v: bump whenever a field is added that is only computed on a full scan, so older caches get rebuilt.
  const fresh = { v: 2, path: transcript, off: 0, active: false, start: 0, cond: '', prev: '', replaced: false, unfinished: '', past: [], codex: false, child: false };
  const norm = s => String(s ?? '').trim();
  const same = (a, b) => norm(a) === norm(b) || (norm(b) !== '' && norm(a).startsWith(norm(b)));
  // The current goal stops being current: remember it (last 5), so setting it again soon continues it.
  const shelve = (st, at) => {
    if (norm(st.cond)) st.past = [...st.past.filter(p => norm(p.cond) !== norm(st.cond)), { cond: st.cond, start: st.start, end: at }].slice(-5);
  };
  // One goal record: active or not, its condition (null: unchanged), its creation time (Codex only, else 0).
  const apply = (st, at, active, cond, created) => {
    const changed = cond !== null && norm(cond) !== norm(st.cond);
    if (active && st.active && created && created === st.start) {
      if (cond !== null) st.cond = cond; // Codex: the same goal, its objective edited in place
    } else if (active && changed && st.active && !created && same(cond, st.cond)) {
      st.cond = cond; // extended the same goal
    } else if (active && (changed || !st.active || (created && created !== st.start))) {
      // A new goal, or a goal set again (Codex: a different createdAt means a new one).
      const c = cond ?? st.cond;
      if (st.active) shelve(st, at);
      const back = created ? null : [...st.past].reverse().find(p => same(c, p.cond) && at - p.end < C.SAME_GOAL_GAP);
      st.replaced = st.active && changed && !back;
      if (st.replaced) st.unfinished = st.cond;
      if (back && same(st.unfinished, back.cond)) st.unfinished = '';
      st.prev = changed ? st.cond : '';
      st.cond = c;
      st.start = created || back?.start || at;
    } else if (!active && st.active) {
      shelve(st, at);
    }
    st.active = active;
  };
  let st = fresh;
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c.v === fresh.v) st = { ...fresh, ...c };
  } catch {}
  try {
    const fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    if (st.path !== transcript || size < st.off) st = { ...fresh };
    const buf = Buffer.alloc(size - st.off);
    fs.readSync(fd, buf, 0, buf.length, st.off);
    fs.closeSync(fd);
    const end = buf.lastIndexOf(10) + 1; // complete lines only
    // A Codex rollout starts with session_meta; a Codex subagent's names its parent and never holds the goal.
    if (st.off === 0) {
      const head = buf.toString('utf8', 0, Math.min(end, 8192));
      st.codex = /^\{"timestamp":"[^"]*",("ordinal":\d+,)?"type":"session_meta"/.test(head);
      st.child = head.includes('"source":{"subagent"');
    }
    const hits = new Set();
    for (const pat of ['"type":"goal_status"', 'Goal cleared', '"type":"thread_goal_updated"']) {
      for (let i = buf.indexOf(pat); i >= 0 && i < end; i = buf.indexOf(pat, i + 1)) hits.add(buf.lastIndexOf(10, i) + 1);
    }
    for (const s of [...hits].sort((a, b) => a - b)) {
      let o;
      try { o = JSON.parse(buf.toString('utf8', s, buf.indexOf(10, s))); } catch { continue; }
      const at = Date.parse(o.timestamp) || now;
      let active = null, cond = null, created = 0;
      if (o.type === 'attachment' && o.attachment?.type === 'goal_status') {
        active = !o.attachment.met && !o.attachment.failed;
        cond = o.attachment.condition == null ? null : String(o.attachment.condition);
      } else if (o.type === 'system' && /^\s*(<local-command-stdout>)?\s*Goal cleared/.test(String(o.content))) {
        active = false;
      } else if (o.type === 'event_msg' && o.payload?.type === 'thread_goal_updated') {
        const g = o.payload.goal || {};
        active = g.status === 'active';
        cond = g.objective == null ? null : String(g.objective);
        created = g.createdAt ? g.createdAt * 1000 : 0;
      }
      if (active !== null) apply(st, at, active, cond, created);
    }
    st.off += end;
    if (st.codex) {
      const row = codexGoal(input.session_id);
      if (row !== undefined) apply(st, now, row?.status === 'active', row ? String(row.objective) : null, row ? Math.floor(Number(row.created_at_ms) / 1000) * 1000 : 0);
    }
    fs.writeFileSync(cacheFile, JSON.stringify(st));
  } catch {}
  return st;
}
