# retro-skill

An enhancement for `/goal` in [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex). `/goal` keeps the agent working until a condition is met; retro makes it periodically step back while it does: rethink the approach, speed up the iteration loop (including the eval code itself, gated by ROI, without over-optimizing), avoid rabbit holes and idle waiting, and keep a bounded `PROGRESS.md`.

`/goal` 的增强插件。`/goal` 负责一直干到完成；retro 让 agent 在这期间定期停下来复盘：路线要不要换、迭代能不能更快（包括加速评测代码本身，按 ROI 决定，避免过度优化）、有没有卡在细节或等待里，并维护一个不会膨胀的 `PROGRESS.md`。支持 Claude Code 和 Codex。

## 分工

| | `/goal`（原生） | retro（本插件） |
|---|---|---|
| 一直干到完成、判断是否达成 | ✅ | — |
| 暂停、清除、恢复会话后保留 | ✅ `/goal clear`（Codex：`/goal pause`） | — |
| 等后台任务时唤醒 | ✅ 仅 Claude Code：自带检查（本插件把首次间隔设为 10 分钟） | — |
| 定期复盘方法、迭代速度、是否卡在细节 | — | ✅ 每 40 次工具调用提醒，直到复盘做完 |
| 路线和优先级评审 | — | ✅ 每小时在后台跑一次独立评审，不阻塞主 agent，同一项目同一时间最多一个，超过 20 分钟作废 |
| `PROGRESS.md` 快照 | — | ✅ |
| 等授权时不干等，过一阵再问 | — | ✅ 记进“待授权”，用两个一次性定时提醒在 30 分钟和 2 小时后追问 |

retro 只在会话有活跃的 `/goal` 时生效，目标结束就自动停，不需要额外的开关或命令。

## 包含什么

- **retro skill**：几分钟的快速复盘，结束时只给 3 行决定。
  1. 路线：快速复盘里只在当前路线内做小调整（重排“下一步”），换路线交给后台的路线评审。
  2. 迭代速度：先测量再优化瓶颈；评测代码本身往往是最大杠杆（如 30s CPU → 0.1s GPU），按 `节省 = Δt × 剩余轮数 > 实现时间 × 2` 决定做不做；有明确的停止条件；长时间评测放后台跑，等待期间不空等。
  3. 细节与等待：不在关键路径上的问题记一行“暂缓”，回主线。需要用户授权时不干等：记进“待授权”，提一次，继续做别的，没答复的最多再问两次。
  4. `PROGRESS.md`：快照不是日志，改写不追加，不超过约 60 行；“目标”一栏和 `/goal` 的条件一致；每条路线写明押注理由、放弃条件和复查点。
- **路线评审子代理**（`route-reviewer`）：和主 agent 同一组模型，思考强度开到最高，在后台运行。
  - 输入：PROGRESS.md、`results.tsv`、git log，以及上次的评审。可以跑不占 GPU 的轻量探测，只写 `.retro/` 目录。
  - 输出：200 字以内的建议，结论是保持、调整优先级、先探测或换路线四选一，附依据，以及会改变结论的条件。交结论前会重读最新状态，避免和主线脱节。
  - 主 agent 怎么采纳：做完手头这一步再决定。复查点之前，只有放弃条件触发才换路线；调整优先级、推翻上次结论都需要新证据，以免来回换路线。快速复盘不能换路线，也不能自己提前发起评审。
  - 防重复：何时评审只由 hook 决定。到点时，hook 用一个排他的锁文件原子地登记一次，把 `.retro/route-review.md` 第一行写成 `running`，并记下是哪个会话登记的。同一项目开多个会话、并行工具调用都只会登记一个，后续提醒也只发给登记的那个会话。它启动子代理后标记 `spawned`，没标记的话 hook 每 10 次调用催一次。
  - 防过时：超过 20 分钟，任何会话的 hook 都会自动把这轮改成作废，并提醒登记的会话停掉子代理。子代理开始时和写结论前都会核对第一行是不是自己那一轮，不是就不写入，所以作废的结论不会覆盖新状态。
- **提醒 hook**（`retro-nudge.mjs`，PostToolUse）：从会话记录里读出当前有没有活跃的 `/goal`。有的话，复盘必然改写 `PROGRESS.md`，就用它的修改时间判断上次复盘：从目标开始或上次复盘起超过 40 次工具调用，就提醒复盘，并允许 agent 先做完手头这一步；被忽略的话每 10 次调用再提醒一次，直到 `PROGRESS.md` 更新为止。subagent 的工具调用不计入；Claude Code 的 `/btw` 没有工具；Codex 的 `/side` 是临时线程，没有会话记录文件，hook 直接跳过。

需要 Node.js 在 PATH 上。先克隆：

```bash
git clone https://github.com/nyunyunyunyu/retro-skill
```

## 安装：Claude Code

1. 复制 skill 和路线评审子代理：

   ```bash
   cp -r retro-skill/skills/retro ~/.claude/skills/
   mkdir -p ~/.claude/agents && cp retro-skill/agents/claude/route-reviewer.md ~/.claude/agents/
   ```

   如果 `~/.claude/agents/` 是新建的，已经在运行的会话要重启一次才能看到这个子代理。

