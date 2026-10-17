#!/usr/bin/env node
// Helper CLI for retro. Every command takes --root <project>; the hook's messages always pass it. Without it the
// project is CLAUDE_PROJECT_DIR, else the nearest directory up from here holding .retro/, else the current directory;
// inside a git worktree, the same place in the main checkout (so worktrees share one .retro/). Exit codes: 2 = slot
// voided/replaced, 3 = busy.
//   done                   mark a checkpoint finished (stops its reminders until the next one is due, 60 min later)
//   inbox                  what came back since the last checkpoint: task reports, the latest review, ledger rows
//   slots <n> [why]        the main agent records its executor slots for the goal; the hook checks for idle ones
//   request review|scout   ask for a background review/scout now; the hook reserves it at the next tool call
//   spawned <start>        a review/scout subagent marks itself started and learns its deadline
//   finish <start> <file>  a review/scout subagent hands in its report (file, or - for stdin)
//   abort <start>          the main agent couldn't start the subagent; frees the slot
//   status                 progress digest for the progress desk (read-only)
//   tell <text>            the progress desk passes on what the user said; delivered at the main agent's next tool call
import fs from 'node:fs';
import path from 'node:path';
import {
  C, EXIT_BUSY, EXIT_GONE, agentName, dir, ensureDir, goalAgents, goalCache, harnessLimit, headOf, iso, lastRetro, lastWrite,
  limitOf, locked, log, mainCheckout, mtime, openIdeas, read, readSlot, readSlots, reports, sessions, writeSlot,
} from './lib.mjs';

const args = process.argv.slice(2);
let rootArg = null;
const ri = args.indexOf('--root');
if (ri >= 0) { rootArg = args[ri + 1]; args.splice(ri, 2); }
const [cmd, ...rest] = args;
const root = findRoot(rootArg);
const now = Date.now();
const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const ago = t => (t ? `${clock(t)}（${Math.max(0, Math.round((now - t) / 60e3))} 分钟前）` : '无');
const fail = (msg, code = 1) => { console.log(msg); process.exit(code); };
const busy = () => fail('状态文件被其他进程占用：等几秒后重试同一条命令。', EXIT_BUSY);

const commands = { done, inbox, slots, request, spawned, finish, abort, status, tell, root: () => console.log(root) };
if (!commands[cmd]) fail('用法：node retro.mjs <done|inbox|slots <N> <理由>|request review|scout|spawned <start>|finish <start> <file>|abort <start>|status|tell <话>> [--root <项目>]');
commands[cmd]();

// Same mapping as the hook: a worktree path stands for the same place in the main checkout.
function findRoot(arg) {
  if (arg) return mainCheckout(arg);
  if (process.env.CLAUDE_PROJECT_DIR) return mainCheckout(process.env.CLAUDE_PROJECT_DIR);
  const cwd = mainCheckout(process.cwd());
  for (let d = cwd; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.retro'))) return d;
    if (path.dirname(d) === d) return cwd;
  }
}

function done() {
  ensureDir(root);
  fs.writeFileSync(path.join(dir(root), 'retro-done'), iso(now) + '\n');
  log(root, '', 'checkpoint-done', '');
  const size = mtime(path.join(root, 'PROGRESS.md')) ? fs.statSync(path.join(root, 'PROGRESS.md')).size : 0;
  const open = openIdeas(root);
  const out = [`已记录检查点（${clock(now)}）。下一个在 60 分钟后。`];
  if (!size) out.push(`${root} 下还没有 PROGRESS.md。`);
  else if (size > C.PROGRESS_MAX) out.push(`PROGRESS.md 有 ${(size / 1024).toFixed(1)} KB，超过 4 KB，请压缩。`);
  out.push(open === null ? '还没有想法池 .retro/ideas.md。' : `想法池里未验证的想法 ${open} 条${open < C.OPEN_IDEAS_MIN ? '，偏少' : ''}。`);
  console.log(out.join(''));
}

