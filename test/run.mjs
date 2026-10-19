// Tests for the retro hook and CLI with synthetic hook input. Run: node test/run.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'skills', 'retro', 'scripts', 'retro-nudge.mjs');
const CLI = path.join(here, '..', 'skills', 'retro', 'scripts', 'retro.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-test-'));
const MIN = 60e3;
let n = 0, failed = 0;

function setup(name, { goalAgo = 5, cond = 'tests pass', extra = [], sid: sidArg, codexLimit = 12 } = {}) {
  const proj = path.join(TMP, name), tmp = path.join(TMP, name + '-tmp');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const transcript = path.join(proj, 'transcript.jsonl');
  const lines = goalAgo == null ? [] : [goalLine(cond, Date.now() - goalAgo * MIN)];
  fs.writeFileSync(transcript, [...lines, ...extra].map(l => JSON.stringify(l)).join('\n') + '\n');
  const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, CLAUDE_PROJECT_DIR: proj, CODEX_HOME: path.join(tmp, 'codex-home') };
  delete env.RETRO_TIME_SCALE;
  delete env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS;
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  if (codexLimit) fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "x"\n\n[agents]\nmax_concurrent_threads_per_session = ${codexLimit}\n`);
  const sid = sidArg || 'sess-' + name;
  const input = (o = {}) => ({ session_id: sid, transcript_path: transcript, cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', ...o });
  const hook = (o, e = {}) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input(o)), env: { ...env, ...e }, encoding: 'utf8' });
    if (r.stderr) throw new Error(r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const hookAsync = o => new Promise(res => {
    const p = spawn(process.execPath, [HOOK], { env });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', () => res(out ? JSON.parse(out) : null));
    p.stdin.end(JSON.stringify(input(o)));
  });
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a, '--root', proj], { env, encoding: 'utf8' });
  const text = r => (r ? r.hookSpecificOutput?.additionalContext || r.reason || '' : '');
  const retro = p => path.join(proj, '.retro', p);
  const slot = () => Object.fromEntries([...fs.readFileSync(retro('slot'), 'utf8').matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]]));
  const addTranscript = (...ls) => fs.appendFileSync(transcript, ls.map(l => JSON.stringify(l)).join('\n') + '\n');
  const state = ext => path.join(tmp, `claude-retro-${sid}.${ext}`);
  // Pretend each message kind was last said `mins` minutes earlier than recorded.
  const age = mins => { const m = JSON.parse(fs.readFileSync(state('said'), 'utf8')); for (const k in m) m[k] -= mins * MIN; fs.writeFileSync(state('said'), JSON.stringify(m)); };
  const sub = (id, o = {}) => hook({ agent_id: id, agent_type: 'general-purpose', ...o });
  const agentFile = (id, ext = 'json') => path.join(tmp, `claude-retro-${sid}.agents`, `${id}.${ext}`);
  const setTime = (f, mins) => { const t = (Date.now() - mins * MIN) / 1000; fs.utimesSync(f, t, t); };
  // A new row in the project's ledger: something came back.
  const fresh = () => fs.appendFileSync(path.join(proj, 'results.tsv'), 'row\n');
  return { proj, tmp, sid, transcript, hook, hookAsync, cli, text, retro, slot, addTranscript, state, age, sub, agentFile, setTime, fresh, env };
}
const goalLine = (cond, t, extra = {}) => ({ type: 'attachment', timestamp: new Date(t).toISOString(), attachment: { type: 'goal_status', met: false, sentinel: true, condition: cond, ...extra } });
const iso = t => new Date(t).toISOString();
const until = async (ok, ms = 10000) => { const safeOk = () => { try { return ok(); } catch { return false; } }; for (const t0 = Date.now(); !safeOk(); ) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 50)); } };
const codexGoal = (objective, createdAt, status = 'active') => ({ timestamp: iso(Date.now()), type: 'event_msg', payload: { type: 'thread_goal_updated', goal: { objective, status, createdAt } } });
const codexMeta = (id, source = 'vscode') => ({ timestamp: iso(Date.now()), type: 'session_meta', payload: { session_id: id, id, source, base_instructions: { text: 'x' } } });

// TEST_ONLY=<text> runs only the tests whose name contains it.
async function test(name, fn) {
  if (process.env.TEST_ONLY && !name.includes(process.env.TEST_ONLY)) return;
  n++;
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}

await test('no goal: silent, nothing written', () => {
  const t = setup('nogoal', { goalAgo: null });
  assert.equal(t.hook(), null);
  assert.equal(t.sub('a1'), null);
  assert.ok(!fs.existsSync(t.state('call')));
  assert.ok(!fs.existsSync(t.agentFile('a1')), 'a subagent is tracked without an active goal');
  assert.ok(!fs.existsSync(t.retro('slot')));
});

await test('first call of a goal reserves a scout; .retro is self-ignored; session recorded', () => {
  const t = setup('first');
  const r = t.text(t.hook());
  assert.match(r, /已为你登记一次后台侦察/);
  assert.match(r, /idea-scout/);
  const s = t.slot();
  assert.equal(s.state, 'running'); assert.equal(s.type, 'scout'); assert.equal(s.by, t.sid); assert.equal(s.lastScout, s.start);
  assert.equal(fs.readFileSync(t.retro('.gitignore'), 'utf8'), '*\n');
  assert.equal(JSON.parse(fs.readFileSync(t.retro(`sessions/${t.sid}.json`), 'utf8')).goal, 'tests pass');
  assert.equal(t.text(t.hook()), ''); // call 2: nothing
});

await test('unlaunched reservation: reminded 10 min later, not on every call; launching stops it', () => {
  const t = setup('calls');
  assert.match(t.text(t.hook()), /已为你登记/);
  for (let i = 0; i < 5; i++) assert.doesNotMatch(t.text(t.hook()), /还没有启动/);
  t.age(11);
  assert.match(t.text(t.hook()), /还没有启动/);
  assert.doesNotMatch(t.text(t.hook()), /还没有启动/);
  assert.equal(t.cli('spawned', t.slot().start).status, 0);
  t.age(11);
  assert.doesNotMatch(t.text(t.hook()), /还没有启动/);
});

await test('checkpoint: due at 60 min once something came back, repeated every 10 min until done; calls alone never trigger it', () => {
  const t = setup('time', { goalAgo: 61 });
  assert.doesNotMatch(t.text(t.hook()), /检查点到期/); // nothing came back yet
  t.fresh();
  assert.match(t.text(t.hook()), /检查点到期（距上次检查点或目标开始 61 分钟/);
  assert.doesNotMatch(t.text(t.hook()), /检查点到期/);
  t.age(11);
  assert.match(t.text(t.hook()), /检查点到期/);
  assert.equal(t.cli('done').status, 0);
  t.age(11);
  assert.doesNotMatch(t.text(t.hook()), /检查点到期/);
  assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /checkpoint-due[\s\S]*checkpoint-done/);
  assert.equal(t.cli('spawned', '2000-01-01T00:00:00.000Z').status, 2);
  const u = setup('busy', { goalAgo: 30 });
  for (let i = 0; i < 50; i++) u.hook();
  for (let i = 0; i < 6; i++) u.hook({ hook_event_name: 'SubagentStop', agent_id: 'a' + i, agent_type: 'general-purpose' });
  assert.doesNotMatch(u.text(u.hook()), /检查点到期/);
});

await test('Stop leaves native goal continuation alone and does not consume pending reminders in either harness', () => {
  for (const platform of ['claude', 'codex']) {
    const name = 'stop-' + platform, created = Math.floor((Date.now() - 61 * MIN) / 1000);
    const t = setup(name, platform === 'codex' ? { goalAgo: null, extra: [codexMeta('sess-' + name), codexGoal('tests pass', created)] } : { goalAgo: 61 });
    t.hook(); t.cli('spawned', t.slot().start); t.cli('slots', '2', 'x'); t.fresh();
    const before = fs.readFileSync(t.state('said'), 'utf8');
    const slot = fs.readFileSync(t.retro('slot'), 'utf8');
    for (const stop_hook_active of [false, true, true]) assert.equal(t.hook({ hook_event_name: 'Stop', stop_hook_active }), null);
    assert.equal(fs.readFileSync(t.state('said'), 'utf8'), before);
    assert.equal(fs.readFileSync(t.retro('slot'), 'utf8'), slot);
    const r = t.hook();
    assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(t.text(r), /检查点到期/);
    assert.doesNotMatch(t.text(t.hook()), /检查点到期/);
    t.cli('done');
    assert.equal(t.hook({ hook_event_name: 'Stop' }), null);
  }
});

await test('SessionStart after a compaction re-points the main agent at the main loop; other starts and no goal: silent', () => {
  const t = setup('compact', { goalAgo: 30 });
  const r = t.hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(r.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.hookSpecificOutput.additionalContext, /主循环/); assert.match(r.hookSpecificOutput.additionalContext, /status/);
  assert.ok(r.hookSpecificOutput.additionalContext.includes(t.retro('PROGRESS.md')));
  assert.equal(t.hook({ hook_event_name: 'SessionStart', source: 'startup' }), null);
  assert.ok(!fs.existsSync(t.retro('slot')), 'a SessionStart reserved something');
  const u = setup('compactnogoal', { goalAgo: null });
  assert.equal(u.hook({ hook_event_name: 'SessionStart', source: 'compact' }), null);
});

await test('slots: reminded to record them 10 min into a goal; idle slots reported after 5 min, naming who runs', () => {
  const t = setup('slots', { goalAgo: 11 });
  assert.match(t.text(t.hook()), /还没有记下这个目标的名额/);
  const u = setup('slotsearly', { goalAgo: 5 });
  assert.doesNotMatch(u.text(u.hook()), /名额/);
  assert.match(t.cli('slots', '2', 'one GPU').stdout, /已记下名额 2 个/);
  assert.doesNotMatch(t.text(t.hook()), /名额空着/); // just set: grace
  const set = JSON.parse(fs.readFileSync(t.retro('slots'), 'utf8'));
  fs.writeFileSync(t.retro('slots'), JSON.stringify({ ...set, at: iso(Date.now() - 6 * MIN) }));
  assert.match(t.text(t.hook()), /名额是 2 个，现在在跑的执行子代理只有 0 个/);
  const meta = t.transcript.replace(/\.jsonl$/, '') + '/subagents';
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'try expectimax' }));
  t.sub('a1'); t.sub('a2');
  t.age(11);
  assert.doesNotMatch(t.text(t.hook()), /名额空着/);
  t.hook({ hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'general-purpose' });
  t.age(11);
  assert.doesNotMatch(t.text(t.hook()), /名额空着/); // freed just now: grace
  t.setTime(t.agentFile('a2', 'stop'), 6);
  assert.match(t.text(t.hook()), /只有 1 个（try expectimax）/);
  assert.match(t.cli('status').stdout, /名额：2 个（one GPU[\s\S]*在跑 1 个）：try expectimax（在跑/);
});

await test('tracker: a segment past an hour and a silent subagent are reported once; a follow-up starts a new segment', () => {
  const t = setup('tracker', { goalAgo: 90 });
  t.hook(); t.cli('slots', '3', 'x'); t.cli('done');
  t.sub('long'); t.sub('quiet');
  const h = JSON.parse(fs.readFileSync(t.agentFile('long'), 'utf8'));
  fs.writeFileSync(t.agentFile('long'), JSON.stringify({ ...h, seg: Date.now() - 61 * MIN }));
  fs.writeFileSync(t.agentFile('quiet'), JSON.stringify({ ...h, seg: Date.now() - 30 * MIN }));
  t.setTime(t.agentFile('quiet'), 25);
  const r = t.text(t.hook());
  assert.match(r, /「long」（general-purpose）这一段已经连续跑了 61 分钟/);
  assert.match(r, /「quiet」（general-purpose）已经 25 分钟没有任何动静/);
  const r2 = t.text(t.hook());
  assert.doesNotMatch(r2, /连续跑了|没有任何动静/);
  t.hook({ hook_event_name: 'SubagentStop', agent_id: 'long', agent_type: 'general-purpose' });
  t.sub('long'); // a follow-up
  assert.ok(Date.now() - JSON.parse(fs.readFileSync(t.agentFile('long'), 'utf8')).seg < MIN);
  assert.ok(!fs.existsSync(t.agentFile('long', 'stop')));
  // The review/scout, internal agents and Codex guardians are not tracked.
  for (const agent_type of ['', 'route-reviewer', 'idea-scout', 'guardian']) t.sub('x' + agent_type, { agent_type });
  assert.deepEqual(fs.readdirSync(path.dirname(t.agentFile('long'))).filter(f => f.startsWith('x')), []);
});

await test('silence: observed after 5 min or 15 min waiting on a tool; repeated observation leaves the decision to the main agent', () => {
  const t = setup('silence', { goalAgo: 30 });
  t.hook(); t.cli('slots', '3', 'x');
  for (const id of ['idle', 'tool', 'busy']) t.sub(id);
  // tool and busy wait on a Bash call, as their own transcripts show.
  const sdir = path.join(t.transcript.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(sdir, { recursive: true });
  const callOut = (id, mins) => fs.writeFileSync(path.join(sdir, `agent-${id}.jsonl`), [
    { type: 'user', timestamp: iso(Date.now() - (mins + 1) * MIN), message: { content: [{ type: 'tool_result', tool_use_id: 'u0' }] } },
    { type: 'assistant', timestamp: iso(Date.now() - mins * MIN), message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', timestamp: iso(Date.now()), message: { content: '主 agent 发来的消息不算它的动静' } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  callOut('tool', 16); callOut('busy', 10);
  for (const [id, m] of [['idle', 6], ['tool', 16], ['busy', 10]]) t.setTime(t.agentFile(id), m);
  const r = t.text(t.hook());
  assert.match(r, /子代理「idle」（general-purpose）已经 6 分钟没有任何动静，也不在等工具/);
  assert.match(r, /决定打断后可用：用 TaskStop 停掉它（idle）/);
  assert.match(r, /子代理「tool」（general-purpose）在等的工具调用 Bash（npm test） 已经 16 分钟没有返回/);
  assert.doesNotMatch(r, /「busy」/);
  assert.match(t.cli('status').stdout, /busy（在跑，这一段 \d+ 分钟，在等工具调用「Bash（npm test）」（10 分钟）/);
  assert.doesNotMatch(t.text(t.hook()), /没有任何动静|没有返回/);
  // Still no activity after the first observation: another reminder, without changing the executor state.
  t.age(6);
  assert.match(t.text(t.hook()), /子代理「idle」（general-purpose）上次提醒之后又 6 分钟没有动静/);
  assert.ok(!fs.existsSync(t.agentFile('idle', 'stop')));
  const logged = fs.readFileSync(t.retro('log.tsv'), 'utf8');
  assert.match(logged, /\tagent-quiet\tidle 6min\n/); assert.match(logged, /\tagent-quiet\ttool 16min tool\n/); assert.match(logged, /\tagent-stuck\tidle\n/);
  // A tool call that ran 5 min or more: the subagent is asked right away.
  assert.match(t.text(t.sub('idle', { duration_ms: 6 * MIN })), /这个工具调用（Bash）跑了 6 分钟/);
  assert.equal(t.sub('idle', { duration_ms: 1000 }), null);
  assert.equal(t.sub('x', { agent_type: 'route-reviewer', duration_ms: 6 * MIN }), null);
});

await test('bottleneck: Codex first tool is timed before returning; fresh activity cannot hide it; main hears it once before 20 min', () => {
  const created = Math.floor((Date.now() - 15 * MIN) / 1000);
  const t = setup('slow-codex', { goalAgo: null, extra: [codexMeta('sess-slow-codex'), codexGoal('tests pass', created)] });
  t.hook();
  const call = { agent_id: 'tester', agent_type: 'worker', tool_name: 'Bash', tool_use_id: 'test-1', tool_input: { command: 'npm test' } };
  assert.equal(t.hook({ ...call, hook_event_name: 'PreToolUse' }), null);
  assert.ok(fs.existsSync(t.agentFile('tester')), 'the first running tool is invisible until it returns');
  const file = path.join(t.state('tools'), 'test-1.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  rec.at = Date.now() - 11 * MIN;
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.match(t.cli('status').stdout, /工具耗时：tester — npm test.*11 分钟/);
  t.sub('tester', { agent_type: 'worker' }); // the executor is still active
  const msg = t.text(t.hook());
  assert.match(msg, /瓶颈检查：执行者「tester」的「npm test」.*已经 11 分钟/);
  assert.match(msg, /CPU\/GPU\/内存/);
  assert.doesNotMatch(msg, /没有任何动静|被问过之后/);
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /tool-slow\ttester 11min npm test/);
  t.hook({ ...call, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } });
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  assert.ok(!fs.existsSync(file), 'a completed, delivered timing was not removed');
  // The same command in a later call is a new measurement.
  t.hook({ ...call, tool_use_id: 'test-2', hook_event_name: 'PreToolUse' });
  const second = path.join(t.state('tools'), 'test-2.json');
  const next = JSON.parse(fs.readFileSync(second, 'utf8'));
  fs.writeFileSync(second, JSON.stringify({ ...next, at: Date.now() - 12 * MIN }));
  assert.match(t.text(t.hook()), /瓶颈检查/);
  t.addTranscript(codexGoal('tests pass', created, 'paused'));
  assert.equal(t.hook(), null);
});

await test('bottleneck: background command polling preserves the start; short and completed jobs are cleaned up', () => {
  const t = setup('slow-background');
  t.hook();
  const call = { agent_id: 'tester', agent_type: 'general-purpose', tool_use_id: 'bg', tool_input: { command: 'python eval.py' } };
  t.hook({ ...call, hook_event_name: 'PreToolUse' });
  t.hook({ ...call, tool_response: 'Wall time: 1 seconds\nProcess running with session ID 123\n' });
  const file = path.join(t.state('tools'), 'bg.json'), rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.at = Date.now() - 12 * MIN;
  fs.writeFileSync(file, JSON.stringify(rec));
  for (let i = 0; i < 3; i++) t.hook({ ...call, tool_name: 'write_stdin', tool_use_id: `poll-${i}`, tool_input: { session_id: 123 }, tool_response: { session_id: 123, output: 'progress' } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at, rec.at);
  assert.match(t.text(t.hook()), /瓶颈检查.*python eval\.py.*12 分钟/);
  t.hook({ ...call, tool_name: 'write_stdin', tool_input: { session_id: 123 }, tool_response: 'Wall time: 1 seconds\nProcess exited with code 0\n' });
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  assert.ok(!fs.existsSync(file));
  // Claude's background task has the same lifetime across TaskOutput polls.
  t.hook({ ...call, hook_event_name: 'PreToolUse' });
  t.hook({ ...call, tool_response: { backgroundTaskId: 'task-1' } });
  t.hook({ ...call, tool_name: 'TaskOutput', tool_input: { task_id: 'task-1' }, tool_response: { task: { status: 'running' } } });
  assert.ok(fs.existsSync(file));
  t.hook({ ...call, tool_name: 'TaskOutput', tool_input: { task_id: 'task-1' }, tool_response: { task: { status: 'completed' } } });
  assert.ok(!fs.existsSync(file));
  t.hook({ ...call, hook_event_name: 'PreToolUse' });
  t.hook({ ...call, tool_response: 'null' });
  assert.ok(!fs.existsSync(file));
});

await test('bottleneck: a late result cannot enter a replacement goal; repeated reads keep the first completion time', () => {
  const t = setup('slow-boundaries', { goalAgo: 30 });
  t.hook();
  const call = { agent_id: 'tester', agent_type: 'general-purpose', tool_use_id: 'old', tool_input: { command: 'npm test' } };
  t.hook({ ...call, hook_event_name: 'PreToolUse' });
  const file = path.join(t.state('tools'), 'old.json'), rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, at: Date.now() - 12 * MIN }));
  t.addTranscript(goalLine('new goal', Date.now()));
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  t.hook({ ...call, duration_ms: 12 * MIN, tool_response: { exit_code: 0 } });
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  assert.ok(!fs.existsSync(file));
  t.hook({ ...call, hook_event_name: 'PreToolUse' });
  t.hook({ ...call, tool_response: { backgroundTaskId: 'bg' } });
  const ended = Date.now() - MIN;
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...current, at: ended - 11 * MIN, ended }));
  t.hook({ ...call, tool_name: 'TaskOutput', tool_input: { task_id: 'bg' }, tool_response: { task: { status: 'completed' } } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ended, ended);
});

await test('bottleneck: a slow failed tool is reported to its executor and main; watch wakes on elapsed time, not silence', () => {
  const t = setup('slow-failure');
  t.hook();
  const call = { agent_id: 'tester', agent_type: 'general-purpose', tool_use_id: 'slow', tool_input: { command: 'npm test' } };
  t.hook({ ...call, hook_event_name: 'PreToolUse' });
  const file = path.join(t.state('tools'), 'slow.json'), rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, at: Date.now() - 11 * MIN }));
  const wake = t.cli('watch');
  assert.equal(wake.status, 0);
  assert.match(wake.stdout, /有执行者要处理/);
  assert.equal(t.hook({ hook_event_name: 'Stop' }), null);
  assert.match(t.text(t.hook()), /瓶颈检查/);
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  const fail = t.hook({ ...call, hook_event_name: 'PostToolUseFailure', duration_ms: 11 * MIN });
  assert.equal(fail.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(t.text(fail), /跑了 11 分钟/);
  t.hook();
  assert.ok(!fs.existsSync(file));
  // Completion before the main agent wakes must not swallow the alert, even without a PreToolUse record.
  t.hook({ ...call, tool_use_id: 'failed-2', hook_event_name: 'PostToolUseFailure', duration_ms: 12 * MIN });
  assert.match(t.text(t.hook()), /瓶颈检查.*已返回，用时 12 分钟/);
});

await test('bottleneck: a driven worker with fresh heartbeats is reported; monitor and driver wrappers are excluded', () => {
  const t = setup('slow-worker');
  t.hook();
  t.cli('worker', 'start', 'eval', 'long evaluation', '--pid', String(process.pid), '--type', 'codex');
  const file = t.retro('workers/eval.json'), rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, driver: 'codex-worker', cmd: 'python eval.py', cmdAt: Date.now() - 11 * MIN }));
  assert.match(t.text(t.hook()), /瓶颈检查.*python eval\.py.*11 分钟/);
  assert.doesNotMatch(t.text(t.hook()), /瓶颈检查/);
  for (const command of ['node "retro.mjs" watch', 'node "codex-worker.mjs" run eval']) {
    t.hook({ hook_event_name: 'PreToolUse', tool_use_id: 'wrapper', tool_input: { command } });
    assert.ok(!fs.existsSync(path.join(t.state('tools'), 'wrapper.json')));
  }
  const no = setup('slow-no-goal', { goalAgo: null });
  assert.equal(no.hook({ hook_event_name: 'PreToolUse', tool_use_id: 'x', tool_input: { command: 'npm test' } }), null);
  assert.ok(!fs.existsSync(no.state('tools')));
});

await test('watch: tool events suggest monitoring; wake does not consume the reminder; one watch per session', async () => {
  const t = setup('watch', { goalAgo: 30 });
  t.hook(); t.cli('slots', '3', 'x');
  t.sub('w1');
  assert.equal(t.hook({ hook_event_name: 'Stop' }), null);
  assert.match(t.text(t.hook()), /后台却没有 retro 的 watch[\s\S]*watch --session sess-watch --root "[^"]+"/);
  // A delayed launch result must not recreate a dead watch's liveness file.
  t.hook({ tool_input: { command: `node "${CLI}" watch --session sess-watch --root "${t.proj}"`, run_in_background: true } });
  assert.ok(!fs.existsSync(t.state('watch')));
  t.age(11);
  assert.match(t.text(t.hook()), /retro 的 watch/);
  // In scaled time (5 min = 3 s): it waits while w1 is fine, then exits with the note.
  const env = { ...t.env, RETRO_TIME_SCALE: '0.01' }, wf = t.state('watch');
  t.sub('w1');
  const w = spawn(process.execPath, [CLI, 'watch', '--root', t.proj], { env });
  let out = '';
  w.stdout.on('data', d => (out += d));
  const done = new Promise(res => w.on('close', res));
  await until(() => fs.readFileSync(wf, 'utf8') === String(w.pid), 5000);
  t.hook();
  assert.doesNotMatch(t.text(t.hook()), /retro 的 watch/);
  const second = spawnSync(process.execPath, [CLI, 'watch', '--session', 'sess-watch', '--root', t.proj], { env, encoding: 'utf8' });
  assert.match(second.stdout, new RegExp(`已经有一个 watch 在跑（进程 ${w.pid}）`));
  assert.equal(w.exitCode, null);
  await done;
  // The main agent sees only that it ended: the hook says what to do.
  assert.match(out, /有执行者要处理：子代理「w1」（general-purpose）/);
  assert.ok(!fs.existsSync(wf));
  // Started again before the hook spoke, it doesn't wake the main agent for the same thing.
  const w2 = spawn(process.execPath, [CLI, 'watch', '--root', t.proj], { env });
  let out2 = '';
  w2.stdout.on('data', d => (out2 += d));
  const done2 = new Promise(res => w2.on('close', res));
  await new Promise(res => setTimeout(res, 1500));
  assert.equal(w2.exitCode, null);
  const scaled = () => t.text(t.hook({}, { RETRO_TIME_SCALE: '0.01' }));
  // Stop never consumes the event, even after watch exits. The next tool event delivers it.
  assert.equal(t.hook({ hook_event_name: 'Stop' }, { RETRO_TIME_SCALE: '0.01' }), null);
  assert.match(scaled(), /子代理「w1」（general-purpose）已经 \d+ 分钟没有任何动静，也不在等工具/);
  assert.doesNotMatch(scaled(), /「w1」/);
  // Still silent after the observation: watch wakes again, leaving the decision to the main agent.
  await done2;
  assert.match(out2, /有执行者要处理：子代理「w1」/);
  const repeated = scaled();
  assert.match(repeated, /子代理「w1」（general-purpose）上次提醒之后又 \d+ 分钟没有动静/);
  assert.match(repeated, /watch --session sess-watch/);
  assert.ok(!fs.existsSync(t.agentFile('w1', 'stop')));
  // Nothing running and nothing launched lately: watch exits at once.
  t.hook({ hook_event_name: 'SubagentStop', agent_id: 'w1', agent_type: 'general-purpose' });
  assert.match(spawnSync(process.execPath, [CLI, 'watch', '--root', t.proj], { env, encoding: 'utf8' }).stdout, /没有在跑的执行者了，watch 退出/);
  assert.doesNotMatch(t.text(t.hook()), /retro 的 watch/);
  // A foreground subagent has finished by the time its call returns; one in the background is about to run.
  t.age(11);
  assert.doesNotMatch(t.text(t.hook({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'x' } })), /retro 的 watch/);
  assert.match(t.text(t.hook({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'x', run_in_background: true } })), /retro 的 watch/);
  // The goal state unreadable (the hook rewrites it at every event): not taken for the goal ending.
  fs.unlinkSync(t.state('goal'));
  const gone = spawnSync(process.execPath, [CLI, 'watch', '--root', t.proj], { env, encoding: 'utf8' }).stdout;
  assert.match(gone, /读不到这个会话的目标状态/);
});

await test('silence in Codex: a subagent\'s own rollout shows its tool call out, and what it was told is not its step; the note says interrupt_agent and followup_task; a torn tracker header is no overtime', () => {
  const created = Math.floor((Date.now() - 30 * MIN) / 1000);
  const t = setup('silencecodex', { goalAgo: null, extra: [codexMeta('sess-silencecodex'), codexGoal('codex goal', created)] });
  t.hook(); t.cli('slots', '3', 'x');
  const rollout = id => path.join(t.tmp, `rollout-2026-10-17T00-00-00-${id}.jsonl`);
  const rec = (mins, type, payload) => ({ timestamp: iso(Date.now() - mins * MIN), type, payload });
  const write = (id, recs) => fs.writeFileSync(rollout(id), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  write('k1', [rec(17, 'event_msg', { type: 'task_started' }), rec(16, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'c1' })]);
  write('k2', [rec(17, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'c1' }), rec(16, 'response_item', { type: 'function_call_output', call_id: 'c1' }),
    rec(0, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '主 agent 发来的' }] })]);
  for (const id of ['k1', 'k2']) { t.sub(id, { transcript_path: rollout(id), agent_type: 'worker' }); t.setTime(t.agentFile(id), 16); }
  fs.writeFileSync(t.agentFile('torn'), '');
  const r = t.text(t.hook());
  assert.match(r, /子代理「k1」（worker）在等的工具调用 exec_command 已经 16 分钟没有返回/);
  assert.match(r, /决定打断后可用：用 interrupt_agent 打断它，再用 followup_task 对它说/);
  assert.match(r, /子代理「k2」（worker）已经 16 分钟没有任何动静，也不在等工具/);
  assert.doesNotMatch(r, /连续跑了/);
});

await test('idle slots: a launch restarts the grace; reminders never block Stop', () => {
  const t = setup('idlelaunch', { goalAgo: 30 });
  t.hook(); t.cli('spawned', t.slot().start);
  const set = { n: 2, at: iso(Date.now() - 6 * MIN), why: 'x' };
  fs.writeFileSync(t.retro('slots'), JSON.stringify(set));
  // Launching an executor: it is tracked only from its first tool call, so neither this call nor the Stop says idle.
  assert.doesNotMatch(t.text(t.hook({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'x', run_in_background: true } })), /名额空着/);
  assert.doesNotMatch(t.text(t.hook({ hook_event_name: 'Stop' })), /名额空着/);
  fs.writeFileSync(t.state('launch'), String(Date.now() - 6 * MIN));
  assert.match(t.text(t.hook()), /名额空着/);
  assert.equal(t.hook({ hook_event_name: 'Stop' }), null);
});

await test('tracker: events other than tool calls and stops (a child SessionStart) do not restart a stopped agent', () => {
  const t = setup('trackev', { goalAgo: 10 });
  t.hook();
  t.sub('k'); t.hook({ hook_event_name: 'SubagentStop', agent_id: 'k', agent_type: 'general-purpose' });
  t.hook({ hook_event_name: 'SessionStart', source: 'compact', agent_id: 'k', agent_type: 'general-purpose' });
  t.hook({ hook_event_name: 'Stop', agent_id: 'k', agent_type: 'general-purpose' });
  assert.ok(fs.existsSync(t.agentFile('k', 'stop')));
});

await test('request: one left over from an earlier goal is ignored; the new goal gets its scout', () => {
  const t = setup('requestold', { goalAgo: 2 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  fs.writeFileSync(t.retro('slot'), `state=done type=review start=${iso(Date.now() - 30 * MIN)} by=x want=review wantAt=${iso(Date.now() - 20 * MIN)}\n`);
  assert.match(t.text(t.hook()), /已为你登记一次后台侦察/);
});

await test('request: a review is reserved at the next call; while one runs, right after it ends', () => {
  const t = setup('request', { goalAgo: 30 });
  t.hook();
  const scout = t.slot().start;
  assert.match(t.cli('request', 'review').stdout, /它结束后/);
  assert.doesNotMatch(t.text(t.hook()), /按你的请求/);
  fs.writeFileSync(path.join(t.tmp, 'r.md'), '想法：A');
  assert.equal(t.cli('finish', scout, path.join(t.tmp, 'r.md')).status, 0);
  const r = t.text(t.hook());
  assert.match(r, /后台评审（按你的请求）/);
  assert.equal(t.slot().type, 'review'); assert.ok(!t.slot().want);
  assert.equal(t.cli('request', 'nonsense').status, 1);
});

await test('capacity: Codex default or one child and Claude one child work without a minimum gate or reserved subtraction', () => {
  for (const limit of [0, 1]) {
    const name = 'limitcodex' + limit, created = Math.floor((Date.now() - 61 * MIN) / 1000);
    const t = setup(name, { goalAgo: null, codexLimit: limit, extra: [codexMeta('sess-' + name), codexGoal('codex goal', created)] });
    assert.match(t.text(t.hook()), /已为你登记/);
    assert.equal(t.cli('slots', '1', 'one GPU').status, 0);
    assert.equal(t.cli('abort', t.slot().start).status, 0);
    t.fresh();
    assert.match(t.text(t.hook()), /检查点到期/);
    assert.equal(t.slot().state, 'aborted', 'an optional review was immediately reserved again');
  }
  const u = setup('limitclaude');
  assert.match(u.text(u.hook({}, { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '1' })), /已为你登记/);
  assert.equal(u.cli('slots', '1', 'single executor').status, 0);
});

await test('Stop before the first tool does not claim reminders or reserve a review', () => {
  const t = setup('mute', { goalAgo: 5 });
  assert.equal(t.hook({ hook_event_name: 'Stop' }), null);
  assert.ok(!fs.existsSync(t.retro('slot'))); // the scout was not reserved silently
  assert.ok(!fs.existsSync(t.state('said')));
});

await test('unspawned optional review: Stop stays silent, tool reminder can be cancelled without immediate re-reservation', () => {
  const t = setup('stopslot');
  t.hook();
  t.age(11);
  assert.equal(t.hook({ hook_event_name: 'Stop', stop_hook_active: false }), null);
  assert.match(t.text(t.hook()), /还没有启动[\s\S]*abort/);
  const start = t.slot().start;
  assert.equal(t.cli('abort', start).status, 0);
  assert.doesNotMatch(t.text(t.hook()), /已为你登记|还没有启动/);
  assert.equal(t.slot().state, 'aborted');
  t.cli('request', 'review');
  assert.match(t.text(t.hook()), /按你的请求/);
  assert.equal(t.slot().type, 'review');
});

await test('subagent tool calls get no messages and only feed the tracker', () => {
  const t = setup('sub', { goalAgo: 61 });
  t.hook();
  assert.equal(t.sub('abc'), null);
  assert.equal(t.hook({ hook_event_name: 'SubagentStop', agent_id: 'abc', agent_type: 'general-purpose' }), null);
  assert.ok(fs.existsSync(t.agentFile('abc')) && fs.existsSync(t.agentFile('abc', 'stop')));
});

await test('overdue review is voided; owner told once to stop it', () => {
  const t = setup('void', { goalAgo: 50 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  const start = iso(Date.now() - 25 * MIN);
  fs.writeFileSync(t.retro('slot'), `state=running type=review start=${start} by=${t.sid} spawned=${start} lastScout=${iso(Date.now() - MIN)}\n`);
  assert.match(t.text(t.hook()), /超过时间上限/);
  assert.equal(t.slot().state, 'aborted');
  assert.doesNotMatch(t.text(t.hook()), /超过时间上限/);
  const fin = spawnSync(process.execPath, [CLI, 'finish', start, '-', '--root', t.proj], { env: t.env, input: '结论：保持', encoding: 'utf8' });
  assert.equal(fin.status, 2); // voided: report refused
  assert.ok(!fs.existsSync(t.retro('route-review.md')));
});

await test('another session voids it; the owner learns once on its next call', () => {
  const owner = setup('voidA', { sid: 'owner', goalAgo: 60 }), other = setup('voidA', { sid: 'other', goalAgo: 60 }); // same project and transcript
  const start = iso(Date.now() - 45 * MIN);
  fs.mkdirSync(owner.retro(''), { recursive: true });
  fs.writeFileSync(owner.retro('slot'), `state=running type=scout start=${start} by=owner spawned=${start} lastScout=${start}\n`);
  assert.doesNotMatch(other.text(other.hook()), /超过时间上限/);
  assert.equal(owner.slot().state, 'aborted'); assert.ok(owner.slot().spawned);
  assert.match(owner.text(owner.hook()), /超过时间上限/);
  assert.ok(!owner.slot().spawned);
  assert.doesNotMatch(owner.text(owner.hook()), /超过时间上限/);
});

await test('scout lasts 40 min: not voided at 25 min', () => {
  const t = setup('scoutlimit', { goalAgo: 50 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  const start = iso(Date.now() - 25 * MIN);
  fs.writeFileSync(t.retro('slot'), `state=running type=scout start=${start} by=${t.sid} spawned=${start} lastScout=${start}\n`);
  t.hook();
  assert.equal(t.slot().state, 'running');
});

await test('hourly slot: review normally, scout when the pool runs low after a review, stall when nothing came back', () => {
  const t = setup('types', { goalAgo: 180 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  const prev = iso(Date.now() - 61 * MIN), scout = iso(Date.now() - 121 * MIN);
  t.cli('done');
  // a result after the previous slot -> review
  fs.mkdirSync(t.retro('tasks/x'), { recursive: true });
  fs.writeFileSync(t.retro('tasks/x/report.md'), '结果：z');
  fs.writeFileSync(t.retro('slot'), `state=done type=scout start=${prev} by=${t.sid} lastScout=${prev}\n`);
  assert.match(t.text(t.hook()), /后台评审/);
  // the pool is low and the previous one was a review -> scout
  fs.writeFileSync(t.retro('slot'), `state=done type=review start=${prev} by=${t.sid} lastScout=${scout}\n`);
  fs.writeFileSync(t.retro('ideas.md'), '- [ ] one\n- [x] two\n');
  assert.match(t.text(t.hook()), /后台侦察/);
  // nothing came back since the previous slot -> stall, then quiet for an hour
  const old = (Date.now() - 2 * 61 * MIN) / 1000;
  fs.utimesSync(t.retro('tasks/x/report.md'), old, old);
  fs.writeFileSync(t.retro('slot'), `state=done type=review start=${prev} by=${t.sid} lastScout=${scout}\n`);
  assert.match(t.text(t.hook()), /过去 1 小时没有可见的新结果/);
  assert.equal(t.slot().state, 'stalled');
  assert.doesNotMatch(t.text(t.hook()), /过去 1 小时|登记/);
});

await test('finish writes the review, archives it and frees the slot; inbox lists it', () => {
  const t = setup('finish', { goalAgo: 70 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  fs.writeFileSync(t.retro('slot'), `state=done type=scout start=${iso(Date.now() - 61 * MIN)} by=${t.sid} lastScout=${iso(Date.now() - 61 * MIN)}\n`);
  fs.mkdirSync(t.retro('tasks/x'), { recursive: true });
  fs.writeFileSync(t.retro('tasks/x/report.md'), '结果：做完了');
  t.cli('done');
  t.hook();
  const s = t.slot();
  assert.equal(s.type, 'review');
  const rep = path.join(t.tmp, 'r.md');
  fs.writeFileSync(rep, '结论：保持');
  assert.equal(t.cli('spawned', s.start).status, 0);
  const f = t.cli('finish', s.start, rep);
  assert.equal(f.status, 0, f.stdout);
  assert.match(fs.readFileSync(t.retro('route-review.md'), 'utf8'), /结论：保持/);
  assert.equal(fs.readdirSync(t.retro('reviews')).length, 1);
  assert.equal(t.slot().state, 'done');
  assert.match(t.cli('inbox').stdout, /路线评审/);
});

await test('scout finish goes to tasks/scout-*/report.md', () => {
  const t = setup('scoutfinish');
  t.hook();
  const s = t.slot();
  const r = spawnSync(process.execPath, [CLI, 'finish', s.start, '-', '--root', t.proj], { env: t.env, input: '想法：A', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
  const dirs = fs.readdirSync(t.retro('tasks'));
  assert.equal(dirs.length, 1); assert.match(dirs[0], /^scout-/);
});

await test('parallel calls: exactly one checkpoint reminder and one reservation', async () => {
  const t = setup('parallel', { goalAgo: 61 });
  t.fresh();
  const rs = await Promise.all(Array.from({ length: 10 }, () => t.hookAsync()));
  assert.equal(rs.filter(r => /检查点到期/.test(t.text(r))).length, 1);
  assert.equal(rs.filter(r => /已为你登记/.test(t.text(r))).length, 1);
});

await test('status and metrics are read-only, including expired executor records', () => {
  const t = setup('status-readonly');
  t.hook(); t.sub('old-agent'); t.cli('worker', 'start', 'old-worker', 'expired');
  const old = Date.now() - 2 * 864e5;
  fs.writeFileSync(t.agentFile('old-agent'), JSON.stringify({ type: 'executor', seg: old }));
  fs.writeFileSync(t.agentFile('old-agent', 'stop'), '');
  const worker = t.retro('workers/old-worker.json');
  fs.writeFileSync(worker, JSON.stringify({ seg: old, stopAt: old, type: 'external' }));
  for (const file of [t.agentFile('old-agent'), t.agentFile('old-agent', 'stop'), worker]) fs.utimesSync(file, old / 1000, old / 1000);
  const snapshot = base => fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const file = path.join(base, e.name);
    return e.isDirectory() ? snapshot(file) : [[file, fs.statSync(file).mtimeMs, fs.readFileSync(file).toString('base64')]];
  });
  const before = [snapshot(t.proj), snapshot(t.tmp)];
  assert.equal(t.cli('status').status, 0);
  assert.equal(t.cli('metrics').status, 0);
  assert.deepEqual([snapshot(t.proj), snapshot(t.tmp)], before);
  t.hook(); // Normal hook maintenance still cleans up expired records.
  assert.ok(!fs.existsSync(t.agentFile('old-agent')));
  assert.ok(!fs.existsSync(worker));
});

await test('goal replaced while unfinished -> one note; same goal re-recorded on compaction keeps its start', () => {
  const t = setup('replace', { goalAgo: 30, cond: 'long goal' });
  t.hook();
  const start1 = JSON.parse(fs.readFileSync(path.join(t.tmp, `claude-retro-${t.sid}.goal`), 'utf8')).start;
  t.addTranscript(goalLine('long goal', Date.now() - 10 * MIN)); // compaction / resume rewrite
  t.hook();
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.tmp, `claude-retro-${t.sid}.goal`), 'utf8')).start, start1);
  t.addTranscript(goalLine('checkpoint now', Date.now()));
  const r = t.text(t.hook());
  assert.match(r, /原目标是「long goal」/);
  assert.doesNotMatch(t.text(t.hook()), /原目标/);
});

await test('"/goal resume" is flagged with the previous goal text', () => {
  const t = setup('resume', { goalAgo: 30, cond: 'long goal' });
  t.addTranscript({ type: 'attachment', timestamp: iso(Date.now() - 20 * MIN), attachment: { type: 'goal_status', met: true, condition: 'long goal' } });
  t.addTranscript(goalLine('resume', Date.now()));
  assert.equal(t.hook({ hook_event_name: 'Stop', stop_hook_active: false }), null);
  const r = t.text(t.hook());
  assert.match(r, /字面上的「resume」/); assert.match(r, /long goal/);
});

await test('goal cleared and goal met make it inactive', () => {
  const t = setup('cleared', { goalAgo: 61 });
  t.addTranscript({ type: 'system', timestamp: iso(Date.now()), content: '<local-command-stdout>Goal cleared</local-command-stdout>' });
  assert.equal(t.hook(), null);
  const u = setup('met', { goalAgo: 61 });
  u.addTranscript({ type: 'attachment', timestamp: iso(Date.now()), attachment: { type: 'goal_status', met: true, condition: 'tests pass' } });
  assert.equal(u.hook(), null);
});

await test('Codex goal events: active with createdAt as start, paused = inactive', () => {
  const created = Math.floor((Date.now() - 61 * MIN) / 1000);
  const ev = status => ({ timestamp: iso(Date.now()), type: 'event_msg', payload: { type: 'thread_goal_updated', goal: { objective: 'codex goal', status, createdAt: created } } });
  const t = setup('codex', { goalAgo: null, extra: [ev('active')] });
  t.fresh();
  assert.match(t.text(t.hook()), /检查点到期（距上次检查点或目标开始 61 分钟/);
  t.addTranscript(ev('paused'));
  assert.equal(t.hook(), null);
  t.addTranscript(ev('active'));
  t.age(11);
  assert.match(t.text(t.hook()), /检查点到期（距上次检查点或目标开始 61 分钟/); // resumed: same goal, same start
});

await test('PROGRESS.md over 4 KB is flagged in the retro nudge and by done', () => {
  for (const layout of ['legacy', 'retro']) {
    const t = setup('big-' + layout, { goalAgo: 61 });
    t.fresh();
    const file = layout === 'retro' ? t.retro('PROGRESS.md') : path.join(t.proj, 'PROGRESS.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(5000));
    assert.match(t.text(t.hook()), /超过 4 KB/, layout);
    assert.match(t.cli('done').stdout, /超过 4 KB/, layout);
    assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /PROGRESS 4\.9KB/, layout);
  }
});

await test('PROGRESS.md: status prefers .retro, falls back to legacy and never moves either file', () => {
  const t = setup('progress-path', { goalAgo: 61 });
  const legacy = path.join(t.proj, 'PROGRESS.md'), current = t.retro('PROGRESS.md');
  const old = 'legacy progress\n' + 'x'.repeat(5000), next = 'current progress\n';
  fs.writeFileSync(legacy, old);
  const legacyTime = fs.statSync(legacy).mtimeMs;
  assert.match(t.cli('status').stdout, /## PROGRESS\.md[\s\S]*legacy progress/);
  assert.ok(!fs.existsSync(current), 'reading legacy progress created a new copy');
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(current, next);
  const currentTime = fs.statSync(current).mtimeMs;
  const status = t.cli('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /## \.retro[/\\]PROGRESS\.md[\s\S]*current progress/);
  assert.doesNotMatch(status.stdout, /legacy progress/);
  for (const [file, content, time] of [[legacy, old, legacyTime], [current, next, currentTime]]) {
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.statSync(file).mtimeMs, time);
  }
  t.fresh();
  assert.doesNotMatch(t.text(t.hook()), /超过 4 KB/);
  assert.doesNotMatch(t.cli('done').stdout, /超过 4 KB|缺失或为空/);
  assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /PROGRESS 0\.0KB/);
  fs.writeFileSync(current, '');
  assert.doesNotMatch(t.cli('status').stdout, /legacy progress/, 'empty current progress must not revive stale legacy content');
});

await test('PROGRESS.md: goal recovery prefers .retro, even when the current file is empty', () => {
  for (const content of ['目标（同 /goal）：current goal · 怎么证明：log\n', '']) {
    const t = setup(content ? 'progress-goal' : 'progress-empty', { cond: 'resume' });
    fs.writeFileSync(path.join(t.proj, 'PROGRESS.md'), '目标：stale legacy goal\n');
    fs.mkdirSync(t.retro(''), { recursive: true });
    fs.writeFileSync(t.retro('PROGRESS.md'), content);
    const text = t.text(t.hook());
    assert.doesNotMatch(text, /stale legacy goal/);
    if (content) assert.match(text, /原目标是「current goal」/);
    else assert.doesNotMatch(text, /原目标是/);
  }
});

await test('status digest reads the main transcript and subagents', () => {
  const t = setup('status');
  t.addTranscript({ type: 'assistant', timestamp: iso(Date.now()), message: { content: [{ type: 'text', text: '派出两个任务' }, { type: 'tool_use', name: 'Agent', input: { description: 'try idea A' } }] } });
  t.addTranscript({ type: 'user', timestamp: iso(Date.now()), message: { content: '进度怎样？' } });
  const sub = t.transcript.replace(/\.jsonl$/, '') + '/subagents';
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '跑完第一组' }] } }) + '\n');
  fs.writeFileSync(path.join(sub, 'agent-1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'idea A' }));
  t.hook();
  const out = t.cli('status').stdout;
  for (const s of ['目标：tests pass', '派出两个任务', 'Agent（try idea A）', '进度怎样', 'idea A（general-purpose', '跑完第一组', '全局侦察 running']) assert.ok(out.includes(s), `missing ${s}\n${out}`);
});

await test('launching the reserved agent marks it started; a Stop right after does not say "not started"', () => {
  const t = setup('launch');
  t.hook();
  t.hook({ tool_name: 'Agent', tool_input: { subagent_type: 'idea-scout', prompt: 'x', run_in_background: true } });
  assert.ok(t.slot().spawned);
  const r = t.hook({ hook_event_name: 'Stop' });
  assert.ok(!r || !/还没有启动/.test(r.reason));
  assert.equal(t.cli('spawned', t.slot().start).status, 0); // the agent's own mark still works
});

await test('a reservation not launched within 20 min is voided; the limit runs from launch', () => {
  const t = setup('unlaunched', { goalAgo: 90 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  fs.writeFileSync(t.retro('slot'), `state=running type=review start=${iso(Date.now() - 21 * MIN)} by=${t.sid} lastScout=${iso(Date.now() - 80 * MIN)}\n`);
  t.hook();
  assert.equal(t.slot().state, 'aborted');
  assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /slot-unlaunched/);
  const u = setup('fromlaunch', { goalAgo: 90 });
  fs.mkdirSync(u.retro(''), { recursive: true });
  fs.writeFileSync(u.retro('slot'), `state=running type=review start=${iso(Date.now() - 30 * MIN)} by=${u.sid} spawned=${iso(Date.now() - 5 * MIN)} lastScout=${iso(Date.now() - 80 * MIN)}\n`);
  u.hook();
  assert.equal(u.slot().state, 'running');
});

await test('finish past the deadline is refused; a busy lock exits 3, not 2', () => {
  const t = setup('deadline', { goalAgo: 90 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  const start = iso(Date.now() - 30 * MIN);
  fs.writeFileSync(t.retro('slot'), `state=running type=review start=${start} by=x spawned=${iso(Date.now() - 25 * MIN)}\n`);
  const r = spawnSync(process.execPath, [CLI, 'finish', start, '-', '--root', t.proj], { env: t.env, input: '结论：保持', encoding: 'utf8' });
  assert.equal(r.status, 2); assert.equal(t.slot().state, 'aborted');
  assert.ok(!fs.existsSync(t.retro('route-review.md')));
  fs.writeFileSync(t.retro('slot'), `state=running type=review start=${start} by=x\n`);
  fs.writeFileSync(t.retro('slot.lock'), '');
  assert.equal(t.cli('spawned', start).status, 3);
});

await test('extending the goal text keeps the same goal (no note, same start, no new scout)', () => {
  const t = setup('extend', { goalAgo: 30, cond: 'reach 5 wins.' });
  t.hook(); t.cli('spawned', t.slot().start);
  const goalFile = path.join(t.tmp, `claude-retro-${t.sid}.goal`);
  const start1 = JSON.parse(fs.readFileSync(goalFile, 'utf8')).start;
  t.addTranscript(goalLine('reach 5 wins. Then do the items too.', Date.now()));
  assert.doesNotMatch(t.text(t.hook()), /原目标|登记/);
  assert.equal(JSON.parse(fs.readFileSync(goalFile, 'utf8')).start, start1);
});

await test('"/goal resume" in a fresh session finds the original goal from another session or PROGRESS.md', () => {
  const t = setup('resume2', { goalAgo: 1, cond: 'resume' });
  fs.mkdirSync(t.retro('sessions'), { recursive: true });
  fs.writeFileSync(t.retro('sessions/old.json'), JSON.stringify({ session_id: 'old', transcript_path: t.transcript, goal: 'beat mom 5 times' }));
  assert.match(t.text(t.hook()), /原目标是「beat mom 5 times」/);
  const u = setup('resume3', { goalAgo: 1, cond: 'resume' });
  fs.writeFileSync(path.join(u.proj, 'PROGRESS.md'), '# PROGRESS\n目标（同 /goal）：win 3 games · 怎么证明：log\n');
  assert.match(u.text(u.hook()), /原目标是「win 3 games」/);
});

await test('a reservation left over from an earlier goal is voided and the new goal gets its scout', () => {
  const t = setup('stale', { goalAgo: 2 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  fs.writeFileSync(t.retro('slot'), `state=running type=review start=${iso(Date.now() - 10 * MIN)} by=${t.sid}\n`);
  assert.match(t.text(t.hook()), /已为你登记一次后台侦察/);
  assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /slot-stale/);
});

await test('an existing .retro/ without .gitignore gets one for generated files only', () => {
  const t = setup('oldretro');
  fs.mkdirSync(t.retro('checkpoints'), { recursive: true });
  t.hook();
  const gi = fs.readFileSync(t.retro('.gitignore'), 'utf8');
  assert.match(gi, /^slot$/m); assert.match(gi, /^sessions\/$/m); assert.match(gi, /^backlog\.md$/m); assert.doesNotMatch(gi, /^\*$/m);
  assert.match(gi, /^PROGRESS\.md$/m);
});

await test('a generated-files .gitignore picks up new names; a project-owned one is left alone', () => {
  const t = setup('oldignore');
  fs.mkdirSync(t.retro(''), { recursive: true });
  fs.writeFileSync(t.retro('.gitignore'), 'slot\nideas.md\n');
  t.hook();
  const gi = fs.readFileSync(t.retro('.gitignore'), 'utf8');
  assert.ok(gi.startsWith('slot\nideas.md\n')); assert.match(gi, /^backlog\.md$/m); assert.equal(gi.match(/^slot$/gm).length, 1);
  assert.match(gi, /^PROGRESS\.md$/m);
  fs.writeFileSync(t.retro('.gitignore'), 'slot\nmy-notes/\n');
  t.hook();
  assert.equal(fs.readFileSync(t.retro('.gitignore'), 'utf8'), 'slot\nmy-notes/\n');
});

await test('local records: init excludes process records in the checkout and its worktrees', () => {
  const t = setup('local-records');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  git(t.proj, 'init', '-q');
  fs.writeFileSync(path.join(t.proj, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(t.proj, 'README.md'), 'deliverable\n');
  fs.writeFileSync(path.join(t.proj, 'AGENTS.md'), 'project rules\n');
  const exclude = path.join(t.proj, '.git/info/exclude'), before = fs.readFileSync(exclude, 'utf8');
  assert.equal(t.cli('init').status, 0);
  const configured = fs.readFileSync(exclude, 'utf8');
  assert.ok(configured.startsWith(before));
  assert.equal(t.cli('init').status, 0);
  assert.equal(fs.readFileSync(exclude, 'utf8'), configured, 'init is not idempotent');
  assert.equal(fs.readFileSync(path.join(t.proj, '.gitignore'), 'utf8'), 'node_modules/\n');
  const records = ['PROGRESS.md', 'RUNBOOK.md', 'runbook/trace.md', 'results.tsv', '.retro/tasks/a/report.md', '.retro/PROGRESS.md', '.retro/RUNBOOK.md'];
  const writeRecords = cwd => { for (const f of records) { const p = path.join(cwd, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'local evidence\n'); } };
  writeRecords(t.proj);
  git(t.proj, 'add', '-A');
  const tracked = git(t.proj, 'ls-files', '-z').split('\0');
  for (const f of records) assert.ok(!tracked.includes(f), `${f} entered the index`);
  assert.ok(tracked.includes('README.md') && tracked.includes('AGENTS.md'));
  git(t.proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const wt = path.join(TMP, 'local-records-worktree');
  git(t.proj, 'worktree', 'add', '-q', '--detach', wt);
  writeRecords(wt);
  git(wt, 'add', '-A');
  assert.equal(git(wt, 'diff', '--cached', '--name-only'), '', 'a worktree staged process records');
  assert.equal(spawnSync(process.execPath, [CLI, 'init', '--root', wt], { env: t.env, encoding: 'utf8' }).status, 0);
  assert.equal(fs.readFileSync(exclude, 'utf8'), configured);
});

await test('local records: init scopes escaped paths to a project subdirectory', () => {
  const t = setup('nested-records');
  assert.equal(spawnSync('git', ['init', '-q', t.proj]).status, 0);
  const sub = path.join(t.proj, 'module[one]');
  fs.mkdirSync(sub);
  const r = spawnSync(process.execPath, [CLI, 'init', '--root', sub], { env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const p of [t.proj, sub]) fs.writeFileSync(path.join(p, 'PROGRESS.md'), 'notes');
  assert.equal(spawnSync('git', ['-C', t.proj, 'check-ignore', '-q', 'module[one]/PROGRESS.md']).status, 0);
  assert.equal(spawnSync('git', ['-C', t.proj, 'check-ignore', '-q', 'PROGRESS.md']).status, 1, 'another project was hidden');
});

await test('local records: tracked files and conflicting repository rules are reported without changing them', () => {
  const t = setup('tracked-records');
  assert.equal(spawnSync('git', ['init', '-q', t.proj]).status, 0);
  const progress = path.join(t.proj, 'PROGRESS.md');
  fs.writeFileSync(progress, 'previously tracked notes\n');
  assert.equal(spawnSync('git', ['-C', t.proj, 'add', 'PROGRESS.md']).status, 0);
  const r = t.cli('init');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /已跟踪[\s\S]*PROGRESS\.md/);
  assert.equal(fs.readFileSync(progress, 'utf8'), 'previously tracked notes\n');
  assert.equal(spawnSync('git', ['-C', t.proj, 'ls-files', '--error-unmatch', 'PROGRESS.md']).status, 0);
  fs.writeFileSync(path.join(t.proj, '.gitignore'), '!/PROGRESS.md\n');
  const blocked = t.cli('init');
  assert.notEqual(blocked.status, 0, 'a repository rule overrode the local exclusion silently');
  assert.match(blocked.stdout, /PROGRESS\.md/);
  assert.equal(fs.readFileSync(path.join(t.proj, '.gitignore'), 'utf8'), '!/PROGRESS.md\n');
});

await test('inbox --since-last review|scout: a background agent sees everything since its previous round', () => {
  const t = setup('inboxsince', { goalAgo: 120 });
  t.hook();
  const rep = (name, mins) => {
    fs.mkdirSync(t.retro(`tasks/${name}`), { recursive: true });
    fs.writeFileSync(t.retro(`tasks/${name}/report.md`), `结果：${name}`);
    t.setTime(t.retro(`tasks/${name}/report.md`), mins);
  };
  // minutes ago: old task 90; previous review started 70, handed in 60; a task during it 65; scout started 58, handed in 45; mid 50
  rep('old', 90); rep('during', 65); rep('mid', 50);
  const goalStart = JSON.parse(fs.readFileSync(t.state('goal'), 'utf8')).start;
  for (const [type, mins, delivered] of [['review', 70, 60], ['scout', 58, 45]]) {
    const start = iso(Date.now() - mins * MIN);
    fs.writeFileSync(t.retro('slot'), `state=running type=${type} start=${start} by=${t.sid} goalStart=${goalStart} spawned=${iso(Date.now())}\n`);
    const r = spawnSync(process.execPath, [CLI, 'finish', start, '-', '--root', t.proj], { env: t.env, input: `结果：${type}-previous`, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout);
    const file = type === 'review' ? 'route-review.md' : `tasks/${fs.readdirSync(t.retro('tasks')).find(n => n.startsWith('scout-'))}/report.md`;
    t.setTime(t.retro(file), delivered);
  }
  t.cli('inbox'); t.cli('done'); // a checkpoint just now leaves the plain inbox empty
  assert.doesNotMatch(t.cli('inbox').stdout, /结果：mid/);
  const r = t.cli('inbox', '--since-last', 'review').stdout;
  assert.match(r, /上次路线评审以来/);
  for (const name of ['during', 'mid', 'scout-']) assert.match(r, new RegExp('结果：' + name));
  assert.doesNotMatch(r, /结果：old/);
  const s = t.cli('inbox', '--since-last', 'scout').stdout;
  assert.match(s, /结果：mid/); assert.doesNotMatch(s, /结果：during/); assert.doesNotMatch(s, /结果：old/);
  assert.notEqual(t.cli('inbox', '--since-last', 'x').status, 0);
  // no review yet: from the goal start
  const u = setup('inboxsince0', { goalAgo: 30 });
  u.hook();
  fs.mkdirSync(u.retro('tasks/a'), { recursive: true }); fs.writeFileSync(u.retro('tasks/a/report.md'), '结果：a');
  assert.match(u.cli('inbox', '--since-last', 'review').stdout, /结果：a/);
});

await test('a report landing between the checkpoint\'s inbox and done counts next time', () => {
  const t = setup('gap', { goalAgo: 61 });
  t.fresh(); t.hook();
  t.cli('inbox');
  const goalStart = JSON.parse(fs.readFileSync(t.state('goal'), 'utf8')).start;
  fs.writeFileSync(t.retro(`checkpoints/${t.sid}/${goalStart}/inbox-at`), iso(Date.now() - 5 * MIN) + '\n'); // inbox ran 5 min ago
  fs.mkdirSync(t.retro('tasks/late'), { recursive: true }); fs.writeFileSync(t.retro('tasks/late/report.md'), '结果：late');
  t.setTime(t.retro('tasks/late/report.md'), 2);
  t.cli('done');
  assert.match(t.cli('inbox').stdout, /结果：late/);
});

await test('a subagent handing back counts as something new for the checkpoint', () => {
  const t = setup('subdone', { goalAgo: 61 });
  assert.doesNotMatch(t.text(t.hook()), /检查点到期/);
  t.sub('a1'); t.hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose' });
  assert.match(t.text(t.hook()), /检查点到期/);
});

await test('done logs the spot check and a snapshot of the pool, dead ends and backlog', () => {
  const t = setup('snapshot', { goalAgo: 61 });
  t.hook();
  fs.writeFileSync(t.retro('ideas.md'), '## 想法\n- [ ] a\n## 死路\n- b — 原因 — 重试条件\n- c — 原因 — 重试条件 可疑\n');
  fs.writeFileSync(t.retro('backlog.md'), '- x — 来源 — 低 — 改一行\n');
  t.cli('done', '抽查 t1：不一致：数字对不上');
  const log = fs.readFileSync(t.retro('log.tsv'), 'utf8');
  assert.match(log, /checkpoint-done\t抽查 t1：不一致：数字对不上/);
  assert.match(log, /snapshot\t想法 1 死路 2 可疑 1 积压 1/);
});

await test('executor segments are logged when they start and stop', () => {
  const t = setup('agentlog', { goalAgo: 5 });
  t.hook();
  t.sub('a1'); t.sub('a1');
  t.hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose' });
  const log = fs.readFileSync(t.retro('log.tsv'), 'utf8');
  assert.equal(log.match(/agent-start\ta1 general-purpose/g).length, 1);
  assert.match(log, /agent-stop\ta1/);
});

await test('metrics: checkpoints, background reviews, executor segments, slot use, reports', () => {
  const t = setup('metrics', { goalAgo: 120 });
  t.hook();
  const at = mins => iso(Date.now() - mins * MIN);
  const row = (mins, ev, d = '') => fs.appendFileSync(t.retro('log.tsv'), `${at(mins)}\t-\t${ev}\t${d}\n`);
  const start = at(90);
  row(100, 'slots', '2 两个实例');
  row(100, 'agent-start', 'a1 general-purpose'); row(100, 'agent-start', 'a2 general-purpose');
  row(90, 'slot-reserved', `review ${start}`); row(85, 'spawned', start); row(75, 'finished', start);
  row(70, 'agent-stop', 'a2');
  row(60, 'checkpoint-due', '61min'); row(50, 'checkpoint-done', '抽查 a1：一致');
  row(40, 'agent-stop', 'a1');
  fs.mkdirSync(t.retro('reviews'), { recursive: true });
  fs.writeFileSync(t.retro('reviews/r1.md'), `<!-- route-review start=${start} end=x -->\n结论：保持\n判断依据：无\n上轮建议：未记录\n`);
  for (const [name, body] of [['v', '结果：核实：一致'], ['p', '结果：做了 X\n观察：推翻前提：Y 不成立']]) {
    fs.mkdirSync(t.retro(`tasks/${name}`), { recursive: true }); fs.writeFileSync(t.retro(`tasks/${name}/report.md`), body);
  }
  const out = t.cli('metrics').stdout;
  assert.match(out, /完成 1 次；从提醒到完成 平均 10 分钟/);
  assert.match(out, /抽查 1 次，不一致 0 次/);
  assert.match(out, /从登记到启动 平均 5 分钟/);
  assert.match(out, /结论：保持 1/); assert.match(out, /上轮建议：未记录 1/); assert.match(out, /判断依据有意见的 0 份/);
  assert.match(out, /2 段，2 个子代理/);
  assert.match(out, /名额利用率.*：45%/);
  assert.match(out, /标“推翻前提”的 1 份；核实：一致 1，不一致 0/);
});

await test('segment logging: parallel first calls log one start; follow-ups log again; a subfolder cwd logs to the main project', async () => {
  const t = setup('agentrace', { goalAgo: 5 });
  t.hook();
  await Promise.all([1, 2, 3, 4].map(() => t.hookAsync({ agent_id: 'p1', agent_type: 'general-purpose' })));
  const stopP1 = () => t.hook({ hook_event_name: 'SubagentStop', agent_id: 'p1', agent_type: 'general-purpose' });
  stopP1(); t.sub('p1'); stopP1();
  const sub = path.join(t.proj, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  t.hook({ agent_id: 'c1', agent_type: 'worker', cwd: sub }, { CLAUDE_PROJECT_DIR: '' });
  const log = fs.readFileSync(t.retro('log.tsv'), 'utf8');
  assert.equal(log.match(/agent-start\tp1 /g).length, 2);
  assert.equal(log.match(/agent-stop\tp1/g).length, 2);
  assert.match(log, /agent-start\tc1 worker/);
  assert.ok(!fs.existsSync(path.join(sub, '.retro')));
});

await test('metrics after the run: the window ends at the last event; labels in bold or bullets still count', () => {
  const t = setup('metricsdone', { goalAgo: null });
  const at = mins => iso(Date.now() - mins * MIN);
  fs.mkdirSync(t.retro('sessions'), { recursive: true });
  fs.writeFileSync(t.retro('sessions/old.json'), JSON.stringify({ session_id: 'old', transcript_path: path.join(t.proj, 'none.jsonl'), goal: 'g', goal_start: at(600) }));
  const row = (mins, ev, d = '') => fs.appendFileSync(t.retro('log.tsv'), `${at(mins)}\t-\t${ev}\t${d}\n`);
  row(600, 'slots', '2 x'); row(600, 'agent-start', 'a1 w'); row(600, 'agent-start', 'a2 w');
  row(480, 'agent-stop', 'a1'); row(480, 'agent-stop', 'a2');
  row(520, 'checkpoint-due', '61min'); row(515, 'checkpoint-done', '抽查 a1：一致，没有发现不一致');
  fs.mkdirSync(t.retro('reviews'), { recursive: true });
  fs.writeFileSync(t.retro('reviews/r.md'), `<!-- route-review start=${at(500)} end=x -->\n**结论**：换路线\n**判断依据**：（无）\n上轮建议: 部分采纳\n`);
  for (const [name, body] of [['b', '观察：\n- 推翻前提：A 不成立'], ['c', '观察：推翻前提的可能性不大'], ['d', '**核实**：不一致']]) {
    fs.mkdirSync(t.retro(`tasks/${name}`), { recursive: true }); fs.writeFileSync(t.retro(`tasks/${name}/report.md`), body);
  }
  const out = t.cli('metrics').stdout;
  assert.match(out, /名额利用率.*：100%/);
  assert.doesNotMatch(out, /目标还在进行/);
  assert.match(out, /抽查 1 次，不一致 0 次/);
  assert.match(out, /结论：换路线 1/); assert.match(out, /上轮建议：部分采纳 1/); assert.match(out, /判断依据有意见的 0 份/);
  assert.match(out, /标“推翻前提”的 1 份；核实：一致 0，不一致 1/);
});

// Codex executors for a Claude main agent: codex-worker.mjs drives a fake codex (test/fake-codex.mjs).
const WORKER = path.join(here, '..', 'skills', 'retro', 'scripts', 'codex-worker.mjs');
function codex(t, extra = {}) {
  const logFile = path.join(t.tmp, 'fake-codex.log');
  const env = { ...t.env, RETRO_CODEX: JSON.stringify([process.execPath, path.join(here, 'fake-codex.mjs')]), FAKE_CODEX_LOG: logFile, ...extra };
  const run = (...a) => spawnSync(process.execPath, [WORKER, ...a, '--root', t.proj], { env, encoding: 'utf8' });
  const start = (...a) => {
    const p = spawn(process.execPath, [WORKER, ...a, '--root', t.proj], { env });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.done = new Promise(res => p.on('close', code => res({ code, out })));
    return p;
  };
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const brief = (task, text) => { fs.mkdirSync(t.retro(`tasks/${task}`), { recursive: true }); fs.writeFileSync(t.retro(`tasks/${task}/brief.md`), text); };
  const worker = id => JSON.parse(fs.readFileSync(t.retro(`workers/${id}.json`), 'utf8'));
  return { env, run, start, calls, brief, worker, pidFile: logFile + '.pid' };
}
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

await test('codex command: RETRO_CODEX wins; else on Windows the desktop app\'s newest copy that has its host, with its flags; else codex', () => {
  const la = path.join(TMP, 'localappdata'), bin = path.join(la, 'OpenAI', 'Codex', 'bin');
  const copy = (h, host, mins) => {
    const d = path.join(bin, h);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'codex.exe'), '');
    if (host) fs.writeFileSync(path.join(d, 'codex-code-mode-host.exe'), '');
    const t = (Date.now() - mins * MIN) / 1000; fs.utimesSync(path.join(d, 'codex.exe'), t, t);
  };
  copy('old', true, 60); copy('new', true, 5); copy('nohost', false, 0); fs.mkdirSync(path.join(bin, 'rgonly'));
  const lib = pathToFileURL(path.join(here, '..', 'skills', 'retro', 'scripts', 'lib.mjs')).href;
  const cmd = (env, platform) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { codexCommand } from ${JSON.stringify(lib)}; console.log(JSON.stringify(codexCommand(${JSON.stringify(env)}, ${JSON.stringify(platform)})))`], { encoding: 'utf8' });
    return JSON.parse(r.stdout || 'null');
  };
  assert.deepEqual(cmd({ LOCALAPPDATA: la }, 'win32'), [path.join(bin, 'new', 'codex.exe'), '-c', 'features.code_mode_host=true', '-c', 'features.prefer_mxc=true']);
  assert.deepEqual(cmd({ LOCALAPPDATA: la, RETRO_CODEX: 'C:/x/codex.exe' }, 'win32'), ['C:/x/codex.exe']);
  assert.deepEqual(cmd({ LOCALAPPDATA: la, RETRO_CODEX: '["a", "-c", "b"]' }, 'win32'), ['a', '-c', 'b']);
  assert.deepEqual(cmd({ LOCALAPPDATA: la }, 'linux'), ['codex']);
  assert.deepEqual(cmd({ LOCALAPPDATA: path.join(TMP, 'no-app') }, 'win32'), ['codex']);
});

