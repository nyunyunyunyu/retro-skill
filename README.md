# retro-skill

A skill for [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex) that makes long-running coding agents periodically step back: rethink the approach, speed up the iteration loop (including the eval code itself, gated by ROI, without over-optimizing), avoid rabbit holes, never sit idle waiting, and keep a bounded `PROGRESS.md`.

让长程 coding agent 定期停下来复盘：路线要不要换、迭代能不能更快（包括加速评测代码本身，按 ROI 决定，避免过度优化）、有没有卡在细节或等待里，并维护一个不会膨胀的 `PROGRESS.md`。支持 Claude Code 和 Codex。

## 包含什么

- **retro skill**：几分钟的快速复盘，结束时只给 3 行决定。
  1. 路线：平台期、修一个坏一个时，换本质不同的路线并做最便宜的验证实验。
  2. 迭代速度：先测量再优化瓶颈；评测代码本身往往是最大杠杆（如 30s CPU → 0.1s GPU），按 `节省 = Δt × 剩余轮数 > 实现时间 × 2` 决定做不做；有明确的停止条件；长时间评测放后台跑，等待期间不空等。
  3. 细节与等待：不在关键路径上的问题记一行“暂缓”，回主线。需要用户授权时不干等：记进“待授权”，提一次，继续做别的，没答复的最多再问两次。
  4. `PROGRESS.md`：快照不是日志，改写不追加，不超过约 60 行。
- **10 分钟定时检查**：skill 让 agent 给自己建一个每 10 分钟的定时任务（Claude Code 用 `CronCreate`，Codex app 用线程定时任务）。agent 空闲等待、没有工具调用时，它会唤醒 agent：处理已完成的后台任务，追问未答复的授权（满 30 分钟、满 2 小时各一次），从“下一步”或“暂缓”里挑不依赖等待项的事做。暂停或完成后它会删掉自己。
- **提醒 hook**（`retro-nudge.mjs`），只在项目根目录有 `PROGRESS.md` 时工作：
  - 复盘必然改写 `PROGRESS.md`，所以用它的修改时间判断上次复盘。超过 40 次工具调用没更新，就提醒复盘，并允许 agent 先做完手头这一步。被忽略的话每 10 次调用再提醒一次，直到 `PROGRESS.md` 更新为止。
  - 复盘欠着的时候，agent 结束这一轮前会被拦一次（Stop hook），在自然断点补上复盘。你按 Esc 打断时不会触发。
  - subagent 的工具调用不计入；Claude Code 的 `/btw` 没有工具，也不触发 Stop；Codex 的 `/side` 是另一个线程，单独计数。

需要 Node.js 在 PATH 上。从旧版升级的话，可以删掉配置里的 `SessionStart` 和 `PostToolUseFailure` 条目（留着也无害，新脚本对它们不输出任何内容）。先克隆：

```bash
git clone https://github.com/nyunyunyunyu/retro-skill
```

## 安装：Claude Code

1. 复制 skill：

   ```bash
   cp -r retro-skill/skills/retro ~/.claude/skills/
   ```

2. 注册 hook：合并进 `~/.claude/settings.json`（保留已有内容）：

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/skills/retro/scripts/retro-nudge.mjs\"", "timeout": 10 }] }
       ],
       "Stop": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/skills/retro/scripts/retro-nudge.mjs\"", "timeout": 10 }] }
       ]
     }
   }
   ```

   Windows 上可以改用 exec 形式，省掉一次 shell 启动：`"command": "node", "args": ["C:/Users/<you>/.claude/skills/retro/scripts/retro-nudge.mjs"]`。

3. （可选）在 `~/.claude/CLAUDE.md` 加下面的[常驻规则](#常驻规则)。

## 安装：Codex

1. 复制 skill：

   ```bash
   mkdir -p ~/.agents/skills && cp -r retro-skill/skills/retro ~/.agents/skills/
   ```

2. 注册 hook：新建或合并进 `~/.codex/hooks.json`：

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.agents/skills/retro/scripts/retro-nudge.mjs\"", "commandWindows": "node C:/Users/<you>/.agents/skills/retro/scripts/retro-nudge.mjs", "timeout": 10 }] }
       ],
       "Stop": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.agents/skills/retro/scripts/retro-nudge.mjs\"", "commandWindows": "node C:/Users/<you>/.agents/skills/retro/scripts/retro-nudge.mjs", "timeout": 10 }] }
       ]
     }
   }
   ```

   然后在 Codex 里运行 `/hooks`，审核并信任这些 hook。Codex 不会运行未经信任的 hook，而且**每次修改 hooks.json 后都要重新信任**。

