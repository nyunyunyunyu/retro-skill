// End-to-end check with a real Codex: a Claude Code main agent (synthetic hook input) dispatches executor tasks to Codex
// through codex-worker.mjs. Takes a few minutes and a little Codex usage, so it is not part of run.mjs.
// Run: node test/codex-live.mjs   (uses the codex the driver would pick; see README)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, '..', 'skills', 'retro', 'scripts');
const EXECUTOR = path.join(here, '..', 'skills', 'retro', 'templates', 'executor.md').replace(/\\/g, '/');
const MIN = 60e3;
// A short path: Windows git and Codex trip over long ones.
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-')), state = path.join(proj + '-tmp');
fs.mkdirSync(state);
const git = (...a) => spawnSync('git', a, { cwd: proj, encoding: 'utf8' });
git('init', '-q'); fs.writeFileSync(path.join(proj, 'README.md'), 'live test\n'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
// The setup commit is from before the goal, so it isn't something that came back.
const old = (Date.now() - 120 * 60e3) / 1000;
for (const f of fs.readdirSync(path.join(proj, '.git', 'logs'), { recursive: true })) fs.utimesSync(path.join(proj, '.git', 'logs', f), old, old);

// The codex the driver would pick, with low effort to keep it quick; everything else as configured.
const { codexCommand } = await import('../skills/retro/scripts/lib.mjs');
const codexCmd = [...codexCommand(), '-c', 'model_reasoning_effort="low"'];
console.log(`codex: ${codexCmd.join(' ')}`);
const env = { ...process.env, RETRO_CODEX: JSON.stringify(codexCmd) };
// Hook and CLI keep their per-session state in their own temp dir; Codex keeps the real one.
const hookEnv = { ...env, TEMP: state, TMP: state, TMPDIR: state, CLAUDE_PROJECT_DIR: proj };
const transcript = path.join(proj, '.transcript.jsonl');
fs.writeFileSync(transcript, JSON.stringify({ type: 'attachment', timestamp: new Date(Date.now() - 61 * MIN).toISOString(), attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'live test' } }) + '\n');
const hook = () => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'retro-nudge.mjs')], { input: JSON.stringify({ session_id: 'live', transcript_path: transcript, cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'Bash' }), env: hookEnv, encoding: 'utf8' });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
};
const cli = (...a) => spawnSync(process.execPath, [path.join(SCRIPTS, 'retro.mjs'), ...a, '--root', proj], { env: hookEnv, encoding: 'utf8' }).stdout;
const retro = p => path.join(proj, '.retro', p);
const worker = id => { try { return JSON.parse(fs.readFileSync(retro(`workers/${id}.json`), 'utf8')); } catch { return null; } };
const start = (...a) => {
  const p = spawn(process.execPath, [path.join(SCRIPTS, 'codex-worker.mjs'), ...a, '--root', proj], { env });
  let out = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  p.done = new Promise(res => p.on('close', code => res({ code, out })));
  return p;
};
const until = async (ok, ms, what) => {
  for (const t0 = Date.now(); !ok(); await new Promise(r => setTimeout(r, 500))) if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
};
const brief = (task, text) => { fs.mkdirSync(retro(`tasks/${task}`), { recursive: true }); fs.writeFileSync(retro(`tasks/${task}/brief.md`), text); };
const processesWith = marker => {
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `ps -eo pid,args | grep -F '${marker}' | grep -v grep | awk '{print $1}'`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number).filter(p => p !== process.pid);
};
const step = (name, t0 = Date.now()) => () => console.log(`ok   ${name}（${Math.round((Date.now() - t0) / 1000)} 秒）`);

