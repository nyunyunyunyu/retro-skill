# retro-skill

An enhancement for `/goal` in [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex). `/goal` keeps the agent working until a condition is met; retro organizes that long run. The main agent only decides and delegates, so its context stays on direction. Subagents execute and report findings and new ideas. A hook schedules quick retros, an hourly background route review, and a global idea scout, and flags stalls. `PROGRESS.md` stays small. A separate session can answer progress questions without disturbing the run.

`/goal` 的增强插件。`/goal` 负责一直干到完成；retro 负责把这段长时间的工作组织好：
- 主 agent 只决策和调度，上下文留给方向；
- 子代理执行，并回报执行中的发现和新想法；
- hook 定期提醒复盘，每小时在后台安排一次路线评审或全局侦察，一小时没有任何新结果时发停滞提醒；
- `PROGRESS.md` 保持精简；
- 可以另开一个会话随时看进度，不打扰主 agent。

支持 Claude Code 和 Codex。

## 分工

| | `/goal`（原生） | retro（本插件） |
|---|---|---|
| 一直干到完成、判断是否达成 | ✅ | — |
| 暂停、清除、恢复会话后保留 | ✅ `/goal clear`（Codex 也可以 `/goal pause`） | — |
| 等后台任务时唤醒 | ✅ 仅 Claude Code，自带检查（默认 30 分钟；可选地改成 10 分钟，见安装） | — |
| 主 agent 只调度，子代理执行并回报发现和想法 | — | ✅ skill 规则 + 统一的执行与回报模板 |
| 定期复盘 | — | ✅ 60 分钟 / 4 个结果 / 40 次调用，先到先触发；忽略的话每 10 次调用再提醒，一轮结束时再拦一次 |
| 路线评审 | — | ✅ 每小时在后台跑一次，判断路线和优先级 |
| 全局侦察 | — | ✅ 目标开始时一次，之后至少每 4 小时一次，从全局找新想法和知识缺口 |
| 停滞提醒 | — | ✅ 一小时没有任何新结果时提醒查原因 |
| 想法池和探索名额 | — | ✅ 始终留一个名额验证新想法 |
| 等授权时不干等，过一阵再问 | — | ✅ 记进“待授权”，30 分钟和 2 小时后各追问一次 |
| 进度台 | — | ✅ 单独的会话只读查看进度，并转达用户的话 |

retro 只在会话有活跃的 `/goal` 时生效，目标结束就自动停，不需要额外的开关。

## 包含什么

- **retro skill**（`skills/retro/SKILL.md`）：主 agent 遵守的规则，分 8 节。
  1. **角色**：主 agent 只读、分派、追问、验收、和用户沟通；代码、实验、调查都交给子代理。用户的输入优先，按指令、想法、问题三类马上处理。
  2. **委派**：任务说明要写清目标、范围、时间上限、资源和任务目录；子代理按 `templates/executor.md` 执行和回报。收到回报先补位派下一个任务；推翻前提的马上处理；新的最好结果先独立复现再认；值得讨论的就继续追问原来的子代理。
  3. **复盘**：用 `retro.mjs inbox` 收集新回报，分流到下一步、想法池或死路，检查方向、名额流动、迭代速度和细节，改写 PROGRESS.md，最后运行 `retro.mjs done`。对话里只输出 3 行。
  4. **路线和后台名额**：快速复盘只在当前路线内调整，换路线交给评审，并且要满足门槛。
  5. **想法池和探索**：`.retro/ideas.md` 最多放 15 条，每条写明最便宜的验证方法和成立标准。始终留一个名额做探索。
  6. **迭代速度**：先测量再优化，加速评测代码本身按 ROI 决定。
  7. **等待与授权**。
  8. **文件分层**。