await test('codex-worker run: brief and settings passed, final message and report printed, segment logged; resume continues the thread', () => {
  const t = setup('cw-run', { goalAgo: 30 });
  t.hook();
  const c = codex(t);
  const report = t.retro('tasks/t1/report.md');
  c.brief('t1', `# 试一下 expectimax\nREPORT:${report}\n`);
  const r = c.run('run', 't1');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Codex 执行者 t1：这一轮结束。线程 thread-\d+/);
  assert.match(r.stdout, /回报：.*report\.md/);
  assert.match(r.stdout, /最后的话：\n答复：# 试一下 expectimax/);
  const [call] = c.calls();
  assert.equal(call.prompt, `# 试一下 expectimax\nREPORT:${report}\n`);
  for (const a of ['approval_policy="never"', 'sandbox_mode="workspace-write"', 'sandbox_workspace_write.network_access=true', 'exec', '--json', '-C', t.proj]) assert.ok(call.argv.includes(a), a);
  assert.ok(!call.argv.some(a => a.includes('writable_roots')), 'working in the project needs no extra writable root');
  const w = c.worker('t1');
  assert.equal(w.desc, '试一下 expectimax'); assert.equal(w.type, 'codex'); assert.ok(w.stopAt > 0); assert.match(w.thread, /^thread-/);
  const r2 = c.run('resume', 't1', '为什么', '这么慢？');
  assert.equal(r2.status, 0, r2.stdout);
  const call2 = c.calls()[1];
  assert.deepEqual(call2.argv.slice(-2), [w.thread, '-']); assert.ok(call2.argv.includes('resume'));
  assert.equal(call2.prompt, '为什么 这么慢？');
  assert.match(r2.stdout, /这一轮没有写 report\.md/);
  assert.equal(c.worker('t1').desc, '试一下 expectimax');
  const log = fs.readFileSync(t.retro('log.tsv'), 'utf8');
  assert.equal(log.match(/agent-start\tt1 codex/g).length, 2);
  assert.equal(log.match(/agent-stop\tt1/g).length, 2);
  // Working in a worktree: the project's .retro/ stays writable.
  const wt = path.join(t.tmp, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  c.brief('t2', 'x');
  assert.equal(c.run('run', 't2', '--cd', wt).status, 0);
  const call3 = c.calls()[2];
  assert.equal(path.resolve(call3.cwd), path.resolve(wt));
  assert.ok(call3.argv.some(a => a.startsWith('sandbox_workspace_write.writable_roots=[') && a.includes('/.retro')), call3.argv.join(' '));
  assert.equal(c.run('resume', 't2', 'y').status, 0);
  assert.equal(path.resolve(c.calls()[3].cwd), path.resolve(wt), 'resume works where the run did');
  // Its record pruned after a day: resume finds the thread and directory in the task's event log.
  const th = c.worker('t2').thread;
  fs.unlinkSync(t.retro('workers/t2.json'));
  assert.equal(c.run('resume', 't2', 'z').status, 0);
  const call5 = c.calls()[4];
  assert.equal(path.resolve(call5.cwd), path.resolve(wt)); assert.equal(call5.argv.at(-2), th);
  // A directory inside the project that doesn't hold .retro/ (a worktree under the repo) gets it as a writable root too;
  // sandbox settings in RETRO_CODEX are left alone.
  const sub = path.join(t.proj, 'w');
  fs.mkdirSync(sub, { recursive: true });
  c.brief('t3', 'x');
  assert.equal(c.run('run', 't3', '--cd', sub).status, 0);
  assert.ok(c.calls()[5].argv.some(a => a.startsWith('sandbox_workspace_write.writable_roots=')));
  const own = JSON.stringify([process.execPath, path.join(here, 'fake-codex.mjs'), '-c', 'sandbox_mode="danger-full-access"', '-c', 'sandbox_workspace_write.network_access=false']);
  assert.equal(spawnSync(process.execPath, [WORKER, 'run', 't3', '--root', t.proj], { env: { ...c.env, RETRO_CODEX: own }, encoding: 'utf8' }).status, 0);
  assert.deepEqual(c.calls()[6].argv.filter(a => a.startsWith('sandbox_mode=')), ['sandbox_mode="danger-full-access"']);
  assert.deepEqual(c.calls()[6].argv.filter(a => a.startsWith('sandbox_workspace_write.network_access=')), ['sandbox_workspace_write.network_access=false']);
  // Inside a git repository (from a subfolder too), its git directory is writable, so it can commit; resume too.
  const gp = path.join(t.tmp, 'gp');
  fs.mkdirSync(path.join(gp, 'src'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: gp });
  c.brief('t4', 'x');
  assert.equal(c.run('run', 't4', '--cd', path.join(gp, 'src')).status, 0);
  const roots = () => c.calls().at(-1).argv.find(a => a.startsWith('sandbox_workspace_write.writable_roots=')) || '';
  assert.ok(roots().includes(`${gp.replace(/\\/g, '/')}/.git"`) && roots().includes('/.retro"'), roots());
  assert.equal(c.run('resume', 't4', 'y').status, 0);
  assert.ok(roots().includes('/.git"'));
  assert.equal(c.run('run', 't3', '--cd', wt).status, 0);
  assert.ok(roots().includes('/.retro"') && !roots().includes('/.git"'), 'outside a repository there is no git directory to add');
  // A stop request left over from an earlier segment doesn't stop a new one.
  fs.writeFileSync(t.retro('workers/t1.stop'), '12345');
  assert.match(c.run('run', 't1').stdout, /t1：这一轮结束/);
  assert.ok(!fs.existsSync(t.retro('workers/t1.stop')));
  // A new run that fails before its thread starts doesn't keep the old thread or the old last words.
  c.brief('t1', 'NOTHREAD');
  assert.equal(c.run('run', 't1').status, 1);
  assert.equal(c.worker('t1').thread, null); assert.equal(c.worker('t1').said, '');
  assert.match(c.run('resume', 't1', 'x').stdout, /没有可以接着的线程/);
});

await test('codex-worker: a process codex leaves behind holding its output does not hold up the hand-back', () => {
  const t = setup('cw-linger', { goalAgo: 30 });
  t.hook();
  const c = codex(t);
  c.brief('lin', 'LINGER');
  const t0 = Date.now();
  const r = c.run('run', 'lin');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /lin：这一轮结束/);
  assert.ok(Date.now() - t0 < 10e3, `took ${Date.now() - t0} ms`);
});

