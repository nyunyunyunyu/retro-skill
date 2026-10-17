// Tests for the retro hook and CLI with synthetic hook input. Run: node test/run.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return { proj, tmp, sid, transcript, hook, hookAsync, cli, text, retro, slot, addTranscript, state, age, sub, agentFile, setTime, env };
}
const goalLine = (cond, t, extra = {}) => ({ type: 'attachment', timestamp: new Date(t).toISOString(), attachment: { type: 'goal_status', met: false, sentinel: true, condition: cond, ...extra } });
const iso = t => new Date(t).toISOString();
const codexGoal = (objective, createdAt, status = 'active') => ({ timestamp: iso(Date.now()), type: 'event_msg', payload: { type: 'thread_goal_updated', goal: { objective, status, createdAt } } });
const codexMeta = (id, source = 'vscode') => ({ timestamp: iso(Date.now()), type: 'session_meta', payload: { session_id: id, id, source, base_instructions: { text: 'x' } } });

async function test(name, fn) {
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

await test('checkpoint: due at 60 min, repeated every 10 min until done; calls and results never trigger it', () => {
  const t = setup('time', { goalAgo: 61 });
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

await test('Stop blocks while due, again only after a tool call; stop_hook_active (always true under /goal) is ignored', () => {
  const t = setup('stop', { goalAgo: 61 });
  t.hook(); t.cli('spawned', t.slot().start); t.cli('slots', '2', 'x');
  const r = t.hook({ hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(r.decision, 'block'); assert.match(r.reason, /检查点到期/);
  assert.equal(t.hook({ hook_event_name: 'Stop', stop_hook_active: true }), null); // no tool call since: no loop
  assert.doesNotMatch(t.text(t.hook()), /检查点到期/); // said at the Stop, so not again at the next call
  const again = t.hook({ hook_event_name: 'Stop', stop_hook_active: true }); // still due when ending the turn: said again
  assert.equal(again.decision, 'block'); assert.match(again.reason, /检查点到期/);
  t.cli('done'); t.hook();
  assert.doesNotMatch(t.text(t.hook({ hook_event_name: 'Stop', stop_hook_active: true })), /检查点到期/);
});

await test('SessionStart after a compaction re-points the main agent at the main loop; other starts and no goal: silent', () => {
  const t = setup('compact', { goalAgo: 30 });
  const r = t.hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(r.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.hookSpecificOutput.additionalContext, /主循环/); assert.match(r.hookSpecificOutput.additionalContext, /status/);
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
  assert.match(r, /「quiet」（general-purpose）已经 25 分钟没有调用工具/);
  const r2 = t.text(t.hook());
  assert.doesNotMatch(r2, /连续跑了|没有调用工具/);
  t.hook({ hook_event_name: 'SubagentStop', agent_id: 'long', agent_type: 'general-purpose' });
  t.sub('long'); // a follow-up
  assert.ok(Date.now() - JSON.parse(fs.readFileSync(t.agentFile('long'), 'utf8')).seg < MIN);
  assert.ok(!fs.existsSync(t.agentFile('long', 'stop')));
  // The review/scout, internal agents and Codex guardians are not tracked.
  for (const agent_type of ['', 'route-reviewer', 'idea-scout', 'guardian']) t.sub('x' + agent_type, { agent_type });
  assert.deepEqual(fs.readdirSync(path.dirname(t.agentFile('long'))).filter(f => f.startsWith('x')), []);
});

await test('idle slots: a launch restarts the grace; a Stop is not blocked again for it within 10 min', () => {
  const t = setup('idlelaunch', { goalAgo: 30 });
  t.hook(); t.cli('spawned', t.slot().start);
  const set = { n: 2, at: iso(Date.now() - 6 * MIN), why: 'x' };
  fs.writeFileSync(t.retro('slots'), JSON.stringify(set));
  // Launching an executor: it is tracked only from its first tool call, so neither this call nor the Stop says idle.
  assert.doesNotMatch(t.text(t.hook({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'x', run_in_background: true } })), /名额空着/);
  assert.doesNotMatch(t.text(t.hook({ hook_event_name: 'Stop' })), /名额空着/);
  fs.writeFileSync(t.state('launch'), String(Date.now() - 6 * MIN));
  assert.match(t.text(t.hook()), /名额空着/);
  assert.equal(t.hook({ hook_event_name: 'Stop' }), null); // said 0 min ago: not urgent, so the Stop isn't blocked for it
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

await test('harness limit: too few subagents allowed stops the run (Codex default 3, Claude Code env var)', () => {
  const created = Math.floor((Date.now() - 5 * MIN) / 1000);
  const t = setup('limitcodex', { goalAgo: null, codexLimit: 0, extra: [codexMeta('sess-limitcodex'), codexGoal('codex goal', created)] });
  const r = t.text(t.hook());
  assert.match(r, /Codex 现在同时只能开 3 个子代理/); assert.match(r, /至少 5/);
  assert.ok(!fs.existsSync(t.retro('slot')), 'a scout was reserved anyway');
  const u = setup('limitclaude');
  assert.match(u.text(u.hook({}, { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4' })), /Claude Code 现在同时只能开 4 个子代理/);
  assert.match(u.text(u.hook({}, { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5' })), /已为你登记/);
});

await test('a Stop that may not speak changes no state', () => {
  const t = setup('mute', { goalAgo: 5 });
  fs.writeFileSync(path.join(t.tmp, `claude-retro-${t.sid}.blocked`), '0');
  assert.equal(t.hook({ hook_event_name: 'Stop' }), null);
  assert.ok(!fs.existsSync(t.retro('slot'))); // the scout was not reserved silently
});

await test('Stop also reminds about an unspawned slot', () => {
  const t = setup('stopslot');
  t.hook();
  const r = t.hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(r.decision, 'block'); assert.match(r.reason, /还没有启动/);
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
  assert.match(t.text(t.hook()), /过去 1 小时没有任何新结果/);
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
  const rs = await Promise.all(Array.from({ length: 10 }, () => t.hookAsync()));
  assert.equal(rs.filter(r => /检查点到期/.test(t.text(r))).length, 1);
  assert.equal(rs.filter(r => /已为你登记/.test(t.text(r))).length, 1);
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
  const r = t.text(t.hook({ hook_event_name: 'Stop', stop_hook_active: false }));
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
  assert.match(t.text(t.hook()), /检查点到期（距上次检查点或目标开始 61 分钟/);
  t.addTranscript(ev('paused'));
  assert.equal(t.hook(), null);
  t.addTranscript(ev('active'));
  t.age(11);
  assert.match(t.text(t.hook()), /检查点到期（距上次检查点或目标开始 61 分钟/); // resumed: same goal, same start
});

await test('PROGRESS.md over 4 KB is flagged in the retro nudge and by done', () => {
  const t = setup('big', { goalAgo: 61 });
  fs.writeFileSync(path.join(t.proj, 'PROGRESS.md'), 'x'.repeat(5000));
  assert.match(t.text(t.hook()), /超过 4 KB/);
  assert.match(t.cli('done').stdout, /超过 4 KB/);
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
  assert.match(gi, /^slot$/m); assert.match(gi, /^sessions\/$/m); assert.doesNotMatch(gi, /^\*$/m);
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
  assert.equal(s.model, 'x'); assert.ok(s.hooks.Stop && s.hooks.SubagentStop && s.hooks.PostToolUse);
  assert.equal(s.hooks.SessionStart[0].matcher, 'compact');
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(codexHooks).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStop']);
  assert.equal(codexHooks.SessionStart[0].matcher, 'compact');
  assert.match(fs.readFileSync(path.join(home, '.codex', 'agents', 'idea-scout.toml'), 'utf8'), /model_reasoning_effort = "xhigh"/);
  assert.match(r.stdout, /WARNING: Codex lets a session run only 3 subagents/);
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

await test('hook stays fast on a 60 MB transcript (first scan, then cached)', () => {
  const t = setup('perf', { goalAgo: 5 });
  const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(2000) }] } }) + '\n';
  fs.appendFileSync(t.transcript, filler.repeat(30000));
  let s = Date.now(); t.hook(); const first = Date.now() - s;
  s = Date.now(); t.hook(); const cached = Date.now() - s;
  console.log(`     first scan ${first} ms, cached ${cached} ms`);
  assert.ok(cached < 1500);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
