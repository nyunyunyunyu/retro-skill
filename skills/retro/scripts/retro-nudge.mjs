#!/usr/bin/env node
// Hook for Claude Code and Codex (tool start/end, Stop, SubagentStop, SessionStart) that enhances /goal. It only acts
// while the session has an active /goal, read from the session transcript (Claude Code: goal_status attachments and
// "Goal cleared" records; Codex: thread_goal_updated events, overruled by its goal database). These are internal
// formats; if they change, it goes quiet.
//
// It speaks to the main agent at tool events; native /goal owns continuation. At tool
// calls each kind of message is said at most once per 10 minutes, or once, recorded in <tmp>/claude-retro-<session>.said:
// - Checkpoint: due 60 min after max(goal start, last `retro.mjs done`) once something came back since (a task report,
//   a ledger row, a commit, a subagent stop), repeated until marked done. Calls and result counts never trigger it;
//   with nothing new, the stall and idle-slot notes speak instead.
// - Subagent tracker: each subagent tool call touches <tmp>/claude-retro-<session>.agents/<agent>.json and SubagentStop
//   marks it stopped; workers another harness runs (.retro/workers/, Codex threads for a Claude main agent) count too.
//   From that: slots left idle (against the count set with `retro.mjs slots`), and lib executorNotes: a segment past
//   an hour, a silent or stuck executor. Claude Code's main agent sleeps between turns, so `retro.mjs watch` wakes it
//   from the background when one is due, and this hook says it at the next tool event. A subagent whose tool
//   call ran SILENT or longer is asked, right then, what took so long.
// - Background slot: one route review or idea scout at a time per project, state in .retro/slot. Only this hook
//   reserves it (under an exclusive lock): at goal start (a scout), then hourly; a scout when none ran for 4 h or the
//   idea pool runs low, otherwise a review; or right away after `retro.mjs request`. If nothing new came back in the
//   past hour it reserves nothing and reports a stall. A reservation must be launched within 20 min; the review/scout
//   then has 20/40 min. Any session voids overdue ones.
// After a compaction (SessionStart "compact") it tells the main agent to re-read the main loop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  C, SLOT_AGENTS, agentName, agentsDir, claimSaid, codexGoal, ensureDir, executorNotes, goalAgents, handbacks, harnessLimit, iso, lastRetro,
  locked, log, mainCheckout, newestResult, openIdeas, progressGoal, read, readSlot, readSlots, safe, said, sessions,
  slotExpired, trackTool, watching, writeSlot,
} from './lib.mjs';

const now = Date.now();
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch {}
const event = input.hook_event_name || 'PostToolUse';
// Diagnostics: while <tmp>/claude-retro-debug exists, log each event's metadata to claude-retro-debug.log.
const debug = path.join(os.tmpdir(), 'claude-retro-debug');
if (fs.existsSync(debug)) {
  try {
    const { session_id, agent_id, agent_type, stop_hook_active, tool_name, source, cwd, transcript_path } = input;
    const toolKeys = input.tool_input && typeof input.tool_input === 'object' ? Object.keys(input.tool_input) : typeof input.tool_input;
    fs.appendFileSync(debug + '.log', JSON.stringify({ t: iso(now), event, session_id, agent_id, agent_type, stop_hook_active, tool_name, source, cwd, transcript_path, keys: Object.keys(input), toolKeys }) + '\n');
  } catch {}
}
if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionStart'].includes(event) || typeof input.transcript_path !== 'string') process.exit(0);

const sid = safe(input.session_id);
const base = path.join(os.tmpdir(), `claude-retro-${sid}`);
const RESUME = /^\s*\/?(resume|continue|restart|unpause|go on|恢复|继续)\s*[.!。！]?\s*$/i;

// A subagent's tool call or stop (they share the session id; a message here would reach the subagent, not the main
// agent): only recorded for the tracker.
if (event === 'SubagentStop' || input.agent_id) {
  try { trackTool(input, JSON.parse(read(base + '.goal')), now); } catch {}
  try { track(); } catch {}
  try { slowTool(); } catch {}
  process.exit(0);
}

