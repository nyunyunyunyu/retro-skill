#!/usr/bin/env node
// Helper CLI for retro. Every command takes --root <project>; the hook's messages always pass it. Without it the
// project is CLAUDE_PROJECT_DIR, else the nearest directory up from here holding .retro/, else the current directory;
// inside a git worktree, the same place in the main checkout (so worktrees share one .retro/). Exit codes: 2 = slot
// voided/replaced, 3 = busy.
//   done                   mark a checkpoint finished; the next is due 60 min later, once something came back. Its
//                          window starts where this checkpoint's inbox looked, so reports landing meanwhile count next time
//   inbox [--since-last review|scout]   what came back since the last checkpoint (or since the previous route
//                          review / scout started, for the background agents): task reports, the latest review, ledger rows
//   slots <n> [why]        the main agent records its executor slots for the goal; the hook checks for idle ones
//   request review|scout   ask for a background review/scout now; the hook reserves it at the next tool call
//   spawned <start>        a review/scout subagent marks itself started and learns its deadline
//   finish <start> <file>  a review/scout subagent hands in its report (file, or - for stdin)
//   abort <start>          the main agent couldn't start the subagent; frees the slot
//   status                 progress digest for the progress desk (read-only)
//   metrics [--since <ISO>]   process metrics since the goal started, for analysis after a run (read-only)
//   tell <text>            the progress desk passes on what the user said; delivered at the main agent's next tool call
//   watch [--session <id>] runs in the background (Claude Code) and exits, waking the main agent, when an executor is
//                          silent, stuck or past its hour (the hook then says what to do), when the goal stops, or when
//                          nothing has run for a while. One per session; default the latest one
//   worker start <id> [desc] [--pid <n>] [--type <t>] | beat <id> | stop <id>
//                          a driver registers an executor another harness runs (codex-worker.mjs does this itself), so
//                          the hook counts it in the slots and the checkpoint sees it hand back. --pid: the driver's
//                          process; when it is gone the worker counts as stopped (without one: silent for an hour)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  C, EXIT_BUSY, EXIT_GONE, WATCH_TICK, activity, agentName, alive, dir, ensureDir, executorNotes, goalAgents, goalCache,
  harnessLimit, headOf, iso, lastRetro, lastWrite, limitOf, locked, log, mainCheckout, mtime, openIdeas, read, readSlot,
  readSlots, reports, safe, sessions, tailRecords, timedTools, watchFile, workerBeat, workerStart, workerStop, writeSlot,
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

const commands = { done, inbox, slots, request, spawned, finish, abort, status, metrics, tell, watch, worker, root: () => console.log(root) };
if (!commands[cmd]) fail('用法：node retro.mjs <done|inbox [--since-last review|scout]|slots <N> <理由>|request review|scout|spawned <start>|finish <start> <file>|abort <start>|status|metrics [--since <ISO>]|tell <话>|watch [--session <id>]|worker start|beat|stop <id>> [--root <项目>]');
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
  const looked = Date.parse(read(path.join(dir(root), 'inbox-at')).trim()) || 0;
  fs.writeFileSync(path.join(dir(root), 'retro-done'), iso(looked > lastRetro(root) ? Math.min(looked, now) : now) + '\n');
  log(root, '', 'checkpoint-done', rest.join(' ').trim());
  log(root, '', 'snapshot', snapshot());
  const size = mtime(path.join(root, 'PROGRESS.md')) ? fs.statSync(path.join(root, 'PROGRESS.md')).size : 0;
  const open = openIdeas(root);
  const out = [`已记录检查点（${clock(now)}）。下一个最早在 60 分钟后，期间有新结果才会提醒。`];
  if (!/抽查/.test(rest.join(' '))) out.push('这次没有写抽查结果：下次检查点记得抽查一份回报，用 done "抽查 <任务>：一致" 记下。');
  if (!size) out.push(`${root} 下还没有 PROGRESS.md。`);
  else if (size > C.PROGRESS_MAX) out.push(`PROGRESS.md 有 ${(size / 1024).toFixed(1)} KB，超过 4 KB，请压缩。`);
  out.push(open === null ? '还没有想法池 .retro/ideas.md。' : `想法池里未验证的想法 ${open} 条${open < C.OPEN_IDEAS_MIN ? '，偏少' : ''}。`);
  console.log(out.join(''));
}

