#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook. Only active in projects with a PROGRESS.md at the root.
// Nudges the agent to run the retro skill every EVERY tool calls, and when FAILS of the last WINDOW calls failed.
// Works for Claude Code and Codex. Codex has no failure event and no exit code in tool_response,
// so there only the periodic nudge applies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EVERY = 40, WINDOW = 10, FAILS = 3;

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch {}
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
// Subagents share the session id; a nudge there would land in the subagent's context, not the main agent's.
if (input.agent_id || !fs.existsSync(path.join(root, 'PROGRESS.md'))) process.exit(0);

const event = input.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse';
// One char per call, appended: stays correct when parallel tool calls run this hook concurrently.
const file = path.join(os.tmpdir(), `claude-retro-${String(input.session_id).replace(/[^\w-]/g, '_')}.log`);
let log = '';
try { fs.appendFileSync(file, event === 'PostToolUseFailure' ? 'F' : '.'); log = fs.readFileSync(file, 'utf8'); } catch {}
// Count failures in a window, not a streak: a stuck edit → run → fail loop has successful edits in between.
const calls = log.length, fails = (log.slice(-WINDOW).match(/F/g) || []).length;

const notes = [];
if (event === 'PostToolUseFailure' && fails === FAILS) notes.push(`最近 ${WINDOW} 次工具调用里有 ${FAILS} 次失败：这在关键路径上吗？不在就记入“暂缓”回主线；在就换个角度，不要原样再试。`);
if (calls && calls % EVERY === 0) notes.push(`已过 ${calls} 次工具调用：如果最近没复盘，用 retro skill 快速复盘一次。`);
if (notes.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: notes.join(' ') } }));
