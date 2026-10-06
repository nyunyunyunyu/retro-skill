#!/usr/bin/env node
// PostToolUse hook for Claude Code and Codex that enhances /goal: it only acts while the session has an active
// /goal, read from the session transcript (Claude Code: goal_status attachments and "Goal cleared" records; Codex:
// thread_goal_updated events). These are internal formats; if they change, the hook just goes quiet.
// While a goal is active, a retro rewrites PROGRESS.md, so its mtime marks the last retro. Once DUE tool calls pass
// since max(goal start, last retro), nudge every REPEAT calls until PROGRESS.md is updated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DUE = 40, REPEAT = 10;

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
let retroAt = goal.start;
try { retroAt = Math.max(retroAt, fs.statSync(path.join(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), 'PROGRESS.md')).mtimeMs); } catch {}
const since = lines.slice(0, lines.lastIndexOf(me) + 1).filter(l => parseInt(l, 10) > retroAt).length;
if (since >= DUE && (since - DUE) % REPEAT === 0) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `这个目标下已有 ${since} 次工具调用没复盘（PROGRESS.md 没更新）。先做完手头这一步，不要中途打断正在进行的修改；到下一个自然断点时用 retro skill 复盘一次。复盘会改写 PROGRESS.md，这个提醒随之停止。` } }));
}

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
