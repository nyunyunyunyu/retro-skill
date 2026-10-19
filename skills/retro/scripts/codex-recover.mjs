#!/usr/bin/env node
// Explicitly armed, per-goal recovery for the local Codex desktop app. No goal mutation, CLI takeover, or idle restart.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { alive, codexGoal, dir, ensureDir, log, mainCheckout, read, safe, withLock } from './lib.mjs';

const scale = Number(process.env.RETRO_TIME_SCALE) > 0 ? Number(process.env.RETRO_TIME_SCALE) : 1;
const TICK = 15e3 * scale;
const DELAYS = [30e3, 60e3, 120e3].map(n => n * scale);
const SELF = fileURLToPath(import.meta.url);
const stateFile = (root, id) => path.join(dir(root), 'recovery', `${safe(id)}.json`);
const load = file => { try { return JSON.parse(read(file)); } catch { return null; } };
const sameGoal = (s, g) => g?.status === 'active' && g.created_at_ms === s.createdAt && g.objective === s.objective;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function retryable(error) {
  if (!error || error.willRetry === true) return false;
  const code = error.codexErrorInfo;
  if (typeof code === 'string') return ['serverOverloaded', 'flexUnavailable', 'internalServerError', 'rateLimitExceeded'].includes(code);
  if (!code || typeof code !== 'object' || Object.keys(code).length !== 1) return false;
  const [kind, detail] = Object.entries(code)[0];
  if (!['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind)) return false;
  if (!detail || !Object.hasOwn(detail, 'httpStatusCode')) return false;
  const status = detail.httpStatusCode;
  return status === null || status === 408 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

// Pure decision: silence, active turns, unknown errors, native retries, and approval waits are never wake signals.
export function recoveryPlan(state, goal, snapshot, now = Date.now()) {
  if (!sameGoal(state, goal)) return { stop: '目标已暂停、结束、改变，或无法读取' };
  if (snapshot?.thread?.id !== state.thread || snapshot.thread.hostId !== 'local' || snapshot.thread.kind !== 'codex') return { stop: '会话身份或平台不匹配' };
  if (!snapshot.thread.cwd || mainCheckout(snapshot.thread.cwd) !== state.root) return { stop: '会话工作目录已改变' };
  const turn = snapshot.turns?.[0];
  if (!['idle', 'systemError'].includes(snapshot.thread.status?.type) || turn?.status !== 'failed') return {};
  if (!turn.id || !Number.isFinite(turn.completedAt) || turn.completedAt * 1000 < Math.floor(state.createdAt / 1000) * 1000) return {};
  if (!retryable(turn.error)) return { stop: '失败原因不在临时故障白名单内，请人工检查' };
  if (state.sent.includes(turn.id)) return {};
  if (state.sent.length >= DELAYS.length) return { stop: '本目标的 3 次自动恢复已用完' };
  if (now < turn.completedAt * 1000 + DELAYS[state.sent.length]) return {};
  return { turn: turn.id };
}

// Transport used by the bundled codex-app-tools plugin (length-prefixed JSON-RPC over its local pipe).
// shortcut: this is a desktop-internal transport; stop on incompatibility and update after app protocol changes.
export function appRequest(method, params, pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH) {
  if (!pipe) return Promise.reject(new Error('缺少 CODEX_APP_TOOLS_PIPE_PATH；请从本机 Codex 桌面会话启动'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex app 接口超时；发送结果可能未知，不自动重发')), 10000);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('Codex app 接口已关闭')));
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) return finish(new Error('Codex app 响应超过 8 MiB'));
      if (buffer.length < length + 4) return;
      try {
        const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
        if (message.jsonrpc !== '2.0' || message.id !== 1) throw new Error('Codex app 响应格式不匹配');
        if (message.error) throw new Error(message.error.message || 'Codex app 请求失败');
        finish(null, message.result);
      } catch (error) { finish(error); }
    });
  });
}

async function appTools(thread) {
  const catalog = await appRequest('tools/list', { threadStartKind: 'all' });
  const required = ['read_thread', 'send_message_to_thread'];
  const available = required.map(name => catalog?.tools?.find(t => t.name === name && t.namespace === 'codex_app'));
  if (available.some(t => !t)) throw new Error('本机 Codex 没有恢复监控需要的会话接口');
  return async (tool, args) => {
    const result = await appRequest('tools/call', {
      namespace: 'codex_app', tool, arguments: args, callerSource: 'codex', hostId: 'local',
      threadId: thread, turnId: `retro-recovery-${randomUUID()}`, callId: `retro-recovery-${randomUUID()}`,
    });
    if (result?.success !== true) throw new Error('Codex app 工具失败；不自动重复发送');
    const text = result.contentItems?.filter(c => c.type === 'inputText').map(c => c.text).join('\n');
    try { return JSON.parse(text); } catch { throw new Error('Codex app 工具结果无法解析；不自动重复发送'); }
  };
}

