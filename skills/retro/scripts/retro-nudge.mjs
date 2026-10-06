#!/usr/bin/env node
// PostToolUse hook for Claude Code and Codex that enhances /goal: it only acts while the session has an active
// /goal, read from the session transcript (Claude Code: goal_status attachments and "Goal cleared" records; Codex:
// thread_goal_updated events). These are internal formats; if they change, the hook just goes quiet.
// While a goal is active, a retro rewrites PROGRESS.md, so its mtime marks the last retro. Once DUE tool calls pass
// since max(goal start, last retro), nudge every REPEAT calls until PROGRESS.md is updated.
// Route reviews run in a background subagent, at most one per project. The first line of .retro/route-review.md
// ("<!-- route-review: running|done|aborted start=<ISO> by=<session> [spawned=<ISO>] -->") is the state. Only this
// hook reserves a review: once ROUTE_EVERY has passed since the last start (or the goal start) it writes `running`
// for this session under an exclusive lock file, so two sessions or parallel calls can't both reserve one. Every
// REPEAT calls it nudges only the reserving session until it marks `spawned`; past ROUTE_MAX any session voids it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DUE = 40, REPEAT = 10, ROUTE_EVERY = 60 * 60e3, ROUTE_MAX = 20 * 60e3;

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch {}
// Subagents share the session id; a nudge there would land in the subagent's context, not the main agent's.
// Other events (e.g. Stop/SessionStart left over from older configs) must not count as tool calls.
if (input.agent_id || typeof input.transcript_path !== 'string' || (input.hook_event_name || 'PostToolUse') !== 'PostToolUse') process.exit(0);

const base = path.join(os.tmpdir(), `claude-retro-${String(input.session_id).replace(/[^\w-]/g, '_')}`);
const goal = goalState(input.transcript_path, base + '.goal');
if (!goal.active) process.exit(0);

// One line per tool call, "<ms timestamp> <pid>", appended so parallel tool calls don't lose counts.
// Each run counts only up to its own line, so parallel calls neither skip nor duplicate a nudge.
const me = `${Date.now()} ${process.pid}`;
let lines = [];
try {
  fs.appendFileSync(base + '.log', me + '\n');
  lines = fs.readFileSync(base + '.log', 'utf8').split('\n').filter(Boolean);
} catch {}
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
let retroAt = goal.start;
try { retroAt = Math.max(retroAt, fs.statSync(path.join(root, 'PROGRESS.md')).mtimeMs); } catch {}
const upTo = lines.slice(0, lines.lastIndexOf(me) + 1);
const since = upTo.filter(l => parseInt(l, 10) > retroAt).length;
const notes = [];
if (since >= DUE && (since - DUE) % REPEAT === 0) {
  notes.push(`这个目标下已有 ${since} 次工具调用没复盘（PROGRESS.md 没更新）。先做完手头这一步，不要中途打断正在进行的修改；到下一个自然断点时用 retro skill 复盘一次。复盘会改写 PROGRESS.md，这个提醒随之停止。`);
}
if (upTo.length > 0 && upTo.length % REPEAT === 0) {
  const file = path.join(root, '.retro', 'route-review.md'), lock = file + '.lock', now = Date.now();
  const sid = String(input.session_id).replace(/[^\w-]/g, '_');
  const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const parse = t => {
    const m = t.slice(0, 400).match(/route-review:\s*(running|done|aborted)\s+start=(\S+)([^\n]*?)-->/);
    if (!m) return { state: 'none', start: 0 };
    const kv = Object.fromEntries([...m[3].matchAll(/(\w+)=(\S+)/g)].map(x => [x[1], x[2]]));
    return { state: m[1], start: Date.parse(m[2]) || 0, iso: m[2], by: kv.by, spawned: !!kv.spawned };
  };
  const setLine = (text, line) => fs.writeFileSync(file, line + '\n' + text.replace(/^<!--.*-->\r?\n?/, ''));
  // Run fn under an exclusive lock file, so concurrent runs (other sessions, parallel calls) can't interleave.
  const locked = fn => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.closeSync(fs.openSync(lock, 'wx'));
      try { return fn(read()); } finally { fs.unlinkSync(lock); }
    } catch (e) {
      try { if (e.code === 'EEXIST' && now - fs.statSync(lock).mtimeMs > 60e3) fs.unlinkSync(lock); } catch {} // stale lock
    }
  };
  const due = r => r.state !== 'running' && now - Math.max(r.start, goal.start) >= ROUTE_EVERY;
  const route = parse(read()), mine = route.by === sid;
  const how = '在后台启动 route-reviewer（做法见 retro skill「路线评审」），提示写“评审本项目的路线，开始时间';
  const stopNote = '你启动的后台路线评审超过 20 分钟上限，已自动作废。能停就停掉它（Claude Code 用 TaskStop，Codex 用 close_agent）；停不掉也没关系，它交结论前会发现已作废，不会写入。';
  // Tell the owner once to stop a voided review it spawned, then drop `spawned` so it isn't told again.
  const tellOwner = () => locked(text => {
    const r = parse(text);
    if (r.state !== 'aborted' || r.iso !== route.iso || !r.spawned || r.by !== sid) return false;
    setLine(text, `<!-- route-review: aborted start=${r.iso} by=${r.by} -->`);
    return true;
  });
  if (route.state === 'running' && now - route.start >= ROUTE_MAX) {
    // Any session may void an overdue review (keeping `spawned`, so the owner still learns to stop it).
    const voided = locked(text => {
      const r = parse(text);
      if (r.state !== 'running' || r.iso !== route.iso) return false;
      setLine(text, `<!-- route-review: aborted start=${r.iso} by=${r.by || ''}${r.spawned ? ' spawned=1' : ''} -->`);
      return true;
    });
    if (voided && mine && route.spawned && tellOwner()) notes.push(stopNote);
  } else if (route.state === 'aborted' && route.spawned && mine) {
    if (tellOwner()) notes.push(stopNote);
  } else if (route.state === 'running' && !route.spawned && mine) {
    notes.push(`你登记的路线评审还没启动：到下一个自然断点时${how} ${route.iso}”，启动后按 skill 标记 spawned。已经启动过就只补上标记。`);
  } else if (due(route)) {
    const start = locked(text => {
      if (!due(parse(text))) return null;
      const iso = new Date(now).toISOString();
      setLine(text, `<!-- route-review: running start=${iso} by=${sid} -->`);
      return iso;
    });
    if (start) notes.push(`已为你登记一次路线评审（距上次评审或目标开始已满 1 小时）：到下一个自然断点时${how} ${start}”。不要等它，接着干活。`);
  }
}
if (notes.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join(' ') } }));