function inbox() {
  // Since the last checkpoint, or since the goal of the session running it (the most recently active one) started.
  const R = Math.max(lastRetro(root), Date.parse(sessions(root)[0]?.goal_start) || 0);
  console.log(`# 上次检查点以来交回的内容（上次检查点：${ago(lastRetro(root))}）`);
  // The newest reports that fit, printed oldest first.
  const list = reports(root).filter(r => r.mtime > R);
  const shown = [];
  let budget = 16000;
  for (const r of list) {
    const body = clip(read(r.file), 2000);
    if (body.length > budget) break;
    budget -= body.length;
    shown.unshift({ r, body });
  }
  for (const { r, body } of shown) console.log(`\n## ${r.scout ? '侦察' : '任务'} ${r.task}（${clock(r.mtime)}）\n${body}`);
  if (list.length > shown.length) console.log(`\n（更早的 ${list.length - shown.length} 份回报超出长度没有列出，需要时直接读 .retro/tasks/*/report.md）`);
  const review = path.join(dir(root), 'route-review.md');
  if (mtime(review) > R) console.log(`\n## 路线评审（${clock(mtime(review))}）\n${clip(read(review), 2000)}`);
  for (const f of [path.join(dir(root), 'results.tsv'), path.join(root, 'results.tsv')]) {
    if (mtime(f) <= R) continue;
    const rows = read(f).split('\n').filter(Boolean);
    console.log(`\n## 总表 ${path.relative(root, f)}（共 ${rows.length} 行，最后更新 ${clock(mtime(f))}），第一行和最后 5 行：\n${[rows[0], '…', ...rows.slice(-5)].join('\n')}`);
  }
  if (!list.length && mtime(review) <= R) console.log('\n没有新的任务回报或评审。');
}

// The executor slots the main agent chose for its goal. Checked against the harness limit of the session it most
// likely belongs to (the most recently active one).
function slots() {
  const n = Number(rest[0]);
  if (!Number.isInteger(n) || n < 1) fail('用法：slots <N> <理由>，N 是同时在跑的执行子代理数（不含后台评审）');
  const why = rest.slice(1).join(' ').trim();
  ensureDir(root);
  fs.writeFileSync(path.join(dir(root), 'slots'), JSON.stringify({ n, at: iso(now), why }) + '\n');
  log(root, '', 'slots', `${n} ${why}`);
  const ms = sessions(root)[0];
  const codex = ms ? !!goalCache(ms.session_id)?.codex : false;
  const room = harnessLimit(codex, root) - C.RESERVE;
  console.log(`已记下名额 ${n} 个。${n > room ? `注意：${codex ? 'Codex' : 'Claude Code'} 的子代理上限扣掉后台评审和余量后只剩 ${room} 个，超出的会启动失败。` : ''}`);
}

// Ask for a background review or scout now instead of at the hourly turn. Kept in the slot line until the hook
// reserves it, right away or, while one is running, as soon as that one ends.
function request() {
  const type = rest[0];
  if (type !== 'review' && type !== 'scout') fail('用法：request review|scout');
  const r = locked(root, s => { writeSlot(root, { ...s.kv, want: type, wantAt: iso(now) }); return s.state; }, 50);
  if (r === undefined) busy();
  log(root, '', 'requested', type);
  console.log(r === 'running'
    ? '已记下请求。现在有一轮后台评审/侦察在跑，它结束后，你的下一次工具调用时 hook 会登记。'
    : '已记下请求。你下一次调用工具时 hook 会登记，照提醒在后台启动。');
}

function spawned() {
  const start = rest[0] || fail('缺少开始时间');
  const r = locked(root, s => {
    if (s.state !== 'running' || s.kv.start !== start) return 'gone';
    const at = s.spawned ? s.spawnedAt : now;
    if (!s.spawned) writeSlot(root, { ...s.kv, spawned: iso(now) });
    return at + limitOf(s.type);
  }, 50);
  if (r === 'gone') fail('这一轮已作废、已完成或不是这个开始时间：不要继续，也不要写任何文件，直接结束。', EXIT_GONE);
  if (r === undefined) busy();
  log(root, '', 'spawned', start);
  console.log(`已标记启动。限时到 ${clock(r)}（${iso(r)}），超过就会作废。`);
}