const goal = goalState(input.transcript_path, base + '.goal');
if (!goal.active || goal.child) process.exit(0);
// Do not create another continuation loop or consume reminders that the main agent has not seen.
if (event === 'Stop') process.exit(0);
try { trackTool(input, goal, now); } catch {}
if (event === 'PreToolUse') process.exit(0);

const root = mainCheckout(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
if (read(base + '.root') !== root) try { fs.writeFileSync(base + '.root', root); } catch {}
const CLI = fileURLToPath(new URL('./retro.mjs', import.meta.url)).replace(/\\/g, '/');
const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url)).replace(/\\/g, '/');
const WORKER = fileURLToPath(new URL('./codex-worker.mjs', import.meta.url)).replace(/\\/g, '/');
const cmd = sub => `\`node "${CLI}" ${sub} --root "${root.replace(/\\/g, '/')}"\``;
const wcmd = sub => `\`node "${WORKER}" ${sub} --root "${root.replace(/\\/g, '/')}"\``;
const tool = goal.codex ? 'Codex' : 'Claude Code';

if (event === 'SessionStart') {
  if (input.source === 'compact') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `上下文刚被压缩。你在用 retro 推进 /goal「${goal.cond}」。先重读精简入口 ${SKILL} 的职责边界和主循环，再读 PROGRESS.md，运行 ${cmd('status')} 核对任务。主 agent 保持响应，具体执行和深入复盘交给子代理；参考文件只按当前需要读取。` } }));
  }
  process.exit(0);
}

const notes = [];

try { if (event === 'PostToolUse') launched(); } catch {}
try { userInbox(); } catch {}
try { goalNote(); } catch {}
try { sessionFile(); } catch {}
try { checkpoint(); } catch {}
try { slot(); } catch {}
try { executors(); } catch {}

if (notes.length) {
  const text = notes.join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

// What was said when (lib claimSaid): claim(key, ok) says yes, and records it, only if ok(last time said).
function saidMap() { return said(input.session_id); }
function claim(key, ok) { return claimSaid(input.session_id, key, ok, now); }
// Due since `due`: say it, then again once 10 minutes have passed since it was last said.
function timely(key, due) {
  return now >= due && claim(key, last => !(last >= due && now - last < C.REPEAT));
}

// The subagent behind this event if it is an executor, while the main agent's goal was last seen active: not the
// review/scout (the slot times those), not Codex's approval reviewers, and not Claude Code's internal agents (/btw,
// prompt suggestions), which have no agent_type.
function executorType() {
  const type = String(input.agent_type || '');
  if (!type || SLOT_AGENTS.has(type) || /guardian/i.test(type)) return '';
  let cache = null;
  try { cache = JSON.parse(read(base + '.goal')); } catch {}
  return cache?.active ? type : '';
}

// An executor's tool call, or its stop.
function track() {
  if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop'].includes(event)) return;
  const type = executorType();
  if (!type) return;
  const d = agentsDir(input.session_id), id = safe(input.agent_id || 'unknown');
  const f = path.join(d, `${id}.json`), stop = path.join(d, `${id}.stop`);
  const header = () => JSON.stringify({ type, seg: now, tp: input.agent_transcript_path || input.transcript_path });
  fs.mkdirSync(d, { recursive: true });
  // The main session's project: a subagent's cwd may be a worktree, a subfolder or a fresh clone.
  const where = () => read(base + '.root') || mainCheckout(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  if (event === 'SubagentStop') {
    if (!fs.existsSync(f)) fs.writeFileSync(f, header());
    if (!fs.existsSync(stop)) log(where(), sid, 'agent-stop', id);
    fs.writeFileSync(stop, '');
  } else if (fs.existsSync(stop) || !fs.existsSync(f)) {
    // Its first tool call, or the first since it stopped (a follow-up): a new segment starts. Parallel calls race here;
    // only the one that creates the file or removes the stop marker logs the start.
    let mine = false;
    if (fs.existsSync(stop)) {
      fs.writeFileSync(f, header());
      try { fs.unlinkSync(stop); mine = true; } catch {}
    } else {
      try { fs.writeFileSync(f, header(), { flag: 'wx' }); mine = true; } catch {}
    }
    if (mine) log(where(), sid, 'agent-start', `${id} ${type}`);
  } else {
    fs.utimesSync(f, new Date(now), new Date(now));
  }
}

// An executor's tool call that ran SILENT or longer kept it silent all along: ask it now, while it can still say why.
// Claude Code reports how long the call took; Codex polls a long command instead of waiting on it.
function slowTool() {
  const ms = Number(input.duration_ms);
  if (!['PostToolUse', 'PostToolUseFailure'].includes(event) || !(ms >= C.SILENT) || !executorType()) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `这个工具调用（${input.tool_name}）跑了 ${Math.round(ms / 60e3)} 分钟，这段时间外面看不到你的任何动静。在你的 notes.md 里记一笔：它在做什么、为什么要这么久、能不能更快。超过约 1 分钟的评测或构建，按 executor.md 放到后台跑，等的时候做别的。` } }));
}