function inbox() {
  // Since the last checkpoint, or since the goal of the session running it (the most recently active one) started.
  // A background agent asks for everything since its previous round, which the last checkpoint may have cut short.
  const review = path.join(dir(root), 'route-review.md');
  const si = rest.indexOf('--since-last'), kind = si >= 0 ? rest[si + 1] : null;
  if (si >= 0 && kind !== 'review' && kind !== 'scout') fail('用法：inbox [--since-last review|scout]');
  // From when the previous round started, since it read its inbox then.
  const scoutStart = r => Date.parse(r.task.slice(6).replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)$/, '$1-$2-$3T$4:$5:00Z')) || r.mtime;
  const from = kind === 'review' ? Date.parse(read(review).match(/<!-- route-review start=(\S+)/)?.[1]) || mtime(review)
    : kind === 'scout' ? Math.max(0, ...reports(root).filter(r => r.scout).map(scoutStart))
    : lastRetro(root);
  const R = Math.max(from, Date.parse(sessions(root)[0]?.goal_start) || 0);
  if (!kind) { ensureDir(root); fs.writeFileSync(path.join(dir(root), 'inbox-at'), iso(now) + '\n'); }
  console.log(`# ${{ review: '上次路线评审', scout: '上次侦察' }[kind] || '上次检查点'}以来交回的内容（从 ${ago(R)} 起）`);
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
  const room = harnessLimit(codex, root);
  console.log(`已记下名额 ${n} 个。这是并发计划，不要求填满；后台评审也计入平台容量。${n > room ? `注意：${codex ? 'Codex' : 'Claude Code'} 的子代理上限是 ${room} 个，超出的会启动失败。` : ''}`);
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