function finish() {
  const [start, file] = rest;
  if (!start || !file) fail('用法：finish <start> <file|->');
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : read(file);
  if (!text.trim()) fail('报告是空的。');
  const r = locked(root, s => {
    if (s.state !== 'running' || s.kv.start !== start) return 'gone';
    if (s.spawned && now > s.spawnedAt + limitOf(s.type) + C.GRACE) {
      writeSlot(root, { ...s.kv, state: 'aborted', end: iso(now) });
      return 'gone';
    }
    const stamp = start.replace(/[-:]/g, '').slice(0, 13); // 20261016T0812
    let out;
    if (s.type === 'scout') {
      out = path.join(dir(root), 'tasks', `scout-${stamp}`, 'report.md');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text.trim() + '\n');
    } else {
      out = path.join(dir(root), 'route-review.md');
      const body = `<!-- route-review start=${start} end=${iso(now)} -->\n${text.trim()}\n`;
      fs.mkdirSync(path.join(dir(root), 'reviews'), { recursive: true });
      fs.writeFileSync(path.join(dir(root), 'reviews', `${stamp}.md`), body);
      fs.writeFileSync(out, body);
    }
    writeSlot(root, { ...s.kv, state: 'done', end: iso(now) });
    return out;
  }, 50);
  if (r === 'gone') fail('这一轮已作废、超时或已被替换：报告没有写入，直接结束，不要再写任何文件。', EXIT_GONE);
  if (r === undefined) busy();
  log(root, '', 'finished', start);
  console.log(`已交付：${r}`);
}

// The progress desk passes on what the user said, addressed to the most recently active session whose goal the hook
// last saw active; the hook hands it over at that session's next tool call.
function tell() {
  const text = (rest[0] === '-' ? fs.readFileSync(0, 'utf8') : rest.join(' ')).trim().replace(/\s*\n\s*/g, ' ');
  if (!text) fail('用法：tell <用户的原话>（或 tell - 从标准输入读）');
  const target = sessions(root).find(s => goalCache(s.session_id)?.active);
  if (!target) fail('没有找到目标还在进行的主会话（目标可能已结束或暂停），转达不了：请用户直接在主会话里说。', EXIT_GONE);
  const line = JSON.stringify({ at: iso(now), to: target.session_id, text }) + '\n';
  if (!locked(root, () => { fs.appendFileSync(path.join(dir(root), 'user-inbox.jsonl'), line); return true; }, 50)) busy();
  log(root, '', 'tell', text);
  const idle = Math.round((now - target.active) / 60e3);
  console.log(`已放进转达箱，交给目标是「${clip(target.goal, 40)}」的主会话：它下一次调用工具时会收到，送达后 .retro/log.tsv 里会出现 told 事件。${idle >= 10 ? `注意：这个会话已经 ${idle} 分钟没有活动，可能在长时间等待，也可能卡住了。` : ''}`);
}

function abort() {
  const start = rest[0] || fail('缺少开始时间');
  const r = locked(root, s => {
    if (s.state !== 'running' || s.kv.start !== start) return 'gone';
    writeSlot(root, { ...s.kv, state: 'aborted', spawned: null, end: iso(now) });
    return 'ok';
  }, 50);
  if (r === undefined) busy();
  if (r !== 'ok') fail('这一轮已经不是 running 状态，不用处理。', EXIT_GONE);
  log(root, '', 'aborted', start);
  console.log('已释放这一轮。');
}