await test('codex-worker stop: the process tree goes, the run exits 1 with a resume hint; while it runs the hook counts it and a second run is refused', async () => {
  const t = setup('cw-stop', { goalAgo: 30 });
  t.hook(); t.cli('spawned', t.slot().start);
  fs.writeFileSync(t.retro('slots'), JSON.stringify({ n: 1, at: iso(Date.now() - 6 * MIN), why: 'x' }));
  const c = codex(t);
  c.brief('long', 'SLEEP');
  const p = c.start('run', 'long');
  await until(() => fs.existsSync(c.pidFile) && fs.existsSync(t.retro('workers/long.json')) && c.worker('long').cmd);
  const grandchild = Number(fs.readFileSync(c.pidFile, 'utf8'));
  assert.doesNotMatch(t.text(t.hook()), /名额空着/);
  // Two commands ran at once and one finished: the other is still running.
  assert.match(t.cli('status').stdout, /在跑 1 个）：SLEEP［codex long］（在跑，这一段 0 分钟，正在跑命令「python eval\.py」/);
  const again = c.run('run', 'long');
  assert.equal(again.status, 1); assert.match(again.stdout, /long 还在跑/);
  assert.match(c.run('stop', 'long').stdout, /已停止 long。在后台跑它的 run\/resume 会交出输出/);
  const { code, out } = await p.done;
  assert.equal(code, 1);
  assert.match(out, /Codex 执行者 long：已被停止/);
  assert.match(out, /可在后台运行 node ".*codex-worker\.mjs" resume long "整理现有结果，交阶段回报，不继续执行/);
  await until(() => !isAlive(grandchild), 5000);
  assert.ok(c.worker('long').stopAt > 0);
  assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /agent-stop\tlong/);
  assert.match(c.run('stop', 'long').stdout, /long 没有在跑/);
  assert.ok(!fs.existsSync(t.retro('workers/long.stop')));
  fs.writeFileSync(t.retro('workers/long.json'), JSON.stringify({ ...c.worker('long'), stopAt: Date.now() - 6 * MIN }));
  t.age(11);
  assert.match(t.text(t.hook()), /名额是 1 个，现在在跑的执行子代理只有 0 个/);
  // The driver died. On Windows its codex died with it, so stop kills nothing; elsewhere stop ends the codex process
  // group this segment started, but never a process that merely got its pid.
  const win = process.platform === 'win32';
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: !win });
  const other = win ? spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' }) : spawn('sleep', ['60'], { stdio: 'ignore' });
  for (const [id, child] of [['orphan', orphan.pid], ['other', other.pid]]) fs.writeFileSync(t.retro(`workers/${id}.json`), JSON.stringify({ type: 'codex', driver: 'codex-worker', seg: Date.now(), stopAt: 0, pid: dead, child }));
  const o = c.run('stop', 'orphan').stdout;
  if (win) {
    assert.match(o, /已停止 orphan：驱动已经不在了，Codex 进程随它一起结束/);
    assert.ok(isAlive(orphan.pid)); orphan.kill();
  } else {
    assert.match(o, /已停止 orphan：驱动已经不在了，直接结束了 Codex 进程组/);
    await until(() => !isAlive(orphan.pid), 5000);
  }
  assert.match(c.run('stop', 'other').stdout, win ? /已停止 other：驱动已经不在了/ : /Codex 进程也已经不在了/);
  assert.ok(isAlive(other.pid), 'a process that is not codex was killed');
  other.kill();
  assert.ok(c.worker('other').stopAt > 0);
});