// The main agent just launched a subagent. An executor in the background: remember when, since it is tracked only from
// its first tool call and its slot shouldn't look idle meanwhile. Mark the reserved review/scout started.
// Only an exact agent name counts: Claude Code's Agent (formerly Task) tool names it in
// subagent_type; another spawn tool (Codex) in some field. Todo tools (TaskCreate…) and prompts that merely mention
// the name don't. Only the watch writes its liveness file: it may have exited before this hook runs.
function launched() {
  const ti = input.tool_input || {};
  const name = String(input.tool_name);
  const named = /^(Agent|Task)$/.test(name) ? [ti.subagent_type] : /spawn/i.test(name) ? Object.values(ti) : [];
  if (!named.length) return;
  if (!named.some(v => SLOT_AGENTS.has(v))) {
    // A foreground subagent has already finished by now.
    if (!/^(Agent|Task)$/.test(name) || ti.run_in_background) fs.writeFileSync(base + '.launch', String(now));
    return;
  }
  const s = readSlot(root);
  if (s.state !== 'running' || s.spawned || s.by !== sid) return;
  if (!named.includes(s.type === 'scout' ? 'idea-scout' : 'route-reviewer')) return;
  if (locked(root, t => {
    if (t.state !== 'running' || t.spawned || t.kv.start !== s.kv.start || slotExpired(t, now)) return false;
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
    let rejected = 0;
    for (const l of read(inbox).split('\n').filter(Boolean)) {
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      if (m.to === input.session_id) {
        if (m.goal_start === iso(goal.start)) { got.push(m.text); said.push(`- ${m.at} ${m.text}`); }
        else {
          rejected++;
          said.push(`- ${m.at} （没有送达：${m.goal_start ? `目标已变更，原目标「${m.goal || '未知'}」 ${m.goal_start}` : '缺少目标身份'}）${m.text}`);
        }
      }
      else if (now - Date.parse(m.at) > 6 * 3600e3) said.push(`- ${m.at} （没有送达）${m.text}`);
      else keep.push(l + '\n');
    }
    if (said.length) fs.appendFileSync(path.join(root, '.retro', 'user-said.md'), said.join('\n') + '\n');
    fs.writeFileSync(inbox, keep.join(''));
    return { got, rejected };
  });
  if (mine?.rejected) {
    log(root, sid, 'tell-undelivered', `${mine.rejected} 条消息的目标不匹配或身份缺失`);
    notes.push(`${mine.rejected} 条进度台消息因目标变更或缺少目标身份没有送达，已保留在 .retro/user-said.md；需要用户确认后才能用于当前目标。`);
  }
  if (!mine?.got.length) return;
  const text = mine.got.join('\n');
  log(root, sid, 'told', text);
  notes.push(`用户在进度台说了下面的话，转给你：优先分清并处理指令、想法或问题，保留原意；有效的长期约束记进 PROGRESS.md，需要回答的及时回答。转达不扩大授权。\n${text}`);
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

function checkpoint() {
  const R = Math.max(goal.start, lastRetro(root, input.session_id, goal.start));
  const due = R + C.CHECKPOINT_EVERY;
  // Only once something came back since the last one: with nothing to sort, the stall and idle-slot notes speak instead.
  if (now < due || newestResult(root, handbacks(input.session_id, root)) <= R) return;
  const first = !(saidMap().checkpoint >= due);
  if (!timely('checkpoint', due)) return;
  const mins = Math.round((now - R) / 60e3);
  if (first) log(root, sid, 'checkpoint-due', `${mins}min`);
  let text = `检查点到期（距上次检查点或目标开始 ${mins} 分钟）。在可响应的断点运行 ${cmd(`inbox --session ${input.session_id}`)} 汇集尚未处理的结果，更新关键决定和 PROGRESS.md，再运行 ${cmd(`done "<决定或核对结果>" --session ${input.session_id}`)}。深入复盘或核实交给子代理；主 agent 继续处理用户和回报。`;
  const size = fs.existsSync(path.join(root, 'PROGRESS.md')) ? fs.statSync(path.join(root, 'PROGRESS.md')).size : 0;
  if (size > C.PROGRESS_MAX) text += ` PROGRESS.md 现在 ${(size / 1024).toFixed(1)} KB，超过 4 KB：这次先压缩它（命令和环境移到手册，过程细节移到任务笔记）。`;
  notes.push(text);
}

// The subagent tracker, read for the main agent: executors past their hour, silent or stuck (lib executorNotes); in
// Claude Code, executors running with no watch to wake the main agent; slots left idle.
function executors() {
  const { agents, running } = goalAgents(input.session_id, goal.start, now, root);
  const said = executorNotes(running, { now, sessionId: input.session_id, root, codex: goal.codex, wcmd }).map(n => n.text);
  notes.push(...said);
  // A new executor shows up only at its first tool call.
  const launch = Number(read(base + '.launch')) || 0;
  const watch = `\`node "${CLI}" watch --session ${input.session_id} --root "${root.replace(/\\/g, '/')}"\``;
  if (!goal.codex && (running.length || now - launch < C.IDLE_GRACE) && !watching(input.session_id)) {
    if (timely('watch', goal.start)) notes.push(`有执行者在跑，后台却没有 retro 的 watch：需要后台监控时，用 Bash 在后台（run_in_background）运行 ${watch}。它发现慢调用或活动异常会结束；收到结束通知后查看 ${cmd('status')}，hook 会在工具事件给出待判断的事项。`);
  }
  const set = readSlots(root);
  if (!set || set.at < goal.start) {
    if (timely('slots', goal.start + C.SLOTS_BY)) notes.push(`还没有记下这个目标的名额。按资源、用户约束和 ${tool} 的子代理上限 ${harnessLimit(goal.codex, root)} 决定并发计划，用 ${cmd('slots <N> <理由>')} 记录；后台评审也计入平台容量。一个执行名额也可以推进，不要求填满。`);
    return;
  }
  if (running.length >= set.n) return;
  // Idle since the last time a slot freed up (approximately, when several are idle), or since the last launch.
  const freed = Math.max(set.at, goal.start, launch, ...agents.map(a => a.stopAt || (a.active && !a.worker && now - a.last >= C.GONE ? a.last + C.GONE : 0)));
  if (timely('idle', freed + C.IDLE_GRACE)) {
    notes.push(`名额空着：这个目标的名额是 ${set.n} 个，现在在跑的执行子代理只有 ${running.length} 个${running.length ? `（${running.map(agentName).join('、')}）` : ''}。核对是否在有意等待、受资源限制，或有值得派出的工作；不要求补满，也不要求固定探索比例。计划变化时用 ${cmd('slots <N> <理由>')} 更新。`);
  }
}

function slot() {
  let s = readSlot(root);
  const mine = () => s.by === sid;
  const spawnText = (type, start) => {
    const name = type === 'scout' ? 'idea-scout' : 'route-reviewer';
    const how = goal.codex
      ? `用 spawn_agent 启动 ${name} 子代理（agent_type 设为 "${name}"，fork_turns 设为 "none"），message 写`
      : `在后台启动 ${name} 子代理（Agent 工具，subagent_type 设为 ${name}，run_in_background 设为 true），提示写`;
    return `${how}：“${type === 'scout' ? '侦察本项目' : '评审本项目的路线'}。开始时间 ${start}；脚本 ${CLI}；项目 ${root.replace(/\\/g, '/')}”。`;
  };
  const stopNote = `你启动的后台评审/侦察超过时间上限，已自动作废。能停就停掉它（${goal.codex ? 'interrupt_agent' : 'TaskStop'}）；停不掉也没关系，它交结论时会发现已作废，不会写入。`;
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
    const late = slotExpired(s, now);
    if (stale || late) {
      // Any session may void it (keeping `spawned`, so the owner still learns to stop it).
      const voided = locked(root, t => {
        if (t.state !== 'running' || t.kv.start !== s.kv.start || !(slotExpired(t, now) || (t.start < goal.start && !t.spawned && t.by === sid))) return false;
        writeSlot(root, { ...t.kv, state: 'aborted', end: iso(now) });
        return true;
      });
      if (voided) log(root, sid, stale ? 'slot-stale' : s.spawned ? 'slot-timeout' : 'slot-unlaunched', `${s.type} ${s.kv.start}`);
      if (voided && mine() && s.spawned && tellOwner(s.kv.start)) notes.push(stopNote);
      if (!stale) return;
      s = readSlot(root);
    } else {
      if (!s.spawned && mine() && timely(`launch ${s.kv.start}`, s.start)) notes.push(`你登记的后台${s.type === 'scout' ? '侦察' : '评审'}还没有启动。值得做且有容量时，${spawnText(s.type, s.kv.start)}不需要或资源不足时运行 ${cmd(`abort ${s.kv.start}`)} 释放；已经启动过就不用管。`);
      return;
    }
  }
  if (s.state === 'aborted' && s.spawned && mine()) {
    if (tellOwner(s.kv.start)) notes.push(stopNote);
    return;
  }
  const finished = handbacks(input.session_id, root);
  const plan = t => {
    if (t.state === 'running') return null;
    // `retro.mjs request`, made during this goal
    if ((t.kv.want === 'scout' || t.kv.want === 'review') && Date.parse(t.kv.wantAt) >= goal.start) return { type: t.kv.want, asked: true };
    const first = t.start < goal.start; // nothing reserved yet for this goal
    if (!first && now - t.start < C.SLOT_EVERY) return null;
    if (!first && newestResult(root, finished) < t.start) return { stall: true };
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
    else writeSlot(root, { state: 'running', type: p.type, start, by: sid, goalStart: goal.start, lastScout: p.type === 'scout' ? start : t.kv.lastScout });
    return { ...p, start };
  });
  if (!got) return;
  if (got.stall) {
    log(root, sid, 'stall', '');
    notes.push('过去 1 小时没有可见的新结果（子代理交回、任务回报、总表、提交），这一轮不登记路线评审。这不等于没有进展：核对当前进度、资源等待和回报约定，再决定继续、补证据或调整任务；深入调查交给执行者。');
  } else {
    log(root, sid, 'slot-reserved', `${got.type} ${got.start}${got.asked ? ' requested' : ''}`);
    claim(`launch ${got.start}`, () => true);
    notes.push(`已为你登记一次后台${got.type === 'scout' ? '侦察' : '评审'}${got.asked ? '（按你的请求）' : ''}（同一项目同一时间只有一个）。值得做且有容量时，${spawnText(got.type, got.start)}不需要或资源不足时运行 ${cmd(`abort ${got.start}`)} 释放。登记 20 分钟后过期；启动后主 agent 继续响应，不等待复盘完成。`);
  }
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