function status() {
  const all = sessions(root);
  const out = [`# 进度快照（${new Date(now).toLocaleString('zh-CN', { hour12: false })}，项目 ${root}）`];
  if (!all.length) out.push('没有记录到在这个项目里跑 /goal 的会话。');
  if (all.length > 1) out.push(`有 ${all.length} 个会话在这里设过 /goal：${all.map(s => `「${clip(s.goal, 40)}」（最后活动 ${ago(s.active)}）`).join('；')}。下面看最近活动的那个。`);
  const ms = all[0] || {};
  if (ms.goal) out.push(`目标：${ms.goal}（开始于 ${ago(Date.parse(ms.goal_start))}）`);
  const cache = ms.session_id ? goalCache(ms.session_id) : null;
  if (cache) out.push(`目标状态：hook 最后一次看到时${cache.active ? '进行中' : '已结束或暂停'}。`);
  if (ms.transcript_path) out.push(...mainAgent(ms.transcript_path), ...subagents(ms));
  const start = Date.parse(ms.goal_start) || 0;
  out.push(`\n## 检查点和名额\n上次检查点：${ago(lastRetro(root))}`);
  const set = readSlots(root);
  out.push(`名额：${set && set.at >= start ? `${set.n} 个（${set.why || '没写理由'}，记于 ${ago(set.at)}）` : '这个目标还没记下'}`);
  // From the hook's subagent tracker: executors of this goal, running ones first.
  const { agents, running } = ms.session_id ? goalAgents(ms.session_id, start, now) : { agents: [], running: [] };
  const mins = t => Math.round((now - t) / 60e3);
  const state = a => running.includes(a) ? `在跑，这一段 ${mins(a.seg)} 分钟${now - a.last >= C.SILENT ? `，${mins(a.last)} 分钟没有调用工具` : ''}` : a.active ? `${mins(a.last)} 分钟没有动静，可能已被停掉` : `已交回（${clock(a.stopAt)}）`;
  if (agents.length) out.push(`执行子代理（hook 记录，在跑 ${running.length} 个）：${[...running, ...agents.filter(a => !running.includes(a)).sort((a, b) => b.last - a.last).slice(0, 5)].map(a => `${agentName(a)}（${state(a)}）`).join('；')}`);
  const s = readSlot(root);
  const kind = { review: '路线评审', scout: '全局侦察', stall: '停滞提醒' }[s.type] || s.type;
  out.push(`后台评审：${s.state === 'none' ? '还没用过' : `${kind} ${s.state}，登记于 ${ago(s.start)}${s.spawned ? `，启动于 ${ago(s.spawnedAt)}` : ''}`}${s.kv.want ? `；已请求一次${s.kv.want === 'scout' ? '侦察' : '评审'}` : ''}`);
  const reps = reports(root);
  out.push(`\n## 任务回报（${reps.length} 份，最近 8 份）`);
  for (const r of reps.slice(0, 8)) out.push(`- ${r.task}（${ago(r.mtime)}）：${firstLine(read(r.file))}`);
  for (const f of [path.join(dir(root), 'results.tsv'), path.join(root, 'results.tsv')]) {
    if (!mtime(f)) continue;
    const rows = read(f).split('\n').filter(Boolean);
    out.push(`\n## 总表 ${path.relative(root, f)}（${rows.length} 行，更新于 ${ago(mtime(f))}）\n${[rows[0], ...rows.slice(-3)].join('\n')}`);
  }
  const progress = read(path.join(root, 'PROGRESS.md'));
  if (progress) out.push(`\n## PROGRESS.md（更新于 ${ago(mtime(path.join(root, 'PROGRESS.md')))}，前 20 行）\n${progress.split('\n').slice(0, 20).join('\n')}`);
  const events = read(path.join(dir(root), 'log.tsv')).split('\n').filter(Boolean).slice(-8);
  if (events.length) out.push(`\n## 最近事件\n${events.join('\n')}`);
  console.log(out.join('\n'));
}

// Recent activity of the main agent, from the tail of its transcript (Claude Code or Codex format).
function mainAgent(transcript) {
  if (!mtime(transcript)) return [`主会话记录找不到：${transcript}`];
  const texts = [], tools = [];
  let user = '';
  for (const o of tail(transcript, 3e6)) {
    const at = `[${clock(Date.parse(o.timestamp))}] `;
    if (o.type === 'response_item') { // Codex
      const p = o.payload || {};
      const said = (p.content || []).filter(b => /^(output|input)_text$/.test(b.type)).map(b => b.text).join(' ');
      if (p.type === 'message' && p.role === 'assistant' && said.trim()) texts.push(at + clip(said, 300));
      if (p.type === 'message' && p.role === 'user' && said.trim() && !/^\s*(<|# AGENTS\.md)/.test(said)) user = at + clip(said, 200);
      if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        const raw = String(p.input ?? p.arguments ?? '');
        const cmd = raw.match(/\bcmd\W{0,3}:\s*\\?"((?:[^"\\]|\\.)*)/)?.[1];
        tools.push(`${p.name}（${clip(cmd ?? raw, 60)}）`);
      }
      continue;
    }
    const c = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) texts.push(at + clip(b.text, 300));
        if (b.type === 'tool_use') tools.push(`${b.name}${describe(b.input)}`);
      }
    }
    if (o.type === 'user' && !o.isMeta) {
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
      if (t.trim() && !t.trim().startsWith('<')) user = at + clip(t, 200);
    }
  }
  return [
    `\n## 主 agent（最后活动 ${ago(lastWrite(transcript))}）`,
    user && `用户最后说：${user}`,
    `最近的话：\n${texts.slice(-3).join('\n') || '（无）'}`,
    `最近的工具调用：${tools.slice(-8).join('；') || '（无）'}`,
  ].filter(Boolean);
}