await test('codex-worker: a timeout stops the turn; a failed turn and a missing codex exit 1 with the reason; an empty brief registers nothing', async () => {
  const t = setup('cw-fail', { goalAgo: 30 });
  t.hook();
  const c = codex(t);
  c.brief('slow', 'SLEEP');
  const r = c.run('run', 'slow', '--timeout', '0.02');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /slow：超过 0 分钟，已停止/);
  await until(() => !isAlive(Number(fs.readFileSync(c.pidFile, 'utf8'))), 5000);
  c.brief('bad', 'FAIL');
  const f = c.run('run', 'bad');
  assert.equal(f.status, 1); assert.match(f.stdout, /异常结束（退出码 1）/); assert.match(f.stdout, /错误：boom/);
  const missing = spawnSync(process.execPath, [WORKER, 'run', 'bad', '--root', t.proj], { env: { ...c.env, RETRO_CODEX: path.join(t.tmp, 'no-codex.exe') }, encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stdout, /没能启动 codex（ENOENT）/);
  assert.ok(c.worker('bad').stopAt > 0, 'a codex that never started is not left running');
  const empty = c.run('run', 'none');
  assert.equal(empty.status, 1); assert.match(empty.stdout, /任务说明是空的/);
  assert.ok(!fs.existsSync(t.retro('workers/none.json')));
  assert.match(c.run('resume', 'none', 'x').stdout, /没有可以接着的线程/);
  assert.match(c.run('run', '../x').stdout, /任务名只用字母/);
  if (process.platform === 'win32') { // a .cmd can't be spawned directly
    fs.writeFileSync(path.join(t.tmp, 'codex.cmd'), '@echo off\n');
    c.brief('cmdx', 'x');
    const r2 = spawnSync(process.execPath, [WORKER, 'run', 'cmdx', '--root', t.proj], { env: { ...c.env, RETRO_CODEX: path.join(t.tmp, 'codex.cmd') }, encoding: 'utf8' });
    assert.equal(r2.status, 1); assert.match(r2.stdout, /没能启动 codex（EINVAL）.*不能是 \.cmd/);
    assert.ok(!fs.existsSync(t.retro('workers/cmdx.json')));
  }
});