// What the idea pool, backlog and PROGRESS.md look like at a checkpoint, for metrics later (they get rewritten).
function snapshot() {
  const ideas = read(path.join(dir(root), 'ideas.md'));
  const dead = (ideas.split(/^#{2,}\s*死路.*$/m)[1] || '').split(/^#{1,}\s/m)[0].split(/\r?\n/).filter(l => /^[-*]\s/.test(l));
  const backlog = read(path.join(dir(root), 'backlog.md')).split('\n').filter(l => /^\s*[-*]\s/.test(l)).length;
  const size = mtime(path.join(root, 'PROGRESS.md')) ? fs.statSync(path.join(root, 'PROGRESS.md')).size : 0;
  return `想法 ${openIdeas(root) ?? 0} 死路 ${dead.length} 可疑 ${dead.filter(l => /可疑/.test(l)).length} 积压 ${backlog} PROGRESS ${(size / 1024).toFixed(1)}KB`;
}

// Process metrics since the goal started, from log.tsv, the review archive and the task reports. What needs judgment
// (were decisions overturned, did briefs need clarifying) is left to whoever reads this.
function metrics() {
  // From the earliest start of this goal across its sessions; to now while it runs, else to the last event.
  const all = sessions(root), ms = all[0];
  const starts = all.filter(s => ms && s.goal === ms.goal).map(s => Date.parse(s.goal_start)).filter(Boolean);
  const si = rest.indexOf('--since');
  const since = (si >= 0 && Date.parse(rest[si + 1])) || (starts.length ? Math.min(...starts) : 0);
  const rows = read(path.join(dir(root), 'log.tsv')).split('\n').filter(Boolean)
    .map(l => { const [t, s, ev, d = ''] = l.split('\t'); return { t: Date.parse(t), s, ev, d }; })
    .filter(r => r.t >= since).sort((a, b) => a.t - b.t);
  const live = !!(ms && goalCache(ms.session_id)?.active);
  const end = live ? now : rows.at(-1)?.t || now;
  // Labels as agents write them: plain, bold, bulleted; full-width or ASCII colon.
  const label = name => `\\**${name}\\**\\s*[：:]\\s*\\**\\s*`;
  const has = (t, re) => new RegExp(re, 'm').test(t);
  const count = ev => rows.filter(r => r.ev === ev).length;
  const min = ms => Math.round(ms / 60e3);
  const stats = xs => (xs.length ? `平均 ${min(xs.reduce((a, b) => a + b, 0) / xs.length)} 分钟，最长 ${min(Math.max(...xs))} 分钟` : '无数据');
  const tally = (texts, re) => {
    const m = {};
    for (const t of texts) { const v = t.match(re)?.[1] || '没写'; m[v] = (m[v] || 0) + 1; }
    return Object.entries(m).map(([k, v]) => `${k} ${v}`).join('，') || '无';
  };
  const out = [`# 运行指标（${since ? new Date(since).toLocaleString('zh-CN', { hour12: false }) : '日志开头'} 起，到 ${new Date(end).toLocaleString('zh-CN', { hour12: false })}${live ? '，目标还在进行' : ''}）`];

  const lag = [];
  let due = null;
  for (const r of rows) {
    if (r.ev === 'checkpoint-due' && due === null) due = r.t;
    if (r.ev === 'checkpoint-done') { if (due !== null) lag.push(r.t - due); due = null; }
  }
  const checks = rows.filter(r => r.ev === 'checkpoint-done' && /抽查/.test(r.d));
  out.push(`\n## 检查点\n完成 ${count('checkpoint-done')} 次；从提醒到完成 ${stats(lag)}${due !== null && live ? '；现在有一个到期还没做' : ''}。抽查 ${checks.length} 次，不一致 ${checks.filter(r => /抽查[^：:]*[：:]\s*不一致/.test(r.d)).length} 次。`);

  const reserved = rows.filter(r => r.ev === 'slot-reserved');
  const startLag = reserved.map(r => rows.find(x => x.ev === 'spawned' && x.d === r.d.split(' ')[1])?.t - r.t).filter(x => x >= 0);
  const reviews = (() => { try { return fs.readdirSync(path.join(dir(root), 'reviews')); } catch { return []; } })()
    .map(n => read(path.join(dir(root), 'reviews', n)))
    .filter(t => (Date.parse(t.match(/start=(\S+)/)?.[1]) || 0) >= since);
  out.push(`\n## 后台评审\n登记 ${reserved.length} 次（评审 ${reserved.filter(r => r.d.startsWith('review')).length}，侦察 ${reserved.filter(r => r.d.startsWith('scout')).length}，按请求 ${reserved.filter(r => /requested/.test(r.d)).length}）；启动 ${count('spawned')}，交付 ${count('finished')}，放弃 ${count('aborted')}，超时作废 ${rows.filter(r => /^slot-(timeout|unlaunched|stale)$/.test(r.ev)).length}；从登记到启动 ${stats(startLag)}。停滞 ${count('stall')} 次。`);
  out.push(`路线评审存档 ${reviews.length} 份。结论：${tally(reviews, new RegExp(label('结论') + '(保持|调整优先级|先探测|换路线)'))}。上轮建议：${tally(reviews, new RegExp(label('上轮建议') + '(部分采纳|未采纳|采纳|未记录)'))}。判断依据有意见的 ${reviews.filter(t => has(t, label('判断依据') + '(?![（(]?无)[^\\s*]')).length} 份。`);

  const segs = [];
  for (const r of rows.filter(x => x.ev === 'agent-start')) {
    const id = r.d.split(' ')[0];
    const end = rows.find(x => x.t >= r.t && x !== r && x.d.split(' ')[0] === id && (x.ev === 'agent-stop' || x.ev === 'agent-start'));
    segs.push({ id, s: r.t, e: end?.ev === 'agent-stop' ? end.t : null });
  }
  const done = segs.filter(g => g.e !== null);
  const lines = [`\n## 执行子代理\n${segs.length} 段，${new Set(segs.map(g => g.id)).size} 个子代理；交回的 ${done.length} 段 ${stats(done.map(g => g.e - g.s))}${segs.length > done.length ? `；${segs.length - done.length} 段没有交回记录，不计入下面的利用率` : ''}。`];
  const slotRows = rows.filter(r => r.ev === 'slots');
  if (slotRows.length) {
    const t0 = slotRows[0].t, points = [...new Set([t0, end, ...done.flatMap(g => [g.s, g.e]), ...slotRows.map(r => r.t)])].filter(t => t >= t0 && t <= end).sort((a, b) => a - b);
    let used = 0, cap = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], span = points[i + 1] - a;
      const n = Number(slotRows.filter(r => r.t <= a).at(-1).d.split(' ')[0]) || 0;
      used += span * done.filter(g => g.s <= a && g.e > a).length;
      cap += span * n;
    }
    lines.push(`名额利用率（交回的段在跑的时间 ÷ 名额 × 时间）：${cap ? Math.round(100 * used / cap) : 0}%。`);
  }
  out.push(lines.join(''));

  const texts = reports(root).filter(r => !r.scout && r.mtime >= since).map(r => read(r.file));
  out.push(`\n## 任务回报\n${texts.length} 份；标“推翻前提”的 ${texts.filter(t => has(t, '(^|[：:])\\s*([-*]\\s+)?\\**推翻前提\\**\\s*[：:—-]')).length} 份；核实：一致 ${texts.filter(t => has(t, label('核实') + '一致')).length}，不一致 ${texts.filter(t => has(t, label('核实') + '不一致')).length}。`);

  const snaps = rows.filter(r => r.ev === 'snapshot');
  if (snaps.length) out.push(`\n## 想法池和积压（检查点时的快照）\n第一次：${snaps[0].d}\n最近一次：${snaps.at(-1).d}`);
  out.push('\n## 需要判断的\n主 agent 的决定被推翻了几次、任务说明是否要反复澄清、PROGRESS.md 是否和实际一致：派一个子代理读这份输出、.retro/reviews/、任务回报和 git log 来判断。');
  console.log(out.join('\n'));
}