3. （可选）在 `~/.codex/AGENTS.md` 加下面的[常驻规则](#常驻规则)。

## 命令

第一次调用 retro 会建立 `PROGRESS.md`，之后这个项目的会话都会自动收到复盘提醒。下面的子命令只在明确输入时执行（Codex 里把 `/retro` 换成 `$retro`）：

| 命令 | 作用 |
|---|---|
| `/retro` | 复盘一次 |
| `/retro pause` | 暂停整个项目：`PROGRESS.md` 改名为 `PROGRESS.paused.md`，所有提醒立刻停止，定时检查删掉 |
| `/retro resume` | 恢复：改回 `PROGRESS.md`（没有暂停的文件时，给你看最近一次归档的日期和目标，确认后恢复，等于撤销 `done`），复盘一次，接着干活 |
| `/retro done` | 完成：`PROGRESS.md` 归档为 `PROGRESS.done-日期-时间.md`，提醒和定时检查关闭 |

**任务完成后自动关闭**：agent 确认任务完成时会自己执行 `done`。确认的依据是 Claude Code 的 `/goal` 已判定达成，或者完成标准逐条都有这次会话里的证据，拿不准就不执行。Codex 的 `/goal` 是 agent 自评，所以 Codex 下一律要证据。误判了用 `/retro resume` 撤销。建议把 `PROGRESS.md` 的完成标准原样写进 `/goal`：Claude Code 的 `/goal` 每轮由一个独立的模型判断是否达成，没达成会自动继续干，判断比干活的 agent 自评更可靠。只写 `/goal` 不写 `PROGRESS.md` 不行，hook 只认 `PROGRESS.md`。

只想让某个会话停下：打断它，用自己的话告诉它暂停。它会删掉这个会话的定时检查，暂停期间也不会被复盘提醒带着重新开工，等你说继续再重建，不影响项目里的其他会话。

**用了 `/goal` 的会话**：暂停时还要运行 `/goal clear`（Codex：`/goal pause`）。`/goal` 每轮结束都会判断，没达成就自动开始下一轮，agent 自己清除不了。只按 Esc 打断不受影响。

## 常驻规则

```
- 项目根目录有 PROGRESS.md 时，开始工作前先读它；开始一个长任务时，调用 retro skill。
- 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做别的探索，不要空等；期间不要改它依赖的文件，也不要跑抢同一 GPU/CPU 的任务。
- 长任务中需要用户授权才能继续时，不要干等：把事项记进 PROGRESS.md 的“待授权”，在回复里提一次，然后继续做不依赖它的事；没有答复的，满 30 分钟和满 2 小时时各合并再请求一次，之后不再追问。
```

## 已知限制

- 定时检查只在会话空闲时触发。agent 卡在一次工具调用中间时（例如权限弹窗正等你确认），它唤不醒。用 Claude Code 的自动模式可以避免这种阻塞。
- 每次定时检查都是一次带完整上下文的模型调用，空闲时每小时 6 次。prompt 缓存只在订阅额度内才是 1 小时，否则 5 分钟就过期，那样每次都是全价读取上下文。
- Codex CLI 没有可用的定时唤醒，只有 Codex app 能建线程定时任务。用外部定时器跑 `codex exec resume` 行不通：桌面端或命令行界面开着同一个线程时，它会占住写锁。

## 设计取舍

- hook 注册在 settings.json / hooks.json，而不是 skill 的 frontmatter：retro 会被反复调用，frontmatter 里的 hook 是否会重复注册，文档没有说清。
- 不做“连续失败”提醒：grep 没匹配、diff 有差异这类正常的非零退出也算失败，误报多了，agent 会连重要的提醒一起忽略；Codex 的 hook 也拿不到退出码。
- 计数日志每次工具调用追加一行“毫秒时间戳 + 进程号”。每次只按自己那一行的位置判断，并行工具调用同时触发 hook 时，提醒不会漏也不会重复。
- 每次工具调用多一次 Node 启动，Windows 上实测约 70ms。

## License

MIT
