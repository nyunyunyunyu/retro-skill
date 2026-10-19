// No live app or model calls: exercise the real CLI and detached watcher against a local fake app pipe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { retryable, recoveryPlan, appRequest } from '../skills/retro/scripts/codex-recover.mjs';

process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');
const script = fileURLToPath(new URL('../skills/retro/scripts/codex-recover.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-recovery-'));
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\retro-test-${randomUUID()}` : path.join(tmp, 'app.sock');
const thread = 'recovery-test', now = Date.now(), created = now - 86400000;
const goal = { status: 'active', created_at_ms: created, objective: 'test' };
const state = { thread, root: tmp, createdAt: created, objective: 'test', armedAt: now - 200000, sent: [] };
const failed = (id = 't1', code = 'serverOverloaded') => ({ id, status: 'failed', completedAt: Math.floor((Date.now() - 1000) / 1000), error: { codexErrorInfo: code } });
const snapshot = turn => ({ thread: { id: thread, hostId: 'local', kind: 'codex', cwd: tmp, status: { type: 'idle' } }, turns: [turn] });
let n = 0;
const test = async (name, fn) => { await fn(); console.log(`ok   recovery: ${name}`); n++; };
const until = async (fn, ms = 8000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

await test('only structured transient failures qualify', () => {
  for (const code of ['serverOverloaded', 'flexUnavailable', 'internalServerError', 'rateLimitExceeded']) assert.equal(retryable({ codexErrorInfo: code }), true);
  for (const code of ['cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'usageLimitExceeded', 'sessionBudgetExceeded', 'contextWindowExceeded', 'unauthorized', 'other', undefined]) assert.equal(retryable({ codexErrorInfo: code, message: 'server capacity' }), false);
  for (const status of [null, 408, 500, 503]) assert.equal(retryable({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } }), true);
  for (const status of [401, 403, 429, '503', undefined]) assert.equal(retryable({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } }), false);
  assert.equal(retryable({ codexErrorInfo: 'serverOverloaded', willRetry: true }), false);
});

await test('backoff, dedup, and attempt cap; no idle/active/approval wake', () => {
  const s = snapshot({ ...failed(), completedAt: Math.floor(now / 1000) - 60 });
  assert.equal(recoveryPlan(state, goal, s, now).turn, 't1');
  assert.deepEqual(recoveryPlan(state, goal, s, now - 40000), {});
  assert.deepEqual(recoveryPlan({ ...state, sent: ['t1'] }, goal, s, now), {});
  assert.ok(recoveryPlan({ ...state, sent: ['a', 'b', 'c'] }, goal, s, now).stop);
  assert.deepEqual(recoveryPlan({ ...state, sent: ['a', 'b'] }, goal, s, now), {});
  for (const status of ['active', 'notLoaded']) assert.deepEqual(recoveryPlan(state, goal, { ...s, thread: { ...s.thread, status: { type: status, activeFlags: ['waitingOnApproval'] } } }, now), {});
  for (const status of ['completed', 'interrupted', 'inProgress']) assert.deepEqual(recoveryPlan(state, goal, snapshot({ ...failed(), status }), now), {});
  assert.deepEqual(recoveryPlan(state, goal, snapshot({ ...failed(), completedAt: 1 }), now), {});
  assert.deepEqual(recoveryPlan(state, goal, snapshot({ ...failed('old-policy', 'cyberPolicy'), completedAt: 1 }), now), {});
  assert.deepEqual(recoveryPlan(state, goal, snapshot({ ...failed(), completedAt: null }), now), {});
});

await test('pause, clear, replacement, unreadable DB and policy failures stop recovery', () => {
  for (const g of [null, undefined, { ...goal, status: 'paused' }, { ...goal, status: 'complete' }, { ...goal, status: 'budget_limited' }, { ...goal, objective: 'another' }, { ...goal, created_at_ms: 999 }]) assert.ok(recoveryPlan(state, g, snapshot(failed()), now).stop);
  assert.ok(recoveryPlan(state, goal, snapshot(failed('safety', 'cyberPolicy')), now).stop);
  assert.ok(recoveryPlan(state, goal, { ...snapshot(failed()), thread: { id: 'another' } }, now).stop);
});

const dbHome = path.join(tmp, 'codex'); fs.mkdirSync(dbHome);
const db = new DatabaseSync(path.join(dbHome, 'goals_1.sqlite'));
db.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, created_at_ms INTEGER)');
db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?)').run(thread, 'test', 'active', created);
const updateGoal = status => db.prepare('UPDATE thread_goals SET status=? WHERE thread_id=?').run(status, thread);
const env = { ...process.env, CODEX_THREAD_ID: thread, CODEX_HOME: dbHome, CODEX_APP_TOOLS_PIPE_PATH: pipe, RETRO_TIME_SCALE: '0.001' };
const cli = command => new Promise(resolve => {
  const child = spawn(process.execPath, [script, command, '--root', tmp], { env, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  child.on('close', code => resolve({ code, out, err }));
});
const record = () => { try { return JSON.parse(fs.readFileSync(path.join(tmp, '.retro/recovery', thread + '.json'), 'utf8')); } catch { return null; } };
const start = async () => { const result = await cli('start'); assert.equal(result.code, 0, JSON.stringify(result)); };
let current = snapshot({ id: 'running', status: 'inProgress', error: null });
let sends = [], dropSend = false, beforeRead = null;
const sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  let data = Buffer.alloc(0);
  socket.on('data', chunk => {
    data = Buffer.concat([data, chunk]);
    if (data.length < 4 || data.length < data.readUInt32LE(0) + 4) return;
    const request = JSON.parse(data.subarray(4, data.readUInt32LE(0) + 4));
    let result;
    if (request.method === 'tools/list') result = { tools: ['read_thread', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app' })) };
    else {
      assert.equal(request.params.threadId, thread);
      if (request.params.tool === 'read_thread') { beforeRead?.(); result = current; }
      else {
        assert.equal(request.params.tool, 'send_message_to_thread');
        assert.deepEqual(Object.keys(request.params.arguments).sort(), ['hostId', 'prompt', 'threadId']);
        sends.push(request.params.arguments);
        if (dropSend) { socket.destroy(); return; }
        result = { success: true };
      }
      result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    // Exercise fragmented framing, including a split length header.
    socket.write(header.subarray(0, 2)); setTimeout(() => socket.end(Buffer.concat([header.subarray(2), body])), 1);
  });
});
await new Promise(resolve => server.listen(pipe, resolve));
try {
  await test('real detached watcher retries failed turns once and stops after three', async () => {
    await start();
    await until(() => record()?.note === '监控已启动');
    await start();
    const pid = record().pid;
    await new Promise(r => setTimeout(r, 100)); assert.equal(sends.length, 0);
    for (let i = 1; i <= 3; i++) {
      current = snapshot({ ...failed(`failure-${i}`), completedAt: Math.floor(Date.now() / 1000) });
      await until(() => sends.length === i);
      await new Promise(r => setTimeout(r, 100)); assert.equal(sends.length, i);
    }
    current = snapshot({ ...failed('fourth'), completedAt: Math.floor(Date.now() / 1000) });
    await until(() => record()?.enabled === false);
    assert.equal(sends.length, 3); assert.equal(record().sent.length, 3); assert.equal(record().pid, pid);
    assert.equal((await cli('start')).code, 1);
  });

  await test('a pause between observations cancels the pending send', async () => {
    db.prepare('UPDATE thread_goals SET created_at_ms=? WHERE thread_id=?').run(created + 1, thread);
    current = snapshot({ id: 'running-2', status: 'inProgress' });
    await start(); await until(() => record()?.note === '监控已启动');
    let reads = 0;
    beforeRead = () => { if (++reads === 2) updateGoal('paused'); };
    current = snapshot({ ...failed('pause-race'), completedAt: Math.floor(Date.now() / 1000) });
    await until(() => record()?.enabled === false);
    assert.equal(sends.length, 3); beforeRead = null;
  });

  await test('lost send reply is recorded once and disables recovery', async () => {
    updateGoal('active'); current = snapshot({ id: 'running-3', status: 'inProgress' });
    await start(); await until(() => record()?.note === '监控已启动');
    dropSend = true; current = snapshot({ ...failed('lost-reply'), completedAt: Math.floor(Date.now() / 1000) });
    await until(() => record()?.enabled === false);
    assert.equal(sends.length, 4); assert.deepEqual(record().sent, ['lost-reply']);
    assert.equal((await cli('status')).code, 0);
  });

  await test('missing/closed transport fails instead of taking over with a CLI', async () => {
    await assert.rejects(appRequest('tools/list', {}, ''));
    await assert.rejects(appRequest('tools/list', {}, pipe + '-missing'));
    assert.equal((await cli('stop')).code, 0);
  });

  await test('new user turn and explicit stop prevent sends', async () => {
    dropSend = false; current = snapshot({ id: 'running-4', status: 'inProgress' });
    await start();
    let reads = 0;
    beforeRead = () => { if (++reads === 2) current = snapshot({ id: 'new-user-turn', status: 'inProgress' }); };
    current = snapshot(failed('old-failure'));
    await until(() => current.turns[0]?.id === 'new-user-turn');
    assert.equal(sends.length, 4);
    beforeRead = null;
    assert.equal((await cli('stop')).code, 0);
    current = snapshot(failed('after-stop'));
    await new Promise(r => setTimeout(r, 100)); assert.equal(sends.length, 4);
  });
} finally {
  await cli('stop');
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  db.close();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`${n}/${n} recovery tests passed`);