- **后台子代理**：模型和主会话同一组，思考强度开到最高。
  - `route-reviewer`：对照想法池和最新结果，给出四选一的结论：保持、调整优先级、先探测、换路线。默认保持，限 20 分钟。
  - `idea-scout`：从差距分解、假设审计、外部经验、换个问法、从零开始这五个角度找想法，只提不拍板，限 40 分钟。
  - 两者都只能在 `.retro/probes/` 下做轻量探测，交付时由脚本核对这一轮是否仍然有效。交付后，主 agent 可以继续追问。
- **提醒 hook**（`scripts/retro-nudge.mjs`）：
  - Claude Code 和 Codex 都注册 PostToolUse、Stop、SubagentStop 三个事件。
  - 从会话记录里读出当前有没有活跃的 `/goal`，有才工作。Codex 的会话记录只记用户设置、暂停、恢复目标，agent 自己标记完成、额度用完、`/goal clear` 都不记，所以 Codex 以它的目标数据库 `~/.codex/goals_1.sqlite` 为准（只读，用 Node 22 自带的 `node:sqlite`）。
  - 负责复盘提醒、后台名额登记、停滞检测。
  - 检测 `/goal` 被替换的情况，提醒 agent 把原目标告诉用户。这也包括误用 `/goal resume` 的情况：Claude Code 没有这个子命令，这样设会成为一个字面上叫 resume 的新目标。
- **辅助脚本**（`scripts/retro.mjs`）：
  - `done`：标记复盘完成；
  - `inbox`：列出上次复盘以来交回的内容；
  - `spawned`、`finish`、`abort`：后台子代理用来标记启动、交付结果、放弃这一轮；
  - `status`：给进度台用的进度快照，Claude Code 和 Codex 的会话记录都能读；
  - `tell`：进度台把用户的话放进转达箱，主 agent 下一次调用工具时由 hook 交给它。
- **进度台 skill**（`skills/retro-status`）：在另一个会话里只读地回答“现在进度怎样”，把用户的指令转给主 agent。

## 安装

需要 Node.js 在 PATH 上。

```bash
git clone https://github.com/nyunyunyunyu/retro-skill
```

```bash
node retro-skill/install.mjs
```

安装脚本会对已有的 `~/.claude`、`~/.codex` 分别做这些事：
- 复制两个 skill（Claude Code 装到 `~/.claude/skills/`，Codex 装到 `~/.agents/skills/`）；
- 安装两个子代理（Claude Code 装到 `~/.claude/agents/`，Codex 装到 `~/.codex/agents/*.toml`，思考强度设为 `max`）；
- 在 `~/.claude/settings.json` 里补上缺少的 hook，改之前备份为 `.bak-retro`；
- 只在 `~/.codex/hooks.json` 缺少 retro 条目时才改它。

只装其中一个就加 `--claude` 或 `--codex`；想先看会改什么，就加 `--dry-run`。

