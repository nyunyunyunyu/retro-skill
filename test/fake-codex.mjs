// Stands in for `codex exec --json` in test/run.mjs. Logs each call to FAKE_CODEX_LOG, then acts on the prompt:
//   SLEEP          runs two commands at once; one finishes, the other (a child process, its pid in FAKE_CODEX_LOG.pid)
//                  waits until killed
//   LINGER         leaves a background process holding its output, then finishes
//   FAIL           the turn fails
//   NOTHREAD       exits before a thread starts
//   REPORT:<path>  writes a report there
//   QUIET          says nothing more after the thread starts, until killed
//   POLL           a tool call stays out for FAKE_POLL_MS (default 5 s), shown only in the rollout, then it answers
//   BEAT           writes a step to the rollout every second for 5 s, nothing to stdout, then answers
// FAKE_CODEX_MODE adds these to every call's prompt. Otherwise it answers with the start of the prompt. With
// CODEX_HOME set it keeps a rollout as Codex does (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const mode = `${prompt} ${process.env.FAKE_CODEX_MODE || ''}`;
const out = argv[argv.indexOf('-o') + 1];
const thread = argv.includes('resume') ? argv.at(-2) : `thread-${process.pid}`;
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, cwd: process.cwd(), prompt }) + '\n');
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
if (mode.includes('NOTHREAD')) process.exit(1);
emit({ type: 'thread.started', thread_id: thread });
// Real Codex warns this way at startup, e.g. about a config setting it doesn't know.
emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } });
emit({ type: 'turn.started' });
const rollout = rolloutFile();
const step = (type, payload) => rollout && fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
if (!argv.includes('resume')) step('session_meta', { id: thread });
step('event_msg', { type: 'task_started' });
step('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] });
const report = prompt.match(/REPORT:(\S+)/);
if (report) fs.writeFileSync(report[1], '结果：完成\n');
const command = (id, cmd, done) => emit({ type: done ? 'item.completed' : 'item.started', item: { id, type: 'command_execution', command: cmd, status: done ? 'completed' : 'in_progress' } });
if (mode.includes('QUIET')) {
  setInterval(() => {}, 1000);
} else if (mode.includes('POLL')) {
  step('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'write_stdin' });
  setTimeout(() => { step('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }); answer(); }, Number(process.env.FAKE_POLL_MS) || 5000);
} else if (mode.includes('BEAT')) {
  let n = 0;
  const t = setInterval(() => { step('response_item', { type: 'reasoning' }); if (++n === 5) { clearInterval(t); answer(); } }, 1000);
} else if (mode.includes('FAIL')) {
  emit({ type: 'turn.failed', error: { message: 'boom' } });
  process.exit(1);
} else if (mode.includes('SLEEP')) {
  command('item_1', 'python eval.py'); command('item_2', 'git status'); command('item_2', 'git status', true);
  const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_CODEX_LOG + '.pid', String(g.pid));
  g.on('exit', () => process.exit(0));
} else if (mode.includes('LINGER')) {
  // Through a shell, as a command codex runs would: the background process inherits the output pipe and exits by
  // itself after 20 s. The shell must get to start it before this process exits (its children die with it). It runs
  // from the drive root, so it doesn't keep the test's directories busy.
  const root = path.parse(process.cwd()).root;
  const sh = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start /b ping -n 20 127.0.0.1 & echo started'], { stdio: ['ignore', 'inherit', 'inherit'], cwd: root })
    : spawn('sh', ['-c', 'sleep 20 & echo started'], { stdio: ['ignore', 'inherit', 'inherit'], cwd: root });
  sh.on('exit', answer);
} else {
  answer();
}
function answer() {
  const text = `答复：${prompt.trim().slice(0, 40)}`;
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
  step('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  step('event_msg', { type: 'task_complete' });
  fs.writeFileSync(out, text);
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
}
// The thread's rollout: its own if it has one (a resume), else a new one under today's date.
function rolloutFile() {
  if (!process.env.CODEX_HOME) return '';
  const day = d => path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  for (const d of [new Date(), new Date(Date.now() - 864e5)]) {
    try { const n = fs.readdirSync(day(d)).find(x => x.endsWith(`-${thread}.jsonl`)); if (n) return path.join(day(d), n); } catch {}
  }
  fs.mkdirSync(day(new Date()), { recursive: true });
  return path.join(day(new Date()), `rollout-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${thread}.jsonl`);
}