await test('workers in the hook: heartbeat is distinct from activity; old drivers remain readable; silence and overtime do not stop workers', () => {
  const t = setup('cw-hook', { goalAgo: 90 });
  t.hook(); t.cli('spawned', t.slot().start); t.cli('slots', '4', 'x'); t.cli('done');
  for (const id of ['long', 'quiet', 'busy', 'other']) assert.equal(t.cli('worker', 'start', id, `任务 ${id}`, '--pid', String(process.pid), '--type', 'codex').status, 0);
  const file = id => t.retro(`workers/${id}.json`);
  const patch = (id, kv) => fs.writeFileSync(file(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(file(id), 'utf8')), ...kv }));
  for (const id of ['long', 'quiet']) patch(id, { driver: 'codex-worker' });
  patch('quiet', { activityAt: Date.now() - 25 * MIN }); // fresh heartbeat, no model activity
  patch('long', { seg: Date.now() - 61 * MIN });
  patch('busy', { cmd: 'python eval.py', cmdAt: Date.now() - 10 * MIN });
  // Silence alone never ends a worker with a live driver: all four still run.
  t.setTime(file('busy'), 10); t.setTime(file('other'), 25);
  fs.writeFileSync(file('torn'), ''); // caught mid-write: ignored
  fs.writeFileSync(t.retro('slots'), JSON.stringify({ n: 4, at: iso(Date.now() - 6 * MIN), why: 'x' }));
  const r = t.text(t.hook());
  assert.doesNotMatch(r, /torn/);
  assert.doesNotMatch(t.cli('status').stdout, /torn/);
  assert.match(r, /Codex 执行者「任务 long」（任务 long）这一段已经连续跑了 61 分钟/);
  assert.match(r, /codex-worker\.mjs" stop long --root[\s\S]*codex-worker\.mjs" resume long "整理现有进度/);
  assert.match(r, /Codex 执行者「任务 quiet」（任务 quiet）已经 25 分钟没有任何动静/);
  assert.match(r, /codex-worker\.mjs" stop quiet --root/);
  assert.match(r, /Codex 执行者「任务 other」（任务 other）已经 25 分钟没有任何动静，也不在等工具/);
  assert.doesNotMatch(r, /任务 busy/);
  assert.doesNotMatch(t.text(t.hook()), /Codex 执行者/);
  assert.doesNotMatch(r, /名额空着/);
  // In a command past 15 min: stuck.
  patch('busy', { cmdAt: Date.now() - 16 * MIN }); t.setTime(file('busy'), 16);
  assert.match(t.text(t.hook()), /Codex 执行者「任务 busy」（任务 busy）在等的工具调用 python eval\.py 已经 16 分钟没有返回/);
  // A driver that died without saying so: not running, and its slot is free.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  for (const id of ['long', 'quiet', 'busy', 'other']) { patch(id, { pid: dead }); t.setTime(file(id), 6); }
  fs.writeFileSync(t.retro('slots'), JSON.stringify({ n: 4, at: iso(Date.now() - 6 * MIN), why: 'x' }));
  t.age(11);
  assert.match(t.text(t.hook()), /名额是 4 个，现在在跑的执行子代理只有 0 个/);
  assert.match(t.cli('status').stdout, /任务 long［codex long］（驱动已经不在了/);
});