function spawned() {
  const start = rest[0] || fail('缺少开始时间');
  const r = locked(root, s => {
    if (s.state !== 'running' || s.kv.start !== start) return 'gone';
    const at = s.spawned ? s.spawnedAt : now;
    if (!s.spawned) writeSlot(root, { ...s.kv, spawned: iso(now) });
    return { end: at + limitOf(s.type), type: s.type };
  }, 50);
  if (r === 'gone') fail('这一轮已作废、已完成或不是这个开始时间：不要继续，也不要写任何文件，直接结束。', EXIT_GONE);
  if (r === undefined) busy();
  log(root, '', 'spawned', start);
  const notes = path.join(dir(root), 'probes', `${r.type}-${start.replace(/[-:]/g, '').slice(0, 13)}`, 'notes.md');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  console.log(`已标记启动。限时到 ${clock(r.end)}（${iso(r.end)}），超过就会作废。细节边做边写进 ${notes.replace(/\\/g, '/')}。`);
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

// Polls the tracker until an executor needs the main agent (lib executorNotes), then exits: Claude Code delivers a
// background command's exit as a new turn, the one way to wake a main agent that ended its turn. It shows the main
// agent only that the command ended, not its output, so the hook says what to consider at the next tool event.
async function watch() {
  const si = rest.indexOf('--session'), want = si >= 0 ? rest[si + 1] : null;
  const all = sessions(root), s = want ? all.find(x => x.session_id === want) : all[0];
  if (!s) fail(want ? `这个项目里没有会话 ${want} 的记录。` : '没有记录到在这个项目里跑 /goal 的会话。');
  const sid = s.session_id, file = watchFile(sid);
  const scripts = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/'), at = `--root "${root.replace(/\\/g, '/')}"`;
  const wcmd = sub => `\`node "${scripts}/codex-worker.mjs" ${sub} ${at}\``;
  let out, missing = 0;
  for (;;) {
    const t = Date.now(), holder = Number(read(file)) || 0;
    if (holder && holder !== process.pid && alive(holder) && t - mtime(file) < 3 * WATCH_TICK) { out = `已经有一个 watch 在跑（进程 ${holder}），这个退出，不用再开。`; break; }
    fs.writeFileSync(file, String(process.pid));
    // The hook rewrites the cache at every main-agent event: one caught mid-write reads as null.
    const cache = goalCache(sid);
    if (cache && !cache.active) { out = '目标已经结束或暂停，watch 退出。'; break; }
    missing = cache ? 0 : missing + 1;
    if (missing > 3) { out = '读不到这个会话的目标状态，watch 退出。'; break; }
    const { running } = cache ? goalAgents(sid, cache.start, t, root) : { running: [] };
    const due = cache ? executorNotes(running, { now: t, sessionId: sid, root, codex: !!cache.codex, wcmd, wake: true }) : [];
    if (due.length) {
      out = `有执行者要处理：${[...new Set(due.map(n => n.who))].join('、')}。运行 retro.mjs status 查看现场；下一次工具事件中 hook 会说明待判断的事项。`;
      break;
    }
    // A new executor shows up only at its first tool call.
    const launch = Number(read(file.replace(/\.watch$/, '.launch'))) || 0;
    if (cache && !running.length && t - launch >= C.IDLE_GRACE) { out = '没有在跑的执行者了，watch 退出。下次派了任务、结束这一轮之前再开。'; break; }
    await new Promise(r => setTimeout(r, WATCH_TICK));
  }
  try { if (Number(read(file)) === process.pid) fs.unlinkSync(file); } catch {}
  console.log(out);
}

function worker() {
  const flag = name => { const i = rest.indexOf(name); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  const pid = Number(flag('--pid')) || null, type = flag('--type') || 'external';
  const [sub, id, ...desc] = rest;
  if (!id || safe(id) !== id) fail('用法：node retro.mjs worker start <id> [说明] [--pid <驱动进程>] [--type <类型>] | beat <id> | stop <id>（id 只用字母、数字、_ 和 -）');
  if (sub === 'start') { workerStart(root, id, { desc: desc.join(' '), type, pid }); console.log(`已登记 ${id}。`); }
  else if (sub === 'beat') { if (!workerBeat(root, id)) fail(`${id} 没有登记或已经停了。`); }
  else if (sub === 'stop') console.log(workerStop(root, id) ? `已记下 ${id} 停了。` : `${id} 没有登记或已经停了。`);
  else fail('用法：worker start|beat|stop <id>');
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
  const { agents, running } = goalAgents(ms.session_id || '-', start, now, root);
  const mins = t => Math.round((now - t) / 60e3);
  const run = a => {
    const { last, wait } = activity(a);
    return `在跑，这一段 ${mins(a.seg)} 分钟${wait ? `，${a.worker ? '正在跑命令' : '在等工具调用'}「${clip(wait.name, 80)}」（${mins(wait.at)} 分钟）` : now - last >= C.SILENT ? `，${mins(last)} 分钟没有动静` : ''}`;
  };
  const state = a => (running.includes(a) ? run(a) : a.active ? `${mins(a.last)} 分钟没有动静，可能已被停掉` : a.gone ? `驱动已经不在了（最后动静 ${clock(a.last)}）` : `已交回（${clock(a.stopAt)}）`) + (a.said ? `；最后说：${clip(a.said, 100)}` : '');
  if (agents.length) out.push(`执行者（外部执行者注明类型和任务名；在跑 ${running.length} 个）：${[...running, ...agents.filter(a => !running.includes(a)).sort((a, b) => b.last - a.last).slice(0, 5)].map(a => `${agentName(a)}${a.worker ? `［${a.type} ${a.id}］` : ''}（${state(a)}）`).join('；')}`);
  const slow = timedTools(ms.session_id || '-').filter(t => cache?.active && t.goal === cache.start && (t.ended || now) - t.at >= C.SLOW_TOOL);
  if (slow.length) out.push(`工具耗时：${slow.slice(0, 5).map(t => `${t.agent || '主 agent'} — ${t.name}（${t.ended ? '已返回，用时' : '未见完成记录，启动至今'} ${Math.floor(((t.ended || now) - t.at) / 60e3)} 分钟）`).join('；')}`);
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
  for (const o of tailRecords(transcript, 3e6)) {
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
    for (const o of tailRecords(f, 4e5)) {
      const c = o.type === 'assistant' ? o.message?.content : o.type === 'response_item' && o.payload?.role === 'assistant' ? o.payload.content : null;
      for (const b of Array.isArray(c) ? c : []) if (/^(text|output_text)$/.test(b.type) && b.text.trim()) last = b.text;
    }
    const state = now - t < 3 * 60e3 ? '活动中' : `最后活动 ${ago(t)}`;
    out.push(`- ${name}（${type}，${state}${stopped ? '，被停止' : ''}）：${clip(last, 200) || '（还没有输出）'}`);
  }
  return out;
}

function describe(input = {}) {
  const d = input.description || input.command || input.file_path || input.pattern || input.prompt || '';
  return d ? `（${clip(String(d), 60)}）` : '';
}
function clip(s, n) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function firstLine(s) { return clip(s.split('\n').find(l => l.trim() && !l.startsWith('<!--')) || '', 160); }
