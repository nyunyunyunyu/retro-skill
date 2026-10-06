# retro-skill

A [Claude Code](https://claude.com/claude-code) skill that makes long-running coding agents periodically step back: rethink the approach, speed up the iteration loop (including the eval code itself, gated by ROI, without over-optimizing), avoid rabbit holes, and keep a bounded `PROGRESS.md`.

让长程 coding agent 定期停下来复盘：路线要不要换、迭代能不能更快（包括加速评测代码本身，按 ROI 决定，避免过度优化）、有没有卡在细节里，并维护一个不会膨胀的 `PROGRESS.md`。

## 包含什么

- **`/retro` skill**：几分钟的快速复盘，结束时只给 3 行以内的决定。
  1. 路线：平台期、修一个坏一个时，换本质不同的路线并做最便宜的验证实验。
  2. 迭代速度：先测量再优化瓶颈；评测代码本身往往是最大杠杆（如 30s CPU → 0.1s GPU），按 `节省 = Δt × 剩余轮数 > 实现时间 × 2` 决定做不做；有明确的停止条件；长时间评测放后台跑，等待期间不空等。
  3. 细节：不在关键路径上的问题记一行“暂缓”，回主线。
  4. `PROGRESS.md`：快照不是日志，改写不追加，不超过约 60 行。
- **提醒 hook**（`retro-nudge.mjs`）：项目根目录有 `PROGRESS.md` 时，每 40 次工具调用、或最近 10 次调用里有 3 次失败（典型的“改一下、跑一下、又失败”循环），提醒 Claude 复盘。没有 `PROGRESS.md` 的项目里什么都不做。

## 安装

需要 Node.js 在 PATH 上。

1. 复制 skill：

   ```bash
   git clone https://github.com/nyunyunyunyu/retro-skill
   cp -r retro-skill/skills/retro ~/.claude/skills/
   ```

2. 注册 hook：合并进 `~/.claude/settings.json`（保留已有内容）：

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/skills/retro/scripts/retro-nudge.mjs\"", "timeout": 10 }] }
       ],
       "PostToolUseFailure": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/skills/retro/scripts/retro-nudge.mjs\"", "timeout": 10 }] }
       ]
     }
   }
   ```

   Windows 上可以改用 exec 形式，省掉一次 shell 启动：`"command": "node", "args": ["C:/Users/<you>/.claude/skills/retro/scripts/retro-nudge.mjs"]`。

3. （可选）在 `~/.claude/CLAUDE.md` 加两行：

   ```
   - 项目根目录有 PROGRESS.md 时，开始工作前先读它；开始一个长任务时，调用 retro skill。
   - 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做别的探索，不要空等；期间不要改它依赖的文件，也不要跑抢同一 GPU/CPU 的任务。
   ```

## 使用

在长任务项目里输入 `/retro`。它会建立 `PROGRESS.md`，之后这个项目的会话都会自动收到复盘提醒（subagent 的工具调用不计入）；任务完成后删掉 `PROGRESS.md` 就关闭。

## 设计取舍

- hook 注册在 settings.json，而不是 skill 的 frontmatter：`/retro` 会被反复调用，frontmatter 里的 hook 是否会重复注册，文档没有说清。
- 每次工具调用多一次 Node 启动，Windows 上实测约 70ms。

## License

MIT