await test('codex-worker silence: quiet across two observation windows stays alive, reports activity separately, and stops only on request', async () => {
  const t = setup('cw-quiet', { goalAgo: 30 });
  t.hook();
  const c = codex(t, { RETRO_TIME_SCALE: '0.01' }); // 5 min = 3 s
  c.brief('q1', '# 想一想\nQUIET\n');
  const p = c.start('run', 'q1');
  try {
    await until(() => c.worker('q1').thread && c.worker('q1').rollout);
    const first = c.worker('q1');
    await new Promise(res => setTimeout(res, 6500));
    assert.equal(p.exitCode, null);
    assert.equal(c.calls().length, 1, 'silence started an unsolicited resume');
    assert.equal(c.worker('q1').activityAt, first.activityAt);
    assert.ok(fs.statSync(t.retro('workers/q1.json')).mtimeMs > first.activityAt + 5000, 'no separate heartbeat');
    const note = t.text(t.hook({}, { RETRO_TIME_SCALE: '0.01' }));
    assert.match(note, /任务 q1）已经 \d+ 分钟没有任何动静/);
    assert.doesNotMatch(t.text(t.hook({}, { RETRO_TIME_SCALE: '0.01' })), /任务 q1/);
    assert.equal(c.worker('q1').stopAt, 0);
    assert.equal(c.run('stop', 'q1').status, 0);
    assert.equal((await p.done).code, 1);
    assert.equal(c.worker('q1').why, 'stopped');
    assert.doesNotMatch(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /\tagent-asked\t/);
  } finally {
    if (p.exitCode === null) { c.run('stop', 'q1'); await p.done; }
  }
});

await test('codex-worker silence: a tool call out in the rollout, or steps written only there, are not silence until 15 min; without a rollout a running command counts as a call out', async () => {
  const t = setup('cw-busy', { goalAgo: 30 });
  t.hook();
  const c = codex(t, { RETRO_TIME_SCALE: '0.01' }); // 5 min = 3 s, 15 min = 9 s
  c.brief('p1', '# 等命令\nPOLL\n'); // a call out for 5 s
  const r1 = c.run('run', 'p1');
  assert.equal(r1.status, 0, r1.stdout);
  c.brief('b1', '# 一直在想\nBEAT\n'); // a step every second for 5 s, nothing on stdout
  const r2 = c.run('run', 'b1');
  assert.equal(r2.status, 0, r2.stdout);
  assert.doesNotMatch(r1.stdout + r2.stdout, /追问/);
  assert.equal(c.calls().length, 2);
  // A call out past 15 min: the hook reports it while the original turn keeps running.
  const c2 = codex(t, { RETRO_TIME_SCALE: '0.01', FAKE_POLL_MS: '12000' });
  c2.brief('p2', '# 等很久\nPOLL\n');
  const p2 = c2.start('run', 'p2');
  try {
    await until(() => c2.worker('p2').waiting?.name === 'exec');
    await new Promise(res => setTimeout(res, 9500));
    assert.equal(p2.exitCode, null);
    assert.match(t.text(t.hook({}, { RETRO_TIME_SCALE: '0.01' })), /任务 p2）在等的工具调用 exec 已经 \d+ 分钟没有返回/);
    const r3 = await p2.done;
    assert.equal(r3.code, 0, r3.out);
    assert.equal(c2.calls().length, 3);
    assert.equal(c2.worker('p2').why, null);
  } finally {
    if (p2.exitCode === null) { c2.run('stop', 'p2'); await p2.done; }
  }
  // No rollout (the fake keeps none without CODEX_HOME): a command running is a call out, so 5 s is not silence.
  const c3 = codex(t, { RETRO_TIME_SCALE: '0.01', CODEX_HOME: '' });
  c3.brief('s1', '# 跑评测\nSLEEP\n');
  const before = c3.calls().length;
  const p = c3.start('run', 's1');
  await new Promise(res => setTimeout(res, 5000));
  assert.equal(c3.calls().length, before + 1);
  c3.run('stop', 's1');
  assert.equal((await p.done).code, 1);
});

