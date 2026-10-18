// Stands in for `codex exec --json` in test/run.mjs. Logs each call to FAKE_CODEX_LOG, then acts on the prompt:
//   SLEEP          runs two commands at once; one finishes, the other (a child process, its pid in FAKE_CODEX_LOG.pid)
//                  waits until killed
//   LINGER         leaves a background process holding its output, then finishes
//   FAIL           the turn fails
//   NOTHREAD       exits before a thread starts
//   REPORT:<path>  writes a report there
// Otherwise it answers with the start of the prompt.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const out = argv[argv.indexOf('-o') + 1];
const thread = argv.includes('resume') ? argv.at(-2) : `thread-${process.pid}`;
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, cwd: process.cwd(), prompt }) + '\n');
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
if (prompt.includes('NOTHREAD')) process.exit(1);
emit({ type: 'thread.started', thread_id: thread });
emit({ type: 'turn.started' });
const report = prompt.match(/REPORT:(\S+)/);
if (report) fs.writeFileSync(report[1], '结果：完成\n');
const command = (id, cmd, done) => emit({ type: done ? 'item.completed' : 'item.started', item: { id, type: 'command_execution', command: cmd, status: done ? 'completed' : 'in_progress' } });
if (prompt.includes('FAIL')) {
  emit({ type: 'turn.failed', error: { message: 'boom' } });
  process.exit(1);
} else if (prompt.includes('SLEEP')) {
  command('item_1', 'python eval.py'); command('item_2', 'git status'); command('item_2', 'git status', true);
  const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_CODEX_LOG + '.pid', String(g.pid));
  g.on('exit', () => process.exit(0));
} else if (prompt.includes('LINGER')) {
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
  fs.writeFileSync(out, text);
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
}