// Latest goal state of the transcript. The cache keeps the byte offset already scanned, so each run reads only
// what was appended since; a corrupt or missing cache just means one full scan.
function goalState(transcript, cacheFile) {
  const fresh = { path: transcript, off: 0, active: false, start: 0 };
  let st = fresh;
  try { st = { ...fresh, ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) }; } catch {}
  try {
    const fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    if (st.path !== transcript || size < st.off) st = { ...fresh };
    const buf = Buffer.alloc(size - st.off);
    fs.readSync(fd, buf, 0, buf.length, st.off);
    fs.closeSync(fd);
    const end = buf.lastIndexOf(10) + 1; // complete lines only
    const hits = new Set();
    for (const pat of ['"type":"goal_status"', 'Goal cleared', '"type":"thread_goal_updated"']) {
      for (let i = buf.indexOf(pat); i >= 0 && i < end; i = buf.indexOf(pat, i + 1)) hits.add(buf.lastIndexOf(10, i) + 1);
    }
    for (const s of [...hits].sort((a, b) => a - b)) {
      let o;
      try { o = JSON.parse(buf.toString('utf8', s, buf.indexOf(10, s))); } catch { continue; }
      const at = Date.parse(o.timestamp) || Date.now();
      let active = null;
      if (o.type === 'attachment' && o.attachment?.type === 'goal_status') {
        active = !o.attachment.met && !o.attachment.failed;
        if (o.attachment.sentinel) st.start = at;                               // a new goal was set
      } else if (o.type === 'system' && /^\s*(<local-command-stdout>)?\s*Goal cleared/.test(String(o.content))) {
        active = false;
      } else if (o.type === 'event_msg' && o.payload?.type === 'thread_goal_updated') {
        active = o.payload.goal?.status === 'active';
      }
      if (active === null) continue;
      if (active && !st.active && (o.type === 'event_msg' || !st.start)) st.start = at; // Codex goal (re)activated
      st.active = active;
    }
    st.off += end;
    fs.writeFileSync(cacheFile, JSON.stringify(st));
  } catch {}
  return st;
}
