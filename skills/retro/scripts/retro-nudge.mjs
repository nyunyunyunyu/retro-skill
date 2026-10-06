#!/usr/bin/env node
// Hook for PostToolUse and Stop, for Claude Code and Codex. Only active in projects with a PROGRESS.md at the root.
// A retro always rewrites PROGRESS.md, so its mtime marks the last retro: once DUE tool calls pass without an
// update, nudge every REPEAT calls until it is updated, and block the end of a turn once, so an agent busy with
// something important can defer the retro to a natural breakpoint but not skip it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DUE = 40, REPEAT = 10;

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch {}
let retroAt;
try { retroAt = fs.statSync(path.join(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), 'PROGRESS.md')).mtimeMs; } catch { process.exit(0); }
// Subagents share the session id; a nudge there would land in the subagent's context, not the main agent's.
if (input.agent_id) process.exit(0);

const event = input.hook_event_name || 'PostToolUse';
// One line per tool call, "<ms timestamp> <pid>", appended so concurrent runs (parallel tool calls) don't lose counts.
// Each run counts only up to its own line, so parallel calls neither skip nor duplicate a nudge.
const file = path.join(os.tmpdir(), `claude-retro-${String(input.session_id).replace(/[^\w-]/g, '_')}.log`);
const me = `${Date.now()} ${process.pid}`;
let lines = [];
try {
  if (event !== 'Stop') fs.appendFileSync(file, me + '\n');
  lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
} catch {}
const upTo = event === 'Stop' ? lines.length : lines.lastIndexOf(me) + 1;
const since = lines.slice(0, upTo).filter(l => parseInt(l, 10) > retroAt).length;
const overdue = `已有 ${since} 次工具调用没更新 PROGRESS.md`;

if (event === 'Stop') {
  if (since >= DUE && !input.stop_hook_active) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `结束这一轮之前，先用 retro skill 快速复盘一次（${overdue}）。如果用户让这个会话暂停或停下、还没说继续，就不用复盘，直接结束。` }));
  }
} else if (since >= DUE && (since - DUE) % REPEAT === 0) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `${overdue}。先做完手头这一步，不要中途打断正在进行的修改；到下一个自然断点时用 retro skill 复盘一次。复盘会更新 PROGRESS.md，这个提醒随之停止。如果用户让这个会话暂停了、还没说继续，就忽略这条。` } }));
}