// Subagents of the main session. Claude Code keeps them in <transcript>/subagents/agent-*.jsonl with a .meta.json.
// Codex writes each as its own rollout in sessions/YYYY/MM/DD (local date) whose first record names the parent
// thread; a resumed thread's children can be months after its own rollout, so look from the day before the goal
// started (at most a week back) to today. Codex's approval reviewers (guardians) also name the parent; skip them.
function subagents({ transcript_path: transcript, session_id: sessionId, goal_start }) {
  let list = [];
  if (/[\\/]\.codex[\\/]/.test(transcript)) {
    const base = path.resolve(path.dirname(transcript), '..', '..', '..');
    const day = new Date(Math.max(Date.parse(goal_start) || now, now - 7 * 864e5) - 864e5);
    day.setHours(0, 0, 0, 0);
    for (; day.getTime() <= now; day.setDate(day.getDate() + 1)) {
      const d = path.join(base, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      let names = [];
      try { names = fs.readdirSync(d).filter(f => f.endsWith('.jsonl')); } catch {}
      for (const n of names) {
        const f = path.join(d, n), head = headOf(f, 8192);
        if (!head.includes('"thread_spawn"') || !head.includes(`"parent_thread_id":"${sessionId}"`)) continue;
        const pick = k => head.match(new RegExp(`"${k}":"([^"]*)"`))?.[1];
        list.push({ f, t: lastWrite(f), name: path.basename(pick('agent_path') || n), type: pick('agent_role') || '?' });
      }
    }
  } else {
    const d = transcript.replace(/\.jsonl$/, '') + path.sep + 'subagents';
    let files = [];
    try { files = fs.readdirSync(d).filter(f => /^agent-.*\.jsonl$/.test(f)); } catch {}
    list = files.map(n => {
      const f = path.join(d, n);
      let meta = {};
      try { meta = JSON.parse(read(f.replace(/\.jsonl$/, '.meta.json'))); } catch {}
      return { f, t: mtime(f), name: meta.description || n, type: meta.agentType || '?', stopped: meta.stoppedByUser };
    });
  }
  if (!list.length) return [];
  list = list.sort((a, b) => b.t - a.t).slice(0, 6);
  const out = [`\n## 子代理（最近活动的 ${list.length} 个）`];
  for (const { f, t, name, type, stopped } of list) {
    let last = '';
    for (const o of tail(f, 4e5)) {
      const c = o.type === 'assistant' ? o.message?.content : o.type === 'response_item' && o.payload?.role === 'assistant' ? o.payload.content : null;
      for (const b of Array.isArray(c) ? c : []) if (/^(text|output_text)$/.test(b.type) && b.text.trim()) last = b.text;
    }
    const state = now - t < 3 * 60e3 ? '活动中' : `最后活动 ${ago(t)}`;
    out.push(`- ${name}（${type}，${state}${stopped ? '，被停止' : ''}）：${clip(last, 200) || '（还没有输出）'}`);
  }
  return out;
}

function tail(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (n < size) lines.shift(); // partial first line
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function describe(input = {}) {
  const d = input.description || input.command || input.file_path || input.pattern || input.prompt || '';
  return d ? `（${clip(String(d), 60)}）` : '';
}
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function firstLine(s) { return clip(s.split('\n').find(l => l.trim() && !l.startsWith('<!--')) || '', 160); }
