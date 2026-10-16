#!/usr/bin/env node
// Helper CLI for retro. Every command takes --root <project>; the hook's messages always pass it. Without it the
// project is CLAUDE_PROJECT_DIR, else the nearest directory up from here holding .retro/, else the current directory;
// inside a git worktree, the same place in the main checkout (so worktrees share one .retro/). Exit codes: 2 = slot
// voided/replaced, 3 = busy.
//   done                   mark a retro finished (stops the retro nudges until the next one is due)
//   inbox                  what came back since the last retro: task reports, the latest review, ledger rows
//   spawned <start>        a review/scout subagent marks itself started and learns its deadline
//   finish <start> <file>  a review/scout subagent hands in its report (file, or - for stdin)
//   abort <start>          the main agent couldn't start the subagent; frees the slot
//   status                 progress digest for the progress desk (read-only)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  C, EXIT_BUSY, EXIT_GONE, dir, ensureDir, iso, lastRetro, limitOf, locked, log, mainCheckout, mtime, openIdeas, read,
  readSlot, reports, sessions, writeSlot,
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

const commands = { done, inbox, spawned, finish, abort, status, root: () => console.log(root) };
if (!commands[cmd]) fail('用法：node retro.mjs <done|inbox|spawned <start>|finish <start> <file>|abort <start>|status> [--root <项目>]');
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
  log(root, '', 'retro-done', '');
  const size = mtime(path.join(root, 'PROGRESS.md')) ? fs.statSync(path.join(root, 'PROGRESS.md')).size : 0;
  const open = openIdeas(root);
  const out = [`已记录复盘（${clock(now)}）。下次复盘：60 分钟后，或交回 ${C.RETRO_RESULTS} 个结果，或主会话 ${C.RETRO_CALLS} 次工具调用。`];
  if (!size) out.push(`${root} 下还没有 PROGRESS.md。`);
  else if (size > C.PROGRESS_MAX) out.push(`PROGRESS.md 有 ${(size / 1024).toFixed(1)} KB，超过 4 KB，请压缩。`);
  out.push(open === null ? '还没有想法池 .retro/ideas.md。' : `想法池里未验证的想法 ${open} 条${open < C.OPEN_IDEAS_MIN ? '，偏少' : ''}。`);
  console.log(out.join(''));
}

function inbox() {
  // Since the last retro, or since the goal of the session running it (the most recently active one) started.
  const R = Math.max(lastRetro(root), Date.parse(sessions(root)[0]?.goal_start) || 0);
  console.log(`# 上次复盘以来交回的内容（上次复盘：${ago(lastRetro(root))}）`);
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
  if (ms.transcript_path) out.push(...mainAgent(ms.transcript_path), ...subagents(ms.transcript_path));
  const R = lastRetro(root);
  const sid = String(ms.session_id || '').replace(/[^\w-]/g, '_');
  const lines = read(path.join(os.tmpdir(), `claude-retro-${sid}.log`)).split('\n').filter(Boolean);
  const after = Math.max(R, Date.parse(ms.goal_start) || 0);
  const isResult = l => / r( |$)/.test(l);
  const calls = lines.filter(l => !isResult(l) && parseInt(l, 10) > after).length;
  const back = new Set(lines.filter(l => isResult(l) && parseInt(l, 10) > after).map(l => l.split(' ')[3] || l)).size;
  out.push(`\n## 复盘\n上次：${ago(R)}；之后主会话 ${calls} 次工具调用，交回 ${back} 个子代理结果。`);
  const s = readSlot(root);
  const kind = { review: '路线评审', scout: '全局侦察', stall: '停滞提醒' }[s.type] || s.type;
  out.push(`后台名额：${s.state === 'none' ? '还没用过' : `${kind} ${s.state}，登记于 ${ago(s.start)}${s.spawned ? `，启动于 ${ago(s.spawnedAt)}` : ''}`}`);
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

// Recent activity of the main agent, from the tail of its transcript (Claude Code format).
function mainAgent(transcript) {
  if (!mtime(transcript)) return [`主会话记录找不到：${transcript}`];
  if (/[\\/]\.codex[\\/]/.test(transcript)) return [`主会话是 Codex，记录摘要暂不支持；记录在 ${transcript}`];
  const texts = [], tools = [];
  let user = '';
  for (const o of tail(transcript, 3e6)) {
    const c = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) texts.push(`[${clock(Date.parse(o.timestamp))}] ${clip(b.text, 300)}`);
        if (b.type === 'tool_use') tools.push(`${b.name}${describe(b.input)}`);
      }
    }
    if (o.type === 'user' && !o.isMeta) {
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
      if (t.trim() && !t.trim().startsWith('<')) user = `[${clock(Date.parse(o.timestamp))}] ${clip(t, 200)}`;
    }
  }
  return [
    `\n## 主 agent（最后活动 ${ago(mtime(transcript))}）`,
    user && `用户最后说：${user}`,
    `最近的话：\n${texts.slice(-3).join('\n') || '（无）'}`,
    `最近的工具调用：${tools.slice(-8).join('；') || '（无）'}`,
  ].filter(Boolean);
}

function subagents(transcript) {
  const d = transcript.replace(/\.jsonl$/, '') + path.sep + 'subagents';
  let files = [];
  try { files = fs.readdirSync(d).filter(f => /^agent-.*\.jsonl$/.test(f)); } catch { return []; }
  const list = files.map(f => ({ f: path.join(d, f), t: mtime(path.join(d, f)) })).sort((a, b) => b.t - a.t).slice(0, 6);
  const out = [`\n## 子代理（最近活动的 ${list.length} 个）`];
  for (const { f, t } of list) {
    let meta = {};
    try { meta = JSON.parse(read(f.replace(/\.jsonl$/, '.meta.json'))); } catch {}
    let last = '';
    for (const o of tail(f, 4e5)) {
      if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) if (b.type === 'text' && b.text.trim()) last = b.text;
      }
    }
    const state = now - t < 3 * 60e3 ? '活动中' : `最后活动 ${ago(t)}`;
    out.push(`- ${meta.description || path.basename(f)}（${meta.agentType || '?'}，${state}${meta.stoppedByUser ? '，被停止' : ''}）：${clip(last, 200) || '（还没有输出）'}`);
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