const snapshotOf = (call, thread) => call('read_thread', { threadId: thread, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
const save = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`, text = JSON.stringify(value);
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (error) {
    // Windows can deny replacement even inside the writer lock; readers fail closed on an incomplete record.
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    fs.writeFileSync(file, text); fs.unlinkSync(tmp);
  }
};

async function watch(root, thread, token) {
  const file = stateFile(root, thread);
  const update = fn => withLock(file + '.lock', () => {
    const state = load(file);
    if (!state?.enabled || state.token !== token) return false;
    fn(state); state.updatedAt = Date.now(); save(file, state); return true;
  }, 20);
  try {
    const call = await appTools(thread);
    if (!update(s => { s.pid = process.pid; s.ready = true; s.note = '监控已启动'; })) return;
    while (true) {
      let state = load(file);
      if (!state?.enabled || state.token !== token) return;
      let goal = codexGoal(thread);
      let plan = sameGoal(state, goal) ? recoveryPlan(state, goal, await snapshotOf(call, thread)) : { stop: '目标已暂停、结束、改变，或无法读取' };
      if (plan.turn) {
        // Check again after the API round trip, immediately before recording the send attempt.
        const snapshot = await snapshotOf(call, thread);
        goal = codexGoal(thread);
        state = load(file);
        if (!state?.enabled || state.token !== token) return;
        plan = recoveryPlan(state, goal, snapshot);
        if (plan.turn) {
          const turn = plan.turn;
          let claimed = false;
          update(s => {
            if (sameGoal(s, codexGoal(thread)) && !s.sent.includes(turn) && s.sent.length < DELAYS.length) {
              s.sent.push(turn); s.note = `已登记恢复尝试 ${s.sent.length}/3`; claimed = true;
            }
          });
          if (claimed) {
            // Claim before sending: a crash or lost reply must never create duplicate follow-ups.
            log(root, thread, 'recovery-attempt', turn);
            await call('send_message_to_thread', { threadId: thread, hostId: 'local', prompt:
              '[retro 自动恢复] 已检测到上一轮因临时服务故障结束。请先核对原生 goal 和最新用户指令；仅在原目标仍 active、没有待批准事项时继续原工作。目标已暂停、结束或受限时保持停止；不要改变目标、预算、模型或权限。' });
            update(s => { s.note = `已发送恢复消息 ${s.sent.length}/3`; });
          }
        }
      }
      if (plan.stop) { update(s => { s.enabled = false; s.note = plan.stop; }); log(root, thread, 'recovery-stop', plan.stop); return; }
      await sleep(TICK);
    }
  } catch (error) {
    update(s => { s.enabled = false; s.note = error.message; });
    log(root, thread, 'recovery-error', error.message);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = mainCheckout(ri < 0 ? process.cwd() : args[ri + 1]);
  const thread = process.env.CODEX_THREAD_ID;
  if (!thread || safe(thread) !== thread) throw new Error('缺少当前 CODEX_THREAD_ID；只能在要监控的本机 Codex 会话启动');
  const file = stateFile(root, thread);
  if (cmd === '__watch') return watch(root, thread, args[0]);
  if (cmd === 'status') {
    const s = load(file);
    console.log(JSON.stringify(s ? { ...s, running: s.enabled && alive(s.pid) } : { running: false, note: '未启用自动恢复' }, null, 2));
    return;
  }
  if (cmd === 'stop') {
    if (!fs.existsSync(file)) { console.log('未启用自动恢复。'); return; }
    const stopped = withLock(file + '.lock', () => { const s = load(file); if (!s) return; s.enabled = false; s.note = '用户停止恢复监控'; save(file, s); return true; });
    if (!stopped) throw new Error('恢复状态正在写入，请重试 stop');
    console.log('恢复监控已停用。'); return;
  }
  if (cmd !== 'start') throw new Error('用法：node codex-recover.mjs start|stop|status --root <项目>');
  const goal = codexGoal(thread);
  if (goal?.status !== 'active') throw new Error('只能为可读取的 active goal 启用恢复；不会自动执行 /goal resume');
  const call = await appTools(thread), snapshot = await snapshotOf(call, thread);
  if (snapshot?.thread?.id !== thread || snapshot.thread.hostId !== 'local' || snapshot.thread.kind !== 'codex' || !snapshot.thread.cwd || mainCheckout(snapshot.thread.cwd) !== root) throw new Error('目标会话不属于这个本机项目');
  ensureDir(root); fs.mkdirSync(path.dirname(file), { recursive: true });
  const armed = withLock(file + '.lock', () => {
    const prev = load(file);
    if (prev?.enabled && alive(prev.pid) && sameGoal(prev, goal)) return { token: prev.token, message: '已有恢复监控在运行。' };
    const token = randomUUID();
    const s = { thread, root, createdAt: goal.created_at_ms, objective: goal.objective, token, enabled: true,
      armedAt: Date.now(), sent: sameGoal(prev || {}, goal) ? prev.sent : [], note: '启动中', pid: null };
    if (s.sent.length >= DELAYS.length) throw new Error('本目标的 3 次恢复已用完，需人工处理');
    if (!sameGoal(s, codexGoal(thread))) throw new Error('目标状态已改变，未启用恢复');
    s.pid = process.pid; save(file, s);
    const child = spawn(process.execPath, [SELF, '__watch', token, '--root', root], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', error => log(root, thread, 'recovery-error', error.message));
    s.pid = child.pid; save(file, s); child.unref();
    log(root, thread, 'recovery-start', '最多 3 次，仅临时服务故障');
    return { token, message: '已为当前目标启动恢复监控；状态见 codex-recover.mjs status。' };
  });
  if (!armed) throw new Error('已有恢复操作正在进行，请稍后检查 status');
  if (armed.token) {
    const end = Date.now() + 12000;
    while (true) {
      const s = load(file);
      if (!s?.enabled || s.token !== armed.token || !alive(s.pid)) throw new Error(s?.note || '恢复监控未启动');
      if (s.ready) break;
      if (Date.now() >= end) throw new Error('恢复监控未确认就绪，请检查 status');
      await sleep(50);
    }
  }
  console.log(armed.message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch(error => { console.error(error.message); process.exitCode = 1; });
