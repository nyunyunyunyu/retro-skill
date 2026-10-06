# retro-skill

A skill for [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex) that makes long-running coding agents periodically step back: rethink the approach, speed up the iteration loop (including the eval code itself, gated by ROI, without over-optimizing), avoid rabbit holes, never sit idle waiting, and keep a bounded `PROGRESS.md`.

让长程 coding agent 定期停下来复盘：路线要不要换、迭代能不能更快（包括加速评测代码本身，按 ROI 决定，避免过度优化）、有没有卡在细节或等待里，并维护一个不会膨胀的 `PROGRESS.md`。支持 Claude Code 和 Codex。

## 包含什么

- **retro skill**：几分钟的快速复盘，结束时只给 3 行决定。
  1. 路线：平台期、修一个坏一个时，换本质不同的路线并做最便宜的验证实验。
  2. 迭代速度：先测量再优化瓶颈；评测代码本身往往是最大杠杆（如 30s CPU → 0.1s GPU），按 `节省 = Δt × 剩余轮数 > 实现时间 × 2` 决定做不做；有明确的停止条件；长时间评测放后台跑，等待期间不空等。
  3. 细节与等待：不在关键路径上的问题记一行“暂缓”，回主线。需要用户授权时不干等：记进“待授权”，提一次，继续做别的，没答复的每约 30 分钟合并再请求一次。
  4. `PROGRESS.md`：快照不是日志，改写不追加，不超过约 60 行。
- **10 分钟定时检查**：skill 让 agent 给自己建一个每 10 分钟的定时任务（Claude Code 用 `CronCreate`，Codex app 用线程定时任务），在 agent 空闲等待、没有工具调用时唤醒它：处理已完成的后台任务、重新请求未答复的授权、该复盘时复盘。`PROGRESS.md` 删除后它会自行删掉。
- **提醒 hook**（`retro-nudge.mjs`），只在项目根目录有 `PROGRESS.md` 时工作：
  - 复盘必然改写 `PROGRESS.md`，所以用它的修改时间判断上次复盘。超过 40 次工具调用没更新，就提醒复盘，并允许 agent 先做完手头这一步。被忽略的话每 10 次调用再提醒一次，直到 `PROGRESS.md` 更新为止。
  - 复盘欠着的时候，agent 结束这一轮前会被拦一次（Stop hook），在自然断点补上复盘。
  - 会话启动、恢复或压缩上下文后（SessionStart hook），提醒 agent 先读 `PROGRESS.md`，并在定时检查丢失时重建。Claude Code 的会话定时任务在应用重启后就没了。
  - Claude Code 里，最近 10 次调用有 3 次失败（典型的“改一下、跑一下、又失败”循环）时也会提醒。
  - subagent 的工具调用不计入。

需要 Node.js 在 PATH 上。先克隆：

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
       "SessionStart": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/skills/retro/scripts/retro-nudge.mjs\"", "timeout": 10 }] }
       ],
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/skills/retro/scripts/retro-nudge.mjs\"", "timeout": 10 }] }
       ],
       "PostToolUseFailure": [
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

用法：在长任务项目里输入 `/retro`。

## 安装：Codex

1. 复制 skill：

   ```bash
   mkdir -p ~/.agents/skills && cp -r retro-skill/skills/retro ~/.agents/skills/
   ```

2. 注册 hook：新建或合并进 `~/.codex/hooks.json`：

   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.agents/skills/retro/scripts/retro-nudge.mjs\"", "commandWindows": "node C:/Users/<you>/.agents/skills/retro/scripts/retro-nudge.mjs", "timeout": 10 }] }
       ],
       "PostToolUse": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.agents/skills/retro/scripts/retro-nudge.mjs\"", "commandWindows": "node C:/Users/<you>/.agents/skills/retro/scripts/retro-nudge.mjs", "timeout": 10 }] }
       ],
       "Stop": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.agents/skills/retro/scripts/retro-nudge.mjs\"", "commandWindows": "node C:/Users/<you>/.agents/skills/retro/scripts/retro-nudge.mjs", "timeout": 10 }] }
       ]
     }
   }
   ```

   然后在 Codex 里运行 `/hooks`，审核并信任这些 hook。Codex 不会运行未经信任的 hook。

3. （可选）在 `~/.codex/AGENTS.md` 加下面的[常驻规则](#常驻规则)。

用法：在长任务项目里输入 `$retro`。

**和 Claude Code 的区别**：Codex 没有单独的工具失败事件，传给 hook 的工具结果里也没有退出码，所以没有失败提醒。10 分钟定时检查要用 Codex app 的线程定时任务，Codex CLI 里没有对应功能。

## 常驻规则

```
- 项目根目录有 PROGRESS.md 时，开始工作前先读它；开始一个长任务时，调用 retro skill。
- 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做别的探索，不要空等；期间不要改它依赖的文件，也不要跑抢同一 GPU/CPU 的任务。
- 长任务中需要用户授权才能继续时，不要干等：把事项记进 PROGRESS.md 的“待授权”，在回复里提一次，然后继续做不依赖它的事；没有答复的每隔约 30 分钟合并成一条再请求一次。
```

第一次调用 retro 会建立 `PROGRESS.md`，之后这个项目的会话都会自动收到复盘提醒；任务完成后删掉 `PROGRESS.md` 就关闭。

## 已知限制

- 定时检查只在会话空闲时触发。如果 agent 卡在一次工具调用中间（例如等你在权限弹窗上点确认），它也唤不醒。不过 Claude Code 的自动模式会自动做权限决定；通过 Remote Control 转发到手机的权限弹窗，超过 `dialogExpiry`（默认 5 分钟）没人处理会按取消处理，agent 随后按“待授权”规则继续做别的。
- 定时检查每次触发都是一次模型调用。空闲时每小时约 6 次，大部分是缓存读取。

## 设计取舍

- Claude Code 的 hook 注册在 settings.json，而不是 skill 的 frontmatter：retro 会被反复调用，frontmatter 里的 hook 是否会重复注册，文档没有说清。
- 计数日志每次工具调用追加一行“毫秒时间戳 + 成功/失败标记”，并行工具调用同时触发 hook 时也不会丢计数。
- 每次工具调用多一次 Node 启动，Windows 上实测约 70ms。

## License

MIT