安装后：
- **Codex**：安装脚本新加了 hook 条目时（会提示是哪几个），要在 Codex 里运行 `/hooks` 信任它们，Codex 不运行没被信任的条目。已经信任过的条目不会被改动，也不用重新信任；Codex 只校验条目本身，不校验脚本内容，所以以后升级脚本也不用重新信任。
- **Claude Code**：如果 `~/.claude/agents/` 是这次新建的，已经在运行的会话要重启一次才能看到子代理。
- **（可选）** 在 `~/.claude/settings.json` 的 `env` 里加上 `"CLAUDE_CODE_GOAL_CHECKIN_MINUTES": "10"`，让 `/goal` 等后台任务时第一次检查提前到 10 分钟，默认是 30 分钟。这需要 Claude Code v2.1.234 以上。
- **（可选）** 在 `~/.claude/CLAUDE.md` 或 `~/.codex/AGENTS.md` 加上下面的[常驻规则](#常驻规则)。

## 用法

```text
/goal tests/auth 全部通过，npm test 退出码为 0
```

设了目标后，retro 自动生效。建议一开始就调用一次 retro（Claude Code：`/retro`；Codex：`$retro`），建立 `PROGRESS.md`，并把同一个条件写进“目标”一栏。条件要可验证，并写明怎么证明：Claude Code 的 `/goal` 由一个独立的模型看对话内容来判断，它不会自己去跑命令。

- **看进度**：在同一个项目目录里另开一个会话，说“用 retro-status 看看进度”。这个会话可以一直开着，打开 Remote Control 后用手机也能问。在进度台里说的指令，它会转给主 agent。
- **临时插一件事**：直接给主 agent 发消息，不要用 `/goal`。`/goal` 同一时间只有一个，新设的会把原来的长期目标覆盖掉。Claude Code 也没有 `/goal resume`，要恢复就用 `/goal` 加原文重新设置，原文可以从 PROGRESS.md 的“目标”一栏复制。
- **暂停**：`/goal clear`（Codex：`/goal pause`）。只按 Esc 打断不够：如果还有后台任务在跑，`/goal` 自带的检查还可能把 agent 唤醒；你再发任何一条消息，`/goal` 也会接着干。12 小时内用同一条件重新设置，retro 会当作同一个目标接着算。
- **结束**：目标达成后自动结束，retro 随之停止。`PROGRESS.md` 留作记录。

## 文件

| 文件 | 谁写 | 内容 |
|---|---|---|
| `PROGRESS.md`（项目根目录） | 主 agent，复盘时 | 方向快照，不超过 4 KB：目标、用户指令、最好结果、路线、进行中、下一步、上次评审、待授权 |
| `RUNBOOK.md` | 改了运行方法的人 | 怎么构建、测试、评测。跟着代码走，每个分支一份 |
| 项目的 `CLAUDE.md` | 主 agent 交给子代理写 | 所有代理都必须遵守的规则 |
| `.retro/ideas.md` | 主 agent | 想法池和死路 |
| `.retro/results.tsv` | 评测脚本 | 影响决策的数字，一次评测一行 |
| `.retro/tasks/<任务>/` | 执行子代理 | `report.md`、`notes.md`、原始数据 |
| `.retro/route-review.md`、`reviews/`、`tasks/scout-*/` | 后台子代理，经由脚本写入 | 评审和侦察报告 |
| `.retro/slot`、`retro-done`、`log.tsv`、`sessions/` | hook 和脚本 | 状态和事件日志，不要手改 |

`.retro/` 不进 git，所有分支和 worktree 共用这一份：
- hook 新建 `.retro/` 时，会放一个忽略全部内容的 `.gitignore`；
- 已有的 `.retro/` 如果没有 `.gitignore`，只忽略脚本和代理生成的文件，项目自己提交的那些不受影响。

hook 和脚本都把 worktree 里的路径换算到主 checkout，hook 给出的命令也都带 `--root`，所以就算主会话或子代理在某个 worktree 里，读写的也是同一份。

## 常驻规则

```
- 设了 /goal 的长任务，开始时调用 retro skill；项目根目录有 PROGRESS.md 时，开始工作前先读它。
- 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做别的探索，不要空等；期间不要改它依赖的文件，也不要跑抢同一 GPU/CPU 的任务。
- 长任务中需要用户授权才能继续时，不要干等：把事项记进 PROGRESS.md 的“待授权”，在回复里提一次，然后继续做不依赖它的事；没有答复的，满 30 分钟和满 2 小时时各合并再请求一次（用两个一次性定时提醒），之后不再追问。
```

## 已知限制

- **依赖没有公开文档的内部格式**：Claude Code 的 `goal_status` 和 `Goal cleared` 记录，Codex 的 `thread_goal_updated` 事件和目标数据库。格式一变，hook 会安静地失效，不会报错。
- **Codex 的 hook 只在代码单元里的工具之后触发**：Codex 用代码模式时，`exec` 单元和 `wait` 本身不触发 hook，主 agent 长时间等待时，提醒要等到下一次工具调用或这一轮结束。
- **Codex 同时最多 3 个子代理**（默认值，含后台评审或侦察）。子代理交回的结论只在主 agent 活动时送到，不会把空闲的主 agent 叫醒；`/goal` 会自己开下一轮，所以不会卡住。
- **进度台转达到 Codex 有延迟**：Codex 没有会话间消息，转达靠 `retro.mjs tell` 加 hook，主 agent 下一次调用工具时才收到。
- **agent 卡在一次工具调用中间时**（例如权限弹窗正等你确认），没有任何机制能唤醒它。用 Claude Code 的自动模式可以避免这种阻塞。
- **token 开销明显**：评审和侦察都用最高思考强度。hook 只在主会话有动静时检查，主 agent 长时间空闲时不会登记新的一轮。
- **结束时可能多一轮**：Stop hook 拦截和 `/goal` 判定达成同时发生时，两者怎么合并没有文档说明，可能会多跑一轮。

## 设计取舍

- **复盘完成用 `retro.mjs done` 显式标记**，不再看 PROGRESS.md 的修改时间。旧版里任何一次写入都会把计数清零，实测一天写了 58 次，复盘从来触发不了。
- **只调度的主 agent 很少调用工具**，所以复盘改成按时间、交回的结果数和调用数，先到先算。提醒先在下一次工具调用时发；如果主 agent 一直不调用工具，就在这一轮结束时拦一次。
- **同一个目标按条件原文识别**（Codex 按 createdAt）。Claude Code 在恢复会话和压缩上下文后，会重写一条设定目标的记录，旧版因此会把计数清零。暂停后、或者插了一个临时目标后，12 小时内用原文重新设置，也接着原来的开始时间算，已经启动的评审照常跑完。
- **后台名额同一时间只有一个**，由 hook 在排他锁下登记。并行的工具调用、同一项目的多个会话都只会登记一次。登记后 20 分钟内要启动，时间上限从启动算起。Claude Code 上，hook 看到主 agent 启动了对应的子代理就自动记下，不会再催。子代理开始和交付时都要通过脚本核对这一轮还有效，作废或超时的结论写不进去。
- **一轮结束时的兜底拦截**：`/goal` 会拦下每一个未完成的 Stop，所以 `stop_hook_active` 在整个运行期间一直是 true，靠它分不出轮次。hook 改为自己记录：上次拦截之后，主 agent 至少调用过一次工具，才会再拦。这样不会循环；不能出声的时候，也不改任何状态。
- **结果按子代理去重**：对同一个子代理追问几次，只算一个结果；任务回报按创建时间算，改写不重复计数。
- **扩写目标算同一个目标**：比如在原条件后面加“成功后……”，不会被当成替换。
- **提想法和拍板分开**：评审默认保持路线，以免频繁换路线；侦察只提想法，不受这个约束。两者共用一个名额，侦察至少每 4 小时一次；想法池偏少时，评审之后插一次侦察。
- **一小时没有新结果，就不派评审**：没有新东西可评。改为发停滞提醒，因为按设计结果应该一直在流动。
- **计数日志按“时间戳 + 进程号”逐行追加**，提醒是在哪一次调用发出由日志内容唯一决定，所以并行的工具调用既不会漏提醒，也不会重复提醒。会话记录按字节位置增量扫描：60 MB 的记录第一次扫描约 100 ms，之后约 60 ms。
- **不做“连续失败”提醒**：grep 没匹配、diff 有差异这类正常的非零退出也算失败，误报多了，agent 会连重要的提醒一起忽略。

## 从旧版升级

重新运行 `node install.mjs`。旧版的规则是“PROGRESS.md 一更新就算复盘完成”，路线评审的状态记在 `route-review.md` 的第一行。新版改用 `.retro/slot` 和 `.retro/retro-done`，旧的状态行会被忽略。升级后第一次活动会先登记一次全局侦察。

如果 PROGRESS.md 超过 4 KB，复盘提醒会要求先压缩：命令和环境移到 RUNBOOK.md，过程细节移到任务笔记。

## License

MIT