await test('a worker handing back counts for the checkpoint; metrics counts its segments; retro.mjs worker for other drivers', () => {
  const t = setup('cw-check', { goalAgo: 61 });
  t.hook();
  assert.equal(t.cli('worker', 'start', 'x1', '外部任务').status, 0);
  assert.equal(t.cli('worker', 'beat', 'x1').status, 0);
  assert.doesNotMatch(t.text(t.hook()), /检查点到期/);
  assert.match(t.cli('worker', 'stop', 'x1').stdout, /已记下 x1 停了/);
  assert.match(t.text(t.hook()), /检查点到期/);
  assert.equal(t.cli('worker', 'beat', 'x1').status, 1);
  assert.match(t.cli('worker', 'stop', 'x1').stdout, /没有登记或已经停了/);
  assert.equal(t.cli('worker', 'start', 'a b').status, 1);
  // Without a driver pid it counts as running until silent for an hour.
  t.cli('worker', 'start', 'x2');
  assert.match(t.cli('status').stdout, /在跑 1 个）：x2［external x2］/);
  t.setTime(t.retro('workers/x2.json'), 61);
  assert.match(t.cli('status').stdout, /在跑 0 个）/);
  assert.match(t.cli('metrics').stdout, /2 段，2 个子代理；交回的 1 段/);
});

await test('inbox starts from the goal start and caps its size', () => {
  const t = setup('inbox', { goalAgo: 10 });
  t.hook();
  const old = (Date.now() - 60 * MIN) / 1000;
  for (let i = 0; i < 30; i++) {
    fs.mkdirSync(t.retro(`tasks/t${i}`), { recursive: true });
    fs.writeFileSync(t.retro(`tasks/t${i}/report.md`), 'x'.repeat(1500));
    const at = i < 10 ? old : (Date.now() - (30 - i) * 1000) / 1000;
    fs.utimesSync(t.retro(`tasks/t${i}/report.md`), at, at);
  }
  const out = t.cli('inbox').stdout;
  assert.ok(!/任务 t[0-9]（/.test(out), 'reports from before the goal are listed');
  assert.ok(out.length < 20000); assert.match(out, /更早的 \d+ 份回报/);
  assert.ok(out.includes('任务 t29（') && !out.includes('任务 t10（'), 'the newest reports are the ones shown');
  assert.ok(out.indexOf('任务 t28（') < out.indexOf('任务 t29（'), 'printed oldest first');
});

await test('retro.mjs finds the main checkout from inside a worktree', () => {
  const repo = path.join(TMP, 'gitrepo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'PROGRESS.md'), 'x');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  const wt = path.join(repo, '.claude', 'worktrees', 'w1');
  git('worktree', 'add', '-q', wt);
  fs.mkdirSync(path.join(wt, 'sub'));
  const env = { ...process.env }; delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [CLI, 'root'], { cwd: path.join(wt, 'sub'), env, encoding: 'utf8' });
  assert.equal(path.resolve(r.stdout.trim()).toLowerCase(), path.join(repo, 'sub').toLowerCase());
  const r2 = spawnSync(process.execPath, [CLI, 'root', '--root', wt], { env, encoding: 'utf8' });
  assert.equal(path.resolve(r2.stdout.trim()).toLowerCase(), path.resolve(repo).toLowerCase());
  // The hook maps a session started in the worktree to the main checkout as well.
  const t = setup('wthook');
  const input = { session_id: 'wt', transcript_path: t.transcript, cwd: wt, hook_event_name: 'PostToolUse', tool_name: 'Bash' };
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...t.env, CLAUDE_PROJECT_DIR: wt }, encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(repo, '.retro', 'slot')) && !fs.existsSync(path.join(wt, '.retro')));
  fs.writeFileSync(path.join(repo, '.retro', 'PROGRESS.md'), 'shared current progress\n');
  const status = spawnSync(process.execPath, [CLI, 'status', '--root', wt], { env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /## \.retro[/\\]PROGRESS\.md[\s\S]*shared current progress/);
});

await test('install.mjs: BOM is fine, JSONC is refused untouched, CRLF agents convert', () => {
  const home = path.join(TMP, 'home'), repo = path.join(TMP, 'repocopy');
  const src = path.join(here, '..');
  fs.cpSync(src, repo, { recursive: true, filter: f => !/[\\/](\.git|test)([\\/]|$)/.test(path.relative(src, f) ? '/' + path.relative(src, f) : '') });
  for (const f of fs.readdirSync(path.join(repo, 'agents', 'claude'))) {
    const p = path.join(repo, 'agents', 'claude', f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.CODEX_HOME; delete env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS;
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '﻿{"model":"x","permissions":{"allow":["Bash"]}}');
  let r = spawnSync(process.execPath, [path.join(repo, 'install.mjs')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'x'); assert.ok(s.hooks.Stop && s.hooks.SubagentStop && s.hooks.PreToolUse && s.hooks.PostToolUse && s.hooks.PostToolUseFailure);
  assert.equal(s.hooks.SessionStart[0].matcher, 'compact');
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(codexHooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop']);
  assert.equal(codexHooks.SessionStart[0].matcher, 'compact');
  assert.match(fs.readFileSync(path.join(home, '.codex', 'agents', 'idea-scout.toml'), 'utf8'), /model_reasoning_effort = "xhigh"/);
  assert.doesNotMatch(r.stdout, /WARNING/);
  for (const base of ['.claude/skills', '.agents/skills']) {
    for (const name of ['execution', 'bottlenecks', 'review', 'state', 'platforms']) {
      assert.equal(fs.readFileSync(path.join(home, base, 'retro', 'references', name + '.md'), 'utf8'), fs.readFileSync(path.join(src, 'skills', 'retro', 'references', name + '.md'), 'utf8'));
    }
  }
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[agents]\nmax_concurrent_threads_per_session = 12\n');
  assert.doesNotMatch(spawnSync(process.execPath, [path.join(repo, 'install.mjs')], { env, encoding: 'utf8' }).stdout, /WARNING/);
  const jsonc = '{ // comment\n "model": "y", }';
  fs.writeFileSync(settings, jsonc);
  fs.rmSync(path.join(home, '.codex', 'agents'), { recursive: true });
  r = spawnSync(process.execPath, [path.join(repo, 'install.mjs')], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(fs.readFileSync(settings, 'utf8'), jsonc);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'agents', 'idea-scout.toml')), 'the Codex part still runs');
});

await test('only launching the exact agent counts: todo tools and prompts that mention it do not', () => {
  const t = setup('launchfp');
  t.hook();
  t.hook({ tool_name: 'TaskCreate', tool_input: { subject: '启动 idea-scout' } });
  t.hook({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: '修 agents/claude/idea-scout.md' } });
  assert.ok(!t.slot().spawned);
  t.hook({ tool_name: 'Task', tool_input: { subagent_type: 'idea-scout', prompt: 'x' } });
  assert.ok(t.slot().spawned);
});

await test('"/goal resume" after a temporary goal names the long goal (same session, then a new one)', () => {
  const t = setup('detour', { goalAgo: 30, cond: 'long goal' });
  t.hook();
  t.addTranscript(goalLine('save checkpoints, reply ready', Date.now() - 5 * MIN));
  t.hook();
  t.addTranscript({ type: 'attachment', timestamp: iso(Date.now() - 2 * MIN), attachment: { type: 'goal_status', met: true, condition: 'save checkpoints, reply ready' } });
  t.addTranscript(goalLine('resume', Date.now()));
  assert.match(t.text(t.hook()), /原目标是「long goal」/);
  const u = setup('detour2', { goalAgo: 1, cond: 'resume' });
  fs.mkdirSync(u.retro('sessions'), { recursive: true });
  fs.writeFileSync(u.retro('sessions/old.json'), JSON.stringify({ session_id: 'old', transcript_path: u.transcript, goal: 'save checkpoints, reply ready', unfinished: 'long goal' }));
  assert.match(u.text(u.hook()), /原目标是「long goal」/);
});

await test('setting the long goal again after a detour or a pause keeps its start; a launched review is not voided', () => {
  const t = setup('pause', { goalAgo: 40, cond: 'long goal' });
  t.hook();
  const goalFile = path.join(t.tmp, `claude-retro-${t.sid}.goal`);
  const start1 = JSON.parse(fs.readFileSync(goalFile, 'utf8')).start;
  const start = iso(Date.now() - 5 * MIN);
  fs.writeFileSync(t.retro('slot'), `state=running type=review start=${start} by=${t.sid} spawned=${start} lastScout=${iso(Date.now() - 39 * MIN)}\n`);
  t.addTranscript({ type: 'system', timestamp: iso(Date.now() - 2 * MIN), content: '<local-command-stdout>Goal cleared</local-command-stdout>' });
  t.addTranscript(goalLine('long goal', Date.now() - MIN));
  const r = t.text(t.hook());
  assert.equal(JSON.parse(fs.readFileSync(goalFile, 'utf8')).start, start1);
  assert.equal(t.slot().state, 'running'); assert.equal(t.slot().start, start);
  assert.doesNotMatch(r, /超过时间上限|登记|原目标/);
  t.addTranscript(goalLine('temporary', Date.now()));
  t.hook();
  t.addTranscript({ type: 'attachment', timestamp: iso(Date.now()), attachment: { type: 'goal_status', met: true, condition: 'temporary' } });
  t.addTranscript(goalLine('long goal', Date.now()));
  assert.doesNotMatch(t.text(t.hook()), /原目标/);
  assert.equal(JSON.parse(fs.readFileSync(goalFile, 'utf8')).start, start1);
});

await test('a session with a newer goal does not take an unlaunched reservation from another session', () => {
  const a = setup('steal', { sid: 'A', goalAgo: 30 });
  fs.mkdirSync(a.retro(''), { recursive: true });
  const start = iso(Date.now() - 3 * MIN);
  fs.writeFileSync(a.retro('slot'), `state=running type=review start=${start} by=A lastScout=${iso(Date.now() - 29 * MIN)}\n`);
  const b = setup('steal', { sid: 'B', goalAgo: 1 });
  b.hook();
  assert.equal(a.slot().state, 'running'); assert.equal(a.slot().by, 'A');
  assert.equal(a.cli('spawned', start).status, 0);
});

await test('a launched review gets the 2-minute grace before the hook voids it', () => {
  const t = setup('grace', { goalAgo: 50 });
  fs.mkdirSync(t.retro(''), { recursive: true });
  const start = iso(Date.now() - 21 * MIN);
  fs.writeFileSync(t.retro('slot'), `state=running type=review start=${start} by=${t.sid} spawned=${start} lastScout=${iso(Date.now() - 49 * MIN)}\n`);
  t.hook();
  assert.equal(t.slot().state, 'running');
  const fin = spawnSync(process.execPath, [CLI, 'finish', start, '-', '--root', t.proj], { env: t.env, input: '结论：保持', encoding: 'utf8' });
  assert.equal(fin.status, 0, fin.stdout);
});

await test('parallel first calls record the goal once', async () => {
  const t = setup('goalonce');
  await Promise.all(Array.from({ length: 8 }, () => t.hookAsync()));
  assert.equal(fs.readFileSync(t.retro('log.tsv'), 'utf8').split('\n').filter(l => /\tgoal\t/.test(l)).length, 1);
});


await test('Codex: a subagent thread is ignored even if its rollout carries the goal', () => {
  const created = Math.floor((Date.now() - 61 * MIN) / 1000);
  const child = codexMeta('kid', { subagent: { thread_spawn: { parent_thread_id: 'main', agent_role: 'worker' } } });
  const t = setup('codexchild', { goalAgo: null, extra: [child, codexGoal('codex goal', created)] });
  assert.equal(t.hook(), null);
  assert.ok(!fs.existsSync(t.retro('slot')));
});

await test('Codex: the goal database overrules the rollout (completed or cleared goes quiet); without it the rollout counts', async () => {
  process.removeAllListeners('warning');
  const { DatabaseSync } = await import('node:sqlite');
  const created = Math.floor((Date.now() - 61 * MIN) / 1000);
  const t = setup('codexdb', { goalAgo: null, extra: [codexMeta('sess-codexdb'), codexGoal('codex goal', created)] });
  t.fresh();
  const home = t.env.CODEX_HOME;
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'goals_1.sqlite'));
  db.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)');
  db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?)').run(t.sid, 'g1', 'codex goal', 'active', created * 1000 + 123, Date.now());
  const goalFile = path.join(t.tmp, `claude-retro-${t.sid}.goal`);
  const state = () => JSON.parse(fs.readFileSync(goalFile, 'utf8'));
  const r = t.text(t.hook());
  assert.ok(state().active); assert.equal(state().start, created * 1000);
  assert.match(r, /spawn_agent/); assert.match(r, /fork_turns 设为 "none"/); assert.match(r, /检查点到期/);
  db.prepare('UPDATE thread_goals SET status = ? WHERE thread_id = ?').run('complete', t.sid);
  assert.equal(t.hook(), null); assert.ok(!state().active);
  db.prepare('UPDATE thread_goals SET status = ? WHERE thread_id = ?').run('active', t.sid);
  assert.ok(t.hook() !== undefined && state().active);
  db.prepare('DELETE FROM thread_goals WHERE thread_id = ?').run(t.sid); // /goal clear
  assert.equal(t.hook(), null); assert.ok(!state().active);
  db.close();
  const u = setup('codexnodb', { goalAgo: null, extra: [codexMeta('sess-codexnodb'), codexGoal('codex goal', created)] });
  u.hook();
  assert.ok(JSON.parse(fs.readFileSync(path.join(u.tmp, `claude-retro-${u.sid}.goal`), 'utf8')).active);
});