2. 合并进 `~/.claude/settings.json`（保留已有内容）。`env` 那一项把 `/goal` 自带的后台任务检查提前：第一次在 10 分钟，之后间隔逐步拉长。它对所有 `/goal` 会话都生效，需要 Claude Code v2.1.234 以上；不想要就去掉这一项：

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/skills/retro/scripts/retro-nudge.mjs\"", "timeout": 10 }] }
       ]
     },
     "env": { "CLAUDE_CODE_GOAL_CHECKIN_MINUTES": "10" }
   }
   ```

   Windows 上可以改用 exec 形式，省掉一次 shell 启动：`"command": "node", "args": ["C:/Users/<you>/.claude/skills/retro/scripts/retro-nudge.mjs"]`。

3. （可选）在 `~/.claude/CLAUDE.md` 加下面的[常驻规则](#常驻规则)。

## 安装：Codex

1. 复制 skill 和路线评审子代理（思考强度设为 `max`，模型继承主会话）：

   ```bash
   mkdir -p ~/.agents/skills && cp -r retro-skill/skills/retro ~/.agents/skills/
   mkdir -p ~/.codex/agents && cp retro-skill/agents/codex/route-reviewer.toml ~/.codex/agents/
   ```

2. 新建或合并进 `~/.codex/hooks.json`：

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "hooks": [{ "type": "command", "command": "node \"$HOME/.agents/skills/retro/scripts/retro-nudge.mjs\"", "commandWindows": "node C:/Users/<you>/.agents/skills/retro/scripts/retro-nudge.mjs", "timeout": 10 }] }
       ]
     }
   }
   ```

   然后在 Codex 里运行 `/hooks`，审核并信任这个 hook。Codex 不会运行未经信任的 hook，而且**每次修改 hooks.json 后都要重新信任**。

3. （可选）在 `~/.codex/AGENTS.md` 加下面的[常驻规则](#常驻规则)。

## 用法

```text
/goal tests/auth 全部通过，npm test 退出码为 0
```

设了目标之后 retro 自动生效。建议开始时调用一次 retro（Claude Code：`/retro`；Codex：`$retro`），建立 `PROGRESS.md`，并把同一个条件写进“目标”一栏。条件要可验证，并写明怎么证明：Claude Code 的 `/goal` 由一个独立的模型看对话内容来判断，它不会自己去跑命令。

- **暂停**：`/goal clear`（Codex：`/goal pause`）。只按 Esc 打断不够：如果还有后台任务在跑，`/goal` 自带的等待检查仍可能把 agent 唤醒；你再发任何一条消息，`/goal` 也会接着干。
- **结束**：目标达成后自动结束，retro 随之停止，`PROGRESS.md` 留作记录。
- 没有 `/goal` 时也可以手动调用 retro 复盘一次，只是没有自动提醒。

## 常驻规则

```
- 设了 /goal 的长任务，开始时调用 retro skill；项目根目录有 PROGRESS.md 时，开始工作前先读它。
- 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做别的探索，不要空等；期间不要改它依赖的文件，也不要跑抢同一 GPU/CPU 的任务。
- 长任务中需要用户授权才能继续时，不要干等：把事项记进 PROGRESS.md 的“待授权”，在回复里提一次，然后继续做不依赖它的事；没有答复的，满 30 分钟和满 2 小时时各合并再请求一次（用两个一次性定时提醒），之后不再追问。
```

## 已知限制

- **依赖未公开的会话记录格式**：Claude Code 的 `goal_status` 记录和 `Goal cleared` 记录，以及 Codex 的 `thread_goal_updated` 事件。格式变了的话，hook 会安静地失效，不会报错。
- **Codex 里 `/goal clear` 不会写进会话记录**，hook 看不到，要停 retro 请用 `/goal pause`。
- agent 卡在一次工具调用中间时（例如权限弹窗正等你确认），没有任何机制能唤醒它。用 Claude Code 的自动模式可以避免这种阻塞。
- 路线评审用最高思考强度，目标活跃、主 agent 一直在干活时每小时一次，token 开销明显。hook 只在工具调用时检查，主 agent 空闲时不会启动评审。`.retro/` 不需要提交，可以加进 `.gitignore`。
- Codex 没有等后台任务时的自动唤醒（`/goal` 的等待检查目前只有 Claude Code 有文档说明）。
- 恢复会话时 Claude Code 会重新写一条“设定目标”的记录，所以复盘计数会在恢复时清零。

## 设计取舍

- 计数日志每次工具调用追加一行“毫秒时间戳 + 进程号”。每次只按自己那一行的位置判断，并行工具调用同时触发 hook 时，提醒不会漏也不会重复。
- 会话记录增量扫描：缓存已读到的字节位置，每次只读新增部分。第一次完整扫描 62MB 的记录约 80ms。
- 不做“连续失败”提醒：grep 没匹配、diff 有差异这类正常的非零退出也算失败，误报多了，agent 会连重要的提醒一起忽略；Codex 的 hook 也拿不到退出码。
- 每次工具调用多一次 Node 启动，Windows 上实测约 70–100ms。

## 从旧版升级

旧版用 `PROGRESS.md` 当开关，自建 10 分钟定时器，还有 `/retro pause|resume|done` 子命令。现在这些都交给 `/goal`。配置里的 `Stop`、`SessionStart`、`PostToolUseFailure` 条目可以删掉，留着也无害，新脚本对它们不输出任何内容。会话里之前建的 retro 定时任务可以用 CronDelete 删掉。

## License

MIT