try {
  assert.doesNotMatch(hook(), /检查点到期/);
  const slot = Object.fromEntries([...fs.readFileSync(retro('slot'), 'utf8').matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]]));
  cli('spawned', slot.start);
  cli('slots', '1', 'live');
  fs.writeFileSync(retro('slots'), JSON.stringify({ n: 1, at: new Date(Date.now() - 6 * MIN).toISOString(), why: 'live' }));

  let ok = step('a task brief runs as a Codex thread; the hook counts it while it runs; it follows executor.md, commits and reports');
  brief('t1', `# 写 hello.txt\n任务：在项目根目录 ${proj.replace(/\\/g, '/')} 用一条 shell 命令创建 hello.txt，内容只有一行 hi from codex，然后用 git 提交它（提交信息 add hello）。\n验收：文件存在，内容正确；提交不了就在回报里写原因，不要绕过。验证档位：探索，验证预算 2 分钟。时间上限 10 分钟。\n任务目录：${retro('tasks/t1').replace(/\\/g, '/')}\n开始前先读 ${EXECUTOR}，按其中的规则执行和回报。\n`);
  const p1 = start('run', 't1');
  await until(() => worker('t1')?.thread, 120e3, 'thread started');
  assert.doesNotMatch(hook(), /名额空着|检查点到期/);
  assert.match(cli('status'), /在跑 1 个）：写 hello\.txt［codex t1］/);
  const r1 = await p1.done;
  assert.equal(r1.code, 0, r1.out);
  assert.match(fs.readFileSync(path.join(proj, 'hello.txt'), 'utf8').replace(/^﻿/, '').replace(/\0/g, ''), /hi from codex/);
  assert.ok(fs.existsSync(retro('tasks/t1/report.md')), `no report.md; output:\n${r1.out}`);
  assert.match(r1.out, /回报：.*report\.md/);
  ok();
  console.log(`     回报第一行：${fs.readFileSync(retro('tasks/t1/report.md'), 'utf8').split('\n').find(l => l.trim())}`);
  // The sandbox keeps .git read-only; the driver makes the git directory writable.
  assert.match(git('log', '--oneline').stdout, /add hello/, 'it can commit');

  ok = step('the finished task makes the checkpoint due; the freed slot is reported');
  assert.match(hook(), /检查点到期/);
  const w = worker('t1');
  fs.writeFileSync(retro('workers/t1.json'), JSON.stringify({ ...w, stopAt: Date.now() - 6 * MIN }));
  const said = path.join(state, 'claude-retro-live.said');
  const m = JSON.parse(fs.readFileSync(said, 'utf8')); for (const k in m) m[k] -= 11 * MIN; fs.writeFileSync(said, JSON.stringify(m));
  assert.match(hook(), /名额是 1 个，现在在跑的执行子代理只有 0 个/);
  ok();

  ok = step('resume continues the same thread with its context');
  const r2 = await start('resume', 't1', '我刚才让你在 hello.txt 里写的是哪句话？不要运行任何命令，只回答那句话。').done;
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, new RegExp(`线程 ${w.thread}`));
  assert.match(r2.out.split('最后的话：')[1], /hi from codex/i);
  assert.equal(fs.readFileSync(retro('log.tsv'), 'utf8').match(/agent-start\tt1 codex/g).length, 2);
  ok();

  ok = step('it can reach the network (the sandbox blocks it unless the driver opens it)');
  const fetch = process.platform === 'win32' ? '(Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 https://example.com).StatusCode' : 'curl -s -o /dev/null -w "%{http_code}" https://example.com';
  brief('t3', `只运行这一条 shell 命令，然后只回答它输出的数字，失败就回答错误信息：${fetch}\n`);
  const r4 = await start('run', 't3').done;
  assert.equal(r4.code, 0, r4.out);
  assert.match(r4.out.split('最后的话：')[1], /\b200\b/);
  ok();

  ok = step('stop ends a thread inside a long command, with the command\'s processes');
  const marker = process.platform === 'win32' ? 'Start-Sleep -Seconds 287' : 'sleep 287';
  brief('t2', `运行这条 shell 命令，等它结束后回答 done：${marker}\n`);
  const p3 = start('run', 't2');
  await until(() => worker('t2')?.cmd?.includes('287'), 180e3, 'command started');
  await until(() => processesWith(marker).length, 30e3, 'sleep process visible');
  const before = processesWith(marker);
  assert.match(cli('status'), /正在跑命令「[^」]*287/);
  console.log(`     stop 前跑着这条命令的进程：${before.join(', ')}`);
  console.log('     ' + spawnSync(process.execPath, [path.join(SCRIPTS, 'codex-worker.mjs'), 'stop', 't2', '--root', proj], { env, encoding: 'utf8' }).stdout.trim());
  const r3 = await p3.done;
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, /已被停止/);
  await until(() => !processesWith(marker).length, 15e3, `processes left: ${processesWith(marker).join(', ')}`);
  assert.ok(worker('t2').stopAt > 0);
  ok();
  console.log('\nall live checks passed');
  fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true });
} catch (e) {
  console.log(`FAIL ${e.message}\n${e.stack.split('\n').slice(1, 3).join('\n')}`);
  process.exitCode = 1;
} finally {
  for (const id of ['t1', 't2']) { const w = worker(id); if (w && !w.stopAt) spawnSync(process.execPath, [path.join(SCRIPTS, 'codex-worker.mjs'), 'stop', id, '--root', proj], { env }); }
  if (fs.existsSync(proj)) console.log(`project kept for inspection: ${proj}`);
}