await test('Codex: status reads the main rollout and finds child rollouts by parent thread id', () => {
  const t = setup('codexstatus', { goalAgo: null });
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const old = path.join(t.proj, '.codex', 'sessions', '2026', '07', '22'); // a resumed thread: its own rollout is old
  const day = path.join(t.proj, '.codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(day, { recursive: true });
  const main = path.join(old, 'rollout-main.jsonl'), kid = path.join(day, 'rollout-kid.jsonl');
  const guardian = { timestamp: iso(Date.now()), type: 'session_meta', payload: { id: 'g', parent_thread_id: 'main-id', source: { subagent: { other: 'guardian' } } } };
  fs.writeFileSync(path.join(day, 'rollout-guardian.jsonl'), JSON.stringify(guardian) + '\n');
  const msg = (role, text) => ({ timestamp: iso(Date.now()), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
  const lines = [codexMeta('main-id'), codexGoal('codex goal', Math.floor(Date.now() / 1000) - 60), msg('user', '进度怎样？'), msg('assistant', '派出两个执行者'),
    { timestamp: iso(Date.now()), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"node eval.mjs --seeds 1-100"}))' } }];
  fs.writeFileSync(main, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(kid, [codexMeta('kid-id', { subagent: { thread_spawn: { parent_thread_id: 'main-id', agent_path: '/root/try_expectimax', agent_role: 'worker' } } }), msg('assistant', '深度 3 跑完')].map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.mkdirSync(t.retro('sessions'), { recursive: true });
  fs.writeFileSync(t.retro('sessions/main-id.json'), JSON.stringify({ session_id: 'main-id', transcript_path: main, goal: 'codex goal', goal_start: iso(Date.now() - MIN) }));
  const out = t.cli('status').stdout;
  for (const s of ['派出两个执行者', '进度怎样', 'exec（node eval.mjs --seeds 1-100）', 'try_expectimax（worker', '深度 3 跑完']) assert.ok(out.includes(s), `missing ${s}\n${out}`);
  assert.ok(!out.includes('rollout-guardian'), 'guardian listed as a subagent');
});

await test('Codex: a cache from before Codex detection is rebuilt; an objective edited in place is the same goal', async () => {
  process.removeAllListeners('warning');
  const { DatabaseSync } = await import('node:sqlite');
  const created = Math.floor((Date.now() - 30 * MIN) / 1000);
  const t = setup('codexcache', { goalAgo: null, extra: [codexMeta('sess-codexcache'), codexGoal('win 50 games', created)] });
  fs.mkdirSync(t.env.CODEX_HOME, { recursive: true });
  const db = new DatabaseSync(path.join(t.env.CODEX_HOME, 'goals_1.sqlite'));
  db.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, created_at_ms INTEGER)');
  db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?)').run(t.sid, 'win 50 games', 'complete', created * 1000);
  db.close();
  const size = fs.statSync(t.transcript).size;
  fs.writeFileSync(path.join(t.tmp, `claude-retro-${t.sid}.goal`), JSON.stringify({ path: t.transcript, off: size, active: true, start: created * 1000, cond: 'win 50 games', past: [] }));
  assert.equal(t.hook(), null); // rebuilt: seen as Codex, so the completed row counts
  const u = setup('codexedit', { goalAgo: null, extra: [codexMeta('sess-codexedit'), codexGoal('win 50 games', created)] });
  u.hook();
  u.addTranscript(codexGoal('win 50 games, then write a report', created));
  assert.doesNotMatch(u.text(u.hook()), /原目标/);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(u.tmp, `claude-retro-${u.sid}.goal`), 'utf8')).unfinished);
});

await test('tell goes only to the session whose goal is active; none active means it is refused', () => {
  const t = setup('tellnone', { goalAgo: null });
  assert.equal(t.cli('tell', 'hello').status, 2);
  const a = setup('tell2', { sid: 'A' }), b = setup('tell2', { sid: 'B' }); // same project and temp dir
  a.hook(); b.hook();
  const bCache = path.join(b.tmp, 'claude-retro-B.goal');
  fs.writeFileSync(bCache, JSON.stringify({ ...JSON.parse(fs.readFileSync(bCache, 'utf8')), active: false })); // B's goal ended
  assert.equal(a.cli('tell', '换个评估函数').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(a.retro('user-inbox.jsonl'), 'utf8')).to, 'A');
  fs.unlinkSync(bCache); // B active again, but the message is for A
  assert.doesNotMatch(b.text(b.hook()), /换个评估函数/);
  assert.match(a.text(a.hook()), /换个评估函数/);
  assert.equal(fs.readFileSync(a.retro('user-inbox.jsonl'), 'utf8'), '');
});

await test('tell: the user\'s words reach the main agent once, at its next tool call, and are kept', () => {
  const t = setup('tell');
  t.hook();
  assert.match(t.cli('tell', '先别调参，试试换评估函数').stdout, /下一次调用工具时/);
  const r = t.text(t.hook());
  assert.match(r, /进度台/); assert.match(r, /先别调参，试试换评估函数/);
  assert.doesNotMatch(t.text(t.hook()), /进度台/);
  assert.match(fs.readFileSync(t.retro('user-said.md'), 'utf8'), /换评估函数/);
  assert.match(fs.readFileSync(t.retro('log.tsv'), 'utf8'), /\ttold\t/);
});

await test('regression: queued instructions stay with their goal; legacy messages are retained but not delivered', () => {
  for (const platform of ['claude', 'codex']) {
    const created = Date.now() - 5 * MIN, name = 'tell-goal-' + platform;
    const t = setup(name, platform === 'codex'
      ? { goalAgo: null, extra: [codexMeta('sess-' + name), codexGoal('Goal A', created)] }
      : { cond: 'Goal A' });
    t.hook();
    assert.equal(t.cli('tell', '立即停止 A 及其执行者').status, 0);
    t.addTranscript(platform === 'codex' ? codexGoal('Goal B', Date.now()) : goalLine('Goal B', Date.now()));
    assert.doesNotMatch(t.text(t.hook()), /立即停止 A 及其执行者/);
    assert.match(fs.readFileSync(t.retro('user-said.md'), 'utf8'), /没有送达[^\n]*Goal A[^\n]*立即停止 A/);
    assert.equal(fs.readFileSync(t.retro('user-inbox.jsonl'), 'utf8'), '');
    fs.appendFileSync(t.retro('user-inbox.jsonl'), JSON.stringify({ to: t.sid, at: iso(Date.now()), text: '旧格式指令' }) + '\n');
    assert.doesNotMatch(t.text(t.hook()), /旧格式指令/);
    assert.match(fs.readFileSync(t.retro('user-said.md'), 'utf8'), /没有送达[^\n]*旧格式指令/);
    assert.equal(t.cli('tell', '处理 B 的新指令').status, 0);
    assert.match(t.text(t.hook()), /处理 B 的新指令/);
  }
});

await test('regression: checkpoint readers and reminders are isolated by session and goal', () => {
  const t = setup('inbox-goals', { goalAgo: 120, cond: 'Goal A', sid: 'A' });
  t.hook();
  fs.mkdirSync(t.retro('tasks/a'), { recursive: true });
  fs.writeFileSync(t.retro('tasks/a/report.md'), 'A 的未处理回报');
  t.setTime(t.retro('tasks/a/report.md'), 30);
  const b = path.join(t.proj, 'b.jsonl');
  fs.writeFileSync(b, JSON.stringify(goalLine('Goal B', Date.now() - 5 * MIN)) + '\n');
  t.hook({ session_id: 'B', transcript_path: b });
  assert.notEqual(t.cli('inbox').status, 0, 'ambiguous reader silently selected a session');
  assert.notEqual(t.cli('done').status, 0, 'ambiguous checkpoint advanced a cursor');
  assert.match(t.cli('inbox', '--session', 'A').stdout, /A 的未处理回报/);
  assert.doesNotMatch(t.cli('inbox', '--session', 'B').stdout, /A 的未处理回报/);
  assert.equal(t.cli('done', '--session', 'B').status, 0);
  assert.match(t.cli('inbox', '--session', 'A').stdout, /A 的未处理回报/);
  assert.match(t.text(t.hook()), /检查点到期/);
  assert.equal(t.cli('done', '--session', 'A').status, 0);
  assert.doesNotMatch(t.cli('inbox', '--session', 'A').stdout, /A 的未处理回报/);
  assert.doesNotMatch(t.text(t.hook()), /检查点到期/);
  t.addTranscript(goalLine('Goal C', Date.now() - 10 * MIN));
  t.hook();
  fs.writeFileSync(t.retro('tasks/a/report.md'), 'C 的新回报');
  t.setTime(t.retro('tasks/a/report.md'), 5);
  assert.match(t.cli('inbox', '--session', 'A').stdout, /C 的新回报/);
});

await test('regression: background inbox uses its owner and that goal\'s previous round', () => {
  for (const type of ['review', 'scout']) {
    const t = setup('review-goals-' + type, { goalAgo: 120, cond: 'Goal A', sid: 'A' });
    t.hook();
    const aStart = JSON.parse(fs.readFileSync(t.state('goal'), 'utf8')).start;
    const bStart = Date.now() - 5 * MIN, b = path.join(t.proj, 'b.jsonl');
    fs.writeFileSync(b, JSON.stringify(goalLine('Goal B', bStart)) + '\n');
    t.hook({ session_id: 'B', transcript_path: b });
    for (const [owner, goalStart, mins] of [['A', aStart, 70], ['B', bStart, 2]]) {
      const start = iso(Date.now() - mins * MIN);
      fs.writeFileSync(t.retro('slot'), `state=running type=${type} start=${start} by=${owner} goalStart=${goalStart} spawned=${iso(Date.now())}\n`);
      const r = spawnSync(process.execPath, [CLI, 'finish', start, '-', '--root', t.proj], { env: t.env, input: `${owner} 的评审`, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout);
    }
    fs.mkdirSync(t.retro('tasks/a'), { recursive: true });
    fs.writeFileSync(t.retro('tasks/a/report.md'), 'A 的未处理回报');
    t.setTime(t.retro('tasks/a/report.md'), 30);
    fs.mkdirSync(t.retro('tasks/old'), { recursive: true });
    fs.writeFileSync(t.retro('tasks/old/report.md'), 'A 上轮已经读过的回报');
    t.setTime(t.retro('tasks/old/report.md'), 90);
    assert.match(t.cli('inbox', '--since-last', type, '--session', 'A').stdout, /A 的未处理回报/);
    assert.doesNotMatch(t.cli('inbox', '--since-last', type, '--session', 'A').stdout, /A 上轮已经读过的回报/);
    assert.doesNotMatch(t.cli('inbox', '--since-last', type, '--session', 'B').stdout, /A 的未处理回报/);
    fs.writeFileSync(t.retro('slot'), `state=running type=${type} start=${iso(Date.now())} by=A goalStart=${aStart}\n`);
    assert.match(t.cli('inbox', '--since-last', type).stdout, /A 的未处理回报/);
  }
});

await test('regression: unscoped legacy cursors never hide a current goal\'s reports', () => {
  const t = setup('legacy-cursors', { goalAgo: 120 });
  t.hook();
  for (const file of ['retro-done', 'inbox-at', 'review-start', 'scout-start']) fs.writeFileSync(t.retro(file), iso(Date.now()) + '\n');
  fs.writeFileSync(t.retro('route-review.md'), `<!-- route-review start=${iso(Date.now())} -->\n旧评审\n`);
  fs.mkdirSync(t.retro('tasks/old-scout'), { recursive: true });
  fs.writeFileSync(t.retro('tasks/old-scout/report.md'), '需要重读的旧回报');
  t.setTime(t.retro('tasks/old-scout/report.md'), 30);
  for (const args of [[], ['--since-last', 'review'], ['--since-last', 'scout']]) {
    assert.match(t.cli('inbox', ...args).stdout, /需要重读的旧回报/);
  }
});

await test('regression: expired reservations cannot start or finish through any entry point', () => {
  for (const entry of ['spawned', 'launched', 'finish']) {
    const t = setup('expired-' + entry, { goalAgo: 90 });
    t.hook();
    const start = iso(Date.now() - 31 * MIN);
    fs.writeFileSync(t.retro('slot'), `state=running type=review start=${start} by=${t.sid}\n`);
    if (entry === 'launched') t.hook({ tool_name: 'Agent', tool_input: { subagent_type: 'route-reviewer', run_in_background: true } });
    else {
      const args = entry === 'spawned' ? ['spawned', start] : ['finish', start, '-'];
      const r = spawnSync(process.execPath, [CLI, ...args, '--root', t.proj], { env: t.env, input: '过期报告', encoding: 'utf8' });
      assert.equal(r.status, 2, r.stdout);
    }
    assert.equal(t.slot().state, 'aborted');
    assert.ok(!t.slot().spawned);
    assert.ok(!fs.existsSync(t.retro('route-review.md')));
    assert.ok(!fs.existsSync(t.retro('probes')));
  }
});

await test('regression: rounds in the same minute retain separate reports and probe directories', () => {
  for (const type of ['review', 'scout']) {
    const t = setup('archive-precision-' + type);
    t.hook();
    const goalStart = JSON.parse(fs.readFileSync(t.state('goal'), 'utf8')).start;
    const minute = Math.floor((Date.now() - MIN) / MIN) * MIN;
    for (const ms of [100, 200]) {
      const start = iso(minute + ms);
      fs.writeFileSync(t.retro('slot'), `state=running type=${type} start=${start} by=${t.sid} goalStart=${goalStart}\n`);
      assert.equal(t.cli('spawned', start).status, 0);
      const r = spawnSync(process.execPath, [CLI, 'finish', start, '-', '--root', t.proj], { env: t.env, input: `报告 ${ms}`, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout);
    }
    assert.equal(fs.readdirSync(t.retro('probes')).length, 2);
    const base = t.retro(type === 'review' ? 'reviews' : 'tasks');
    const files = fs.readdirSync(base);
    assert.equal(files.length, 2);
    const bodies = files.map(f => fs.readFileSync(path.join(base, f, ...(type === 'scout' ? ['report.md'] : [])), 'utf8')).join('\n');
    assert.match(bodies, /报告 100/); assert.match(bodies, /报告 200/);
  }
});

await test('hook stays fast on a 60 MB transcript (first scan, then cached)', () => {
  const t = setup('perf', { goalAgo: 5 });
  const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(2000) }] } }) + '\n';
  fs.appendFileSync(t.transcript, filler.repeat(30000));
  let s = Date.now(); t.hook(); const first = Date.now() - s;
  s = Date.now(); t.hook(); const cached = Date.now() - s;
  console.log(`     first scan ${first} ms, cached ${cached} ms`);
  assert.ok(cached < 1500);
});

await test('Codex recovery: transient failure watchdog integration', async () => {
  const child = spawn(process.execPath, [path.join(here, 'recovery.mjs')]);
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, output);
});

try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.log(`(could not remove ${TMP}: ${e.code})`); }
console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
