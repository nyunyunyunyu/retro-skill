#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook. Only active in projects with a PROGRESS.md at the root.
// Nudges Claude to run the retro skill every EVERY tool calls and after FAIL_STREAK consecutive failures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EVERY = 40, FAIL_STREAK = 3;

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
const calls = log.length, fails = calls - log.replace(/F+$/, '').length;

const notes = [];
if (fails === FAIL_STREAK) notes.push(`连续 ${FAIL_STREAK} 次工具调用失败：这在关键路径上吗？不在就记入“暂缓”回主线；在就换个角度，不要原样再试。`);
if (calls && calls % EVERY === 0) notes.push(`已过 ${calls} 次工具调用：如果最近没复盘，用 retro skill 快速复盘一次。`);
if (notes.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: notes.join(' ') } }));
