# retro-skill

An enhancement for `/goal` in [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex). `/goal` keeps the agent working until a condition is met; retro organizes that long run. The main agent only decides and delegates, in an explicit main loop, so its context stays on direction. Subagents execute and report observations and ideas. A hook reminds the main agent of hourly checkpoints, watches slots and subagents (idle, overrunning, silent), and schedules a background route review or idea scout every hour. `PROGRESS.md` stays small. A separate session can answer progress questions without disturbing the run.

`/goal` 的增强插件。`/goal` 负责一直干到完成；retro 负责把这段长时间的工作组织好：
- 主 agent 只决策和调度，按固定的主循环转，上下文留给方向；
- 执行子代理干活，回报结果、观察和想法；
- hook 每小时提醒一次检查点，盯着名额和子代理（空着、超时、没动静），每小时在后台安排一次路线评审或全局侦察；
- `PROGRESS.md` 保持精简；
- 可以另开一个会话随时看进度，不打扰主 agent。

支持 Claude Code 和 Codex。

## 分工

| | `/goal`（原生） | retro（本插件） |
|---|---|---|
| 一直干到完成、判断是否达成 | ✅ | — |
| 暂停、清除、恢复会话后保留 | ✅ `/goal clear`（Codex 也可以 `/goal pause`） | — |
| 等后台任务时唤醒 | ✅ 仅 Claude Code，自带检查（默认 30 分钟，可以改成 10 分钟，见安装） | — |
| 主 agent 只调度，按主循环转；子代理执行并回报 | — | ✅ skill 规则 + 统一的执行与回报模板 |
| 检查点、名额、子代理、后台评审的提醒 | — | ✅ 见下表 |
| 想法池和探索 | — | ✅ 默认约三分之一的名额验证新想法 |
| 等授权时不干等，过一阵再问 | — | ✅ 记进“待授权”，30 分钟和 2 小时后各追问一次 |
| 进度台 | — | ✅ 单独的会话只读查看进度，并转达用户的话 |

retro 只在会话有活跃的 `/goal` 时生效，目标结束就自动停，不需要额外的开关。

### hook 什么时候提醒

| 提醒 | 什么时候 | 重复 |
|---|---|---|
| 检查点到期 | 距上次检查点（`retro.mjs done`）或目标开始满 60 分钟 | 没做之前每 10 分钟一次；一轮结束时也拦一次 |
| 后台评审登记 | 目标开始时一次侦察；之后每小时一次：距上次侦察满 4 小时或想法池少于 3 条时侦察，否则路线评审；`retro.mjs request` 可以提前要 | 登记后没启动，每 10 分钟提醒，一轮结束时也拦一次；20 分钟后作废 |
| 停滞 | 到了每小时那一轮，而过去一小时没有任何新结果（子代理交回、任务回报、总表、提交） | 代替那一轮评审 |
| 记下名额 | 目标开始 10 分钟还没运行 `retro.mjs slots` | 每 10 分钟一次 |
| 名额空着 | 在跑的执行子代理少于名额，超过 5 分钟（从最近一次空出名额或派任务算起） | 每 10 分钟一次 |
| 一段超时 | 一个子代理连续跑了 1 小时还没交回 | 每段一次 |
| 没动静 | 一个子代理 20 分钟没有调用工具 | 每次一次 |
| 上下文被压缩 | 压缩之后 | 每次压缩 |
| 子代理上限太低 | harness 同时允许的子代理数减 3 后不到 2 | 每 10 分钟一次；检查点、名额、后台评审的提醒都停 |
| 进度台转达 | 用户在进度台说了话 | 送到一次 |

hook 只能在主 agent 调用工具之后和一轮结束时说话；主 agent 长时间等待时，提醒会在它下一次活动时送到。

## 包含什么

- **retro skill**（`skills/retro/SKILL.md`）：主 agent 遵守的规则。
  - **术语**：执行子代理、名额、后台评审、检查点、一段、想法池、任务目录。
  - **1. 角色**：主 agent 只读、分派、追问、验收、和用户沟通；代码、实验、调查都交给子代理。用户的输入优先，按指令、想法、问题三类马上处理。
  - **2. 主循环**：处理输入 → 补满名额 → 往前看一步 → 等。还有每小时的检查点（只在当前路线内调整）、子代理异常的处理、目标结束时的收尾。
  - **3. 委派和回报**：名额怎么定，探索的份额，任务说明要写什么（包括已知的事实和死路），每个任务从新的上下文开始。收到回报先补位；推翻前提的马上处理；新的最好结果先在干净环境里复现，还要审一遍评测本身；值得讨论的就追问原来的子代理。到时间上限时由主 agent 决定让它接着做、换人还是停。
  - **4. 路线**：换路线交给后台的路线评审，并且要满足门槛；可以用 `retro.mjs request` 提前要一次评审或侦察。
  - **5. 想法池**：`.retro/ideas.md` 最多 15 条，每条写明最便宜的验证方法和成立标准。
  - **6. 迭代速度**：先测量再优化，做不做按 ROI 判断，不套公式。
  - **7. 等待与授权**。
  - **8. 文件**：PROGRESS.md 的模板；手册 `RUNBOOK.md` 只做索引，内容在 `runbook/` 下；全局规则写在 AGENTS.md，`CLAUDE.md` 用 `@AGENTS.md` 引用它。
  - **附表**：两个工具在派任务、追问、停止、等待、子代理上限、判断达成、定时提醒上的差别。
- **执行模板**（`skills/retro/templates/executor.md`）：执行规则、什么时候回报（做完、到时间上限带继续申请、前提不成立、少数几种中途情况），回报格式（结果、观察、想法、阻塞、继续申请）。想法要回答两个固定的问题：再给 1 小时做什么，最大的差距或最不放心的假设是什么。
- **后台子代理**：模型和主会话同一组，思考强度 `xhigh`。
  - `route-reviewer`：对照想法池和最新结果，给出四选一的结论：保持、调整优先级、先探测、换路线，默认保持；也看名额流动和迭代速度，提出测量或加速的任务。限 20 分钟。
  - `idea-scout`：从差距分解、假设审计、外部经验、换个问法、从零开始这五个角度找想法，只提不拍板，限 40 分钟。
  - 两者都只能在 `.retro/probes/` 下做轻量探测，交付时由脚本核对这一轮是否仍然有效。交付后，主 agent 可以继续追问。
- **提醒 hook**（`scripts/retro-nudge.mjs`）：
  - Claude Code 和 Codex 都注册 PostToolUse、Stop、SubagentStop、SessionStart（只在压缩后）四个事件。
  - 从会话记录里读出当前有没有活跃的 `/goal`，有才工作。Codex 的会话记录只记用户设置、暂停、恢复目标，agent 自己标记完成、额度用完、`/goal clear` 都不记，所以 Codex 以它的目标数据库 `~/.codex/goals_1.sqlite` 为准（只读，用 Node 22 自带的 `node:sqlite`）。
  - 子代理追踪：每次子代理调用工具和结束时记一笔，据此判断名额空着、一段超时、没动静。
  - 检测 `/goal` 被替换的情况，提醒 agent 把原目标告诉用户。这也包括误用 `/goal resume` 的情况：Claude Code 没有这个子命令，这样设会成为一个字面上叫 resume 的新目标。
- **辅助脚本**（`scripts/retro.mjs`）：
  - `done`：标记检查点完成；
  - `inbox`：列出上次检查点以来交回的内容；
  - `slots <N> <理由>`：记下这个目标的名额；
  - `request review|scout`：提前要一次后台评审或侦察；
  - `spawned`、`finish`、`abort`：后台子代理用来标记启动、交付结果、放弃这一轮；
  - `status`：进度快照，包括名额和每个执行子代理的状态，Claude Code 和 Codex 的会话记录都能读；
  - `tell`：进度台把用户的话放进转达箱，主 agent 下一次调用工具时由 hook 交给它。
- **进度台 skill**（`skills/retro-status`）：在另一个会话里只读地回答“现在进度怎样”，把用户的指令转给主 agent。

## Claude Code 和 Codex

| | Claude Code | Codex |
|---|---|---|
| 装到哪 | `~/.claude/skills`、`~/.claude/agents`、`~/.claude/settings.json` | `~/.agents/skills`、`~/.codex/agents/*.toml`、`~/.codex/hooks.json` |
| hook 生效 | 安装后马上生效 | 新加的条目要在 `/hooks` 里信任一次 |
| 子代理上限（名额最多是上限减 3） | 默认 20，环境变量 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 默认 3，**不够用**：要在 `~/.codex/config.toml` 加 `[agents]` 和 `max_concurrent_threads_per_session = 12` |
| 主 agent 怎么等 | 结束这一轮，子代理交回或 `/goal` 定期检查时被唤醒 | `wait_agent` 加不超过 10 分钟的超时 |
| 判断目标达成 | 独立的模型看对话 | agent 自己标记完成 |
| 进度台转达 | 桌面版里用 SendMessage，立刻送到；否则走 `retro.mjs tell` | 走 `retro.mjs tell`，主 agent 下一次调用工具时送到 |

## 安装

需要 Node.js 在 PATH 上；Codex 要读它的目标数据库，需要 Node 22.5 以上。

```bash
git clone https://github.com/nyunyunyunyu/retro-skill
```

```bash
node retro-skill/install.mjs
```

安装脚本会对已有的 `~/.claude`、`~/.codex` 分别做这些事：
- 复制两个 skill；
- 安装两个后台子代理（Codex 版由脚本生成 `.toml`）；
- 在 `~/.claude/settings.json` 里补上缺少的 hook，改之前备份为 `.bak-retro`；
- 只在 `~/.codex/hooks.json` 缺少 retro 条目时才追加，已有的条目不动；
- 子代理上限不够时打印警告。

只装其中一个就加 `--claude` 或 `--codex`；想先看会改什么，就加 `--dry-run`。

安装后：
- **Codex**：
  - 安装脚本新加了 hook 条目时（会提示是哪几个），要在 Codex 里运行 `/hooks` 信任它们，Codex 不运行没被信任的条目。已经信任过的条目不会被改动，也不用重新信任；Codex 只校验条目本身，不校验脚本内容，所以以后升级脚本也不用重新信任。
  - 把子代理上限调到至少 5，建议 12（见上表）。不够的话，hook 会在目标开始时让 agent 停下来请你调大。
- **Claude Code**：如果 `~/.claude/agents/` 是这次新建的，已经在运行的会话要重启一次才能看到子代理。
- **（可选）** 在 `~/.claude/settings.json` 的 `env` 里加上 `"CLAUDE_CODE_GOAL_CHECKIN_MINUTES": "10"`，让 `/goal` 等后台任务时第一次检查提前到 10 分钟，默认是 30 分钟。这需要 Claude Code v2.1.234 以上。
- **（可选）** 在 `~/.claude/CLAUDE.md` 或 `~/.codex/AGENTS.md` 加上下面的[常驻规则](#常驻规则)。

## 用法

```text
/goal tests/auth 全部通过，npm test 退出码为 0
```

设了目标后，retro 自动生效。建议一开始就调用一次 retro（Claude Code：`/retro`；Codex：`$retro`），建立 `PROGRESS.md`，把同一个条件写进“目标”一栏。条件要可验证，并写明怎么证明：Claude Code 的 `/goal` 由一个独立的模型看对话内容来判断，它不会自己去跑命令。想限制并行，就写进条件里，比如“最多并行 4 个”。

- **看进度**：在同一个项目目录里另开一个会话，说“用 retro-status 看看进度”。这个会话可以一直开着，打开 Remote Control 后用手机也能问。在进度台里说的指令，它会转给主 agent。
- **临时插一件事**：直接给主 agent 发消息，不要用 `/goal`。`/goal` 同一时间只有一个，新设的会把原来的长期目标覆盖掉。Claude Code 也没有 `/goal resume`，要恢复就用 `/goal` 加原文重新设置，原文可以从 PROGRESS.md 的“目标”一栏复制。
- **暂停**：`/goal clear`（Codex：`/goal pause`）。只按 Esc 打断不够：如果还有后台任务在跑，`/goal` 自带的检查还可能把 agent 唤醒；你再发任何一条消息，`/goal` 也会接着干。12 小时内用同一条件重新设置，retro 会当作同一个目标接着算。
- **结束**：目标达成后，主 agent 停掉子代理、写最终报告，retro 随之停止。`PROGRESS.md` 留作记录。

## 文件

| 文件 | 谁写 | 内容 |
|---|---|---|
| `PROGRESS.md`（项目根目录） | 主 agent | 方向快照，不超过 4 KB：目标、用户指令、最好结果、路线、进行中、下一步、上次评审、待授权 |
| `RUNBOOK.md` 和 `runbook/` | 改了运行方法的人 | 手册：`RUNBOOK.md` 只做索引，构建、测试、评测、代码地图放在 `runbook/` 下。跟着代码走，每个分支一份 |
| 项目的 `AGENTS.md` | 主 agent 交给子代理写 | 所有代理都必须遵守的规则和全局的坑；`CLAUDE.md` 里写 `@AGENTS.md` |
| `.retro/ideas.md` | 主 agent | 想法池和死路 |
| `.retro/results.tsv` | 评测脚本 | 影响决策的数字，一次评测一行 |
| `.retro/tasks/<任务>/` | 执行子代理 | `report.md`、`notes.md`、原始数据 |
| `.retro/route-review.md`、`reviews/`、`tasks/scout-*/` | 后台子代理，经由脚本写入 | 评审和侦察报告 |
| `.retro/slot`、`slots`、`retro-done`、`log.tsv`、`sessions/` | hook 和脚本 | 状态和事件日志，不要手改 |

`.retro/` 不进 git，所有分支和 worktree 共用这一份：
- hook 新建 `.retro/` 时，会放一个忽略全部内容的 `.gitignore`；
- 已有的 `.retro/` 如果没有 `.gitignore`，只忽略脚本和代理生成的文件，项目自己提交的那些不受影响。

hook 和脚本都把 worktree 里的路径换算到主 checkout，hook 给出的命令也都带 `--root`，所以就算主会话或子代理在某个 worktree 里，读写的也是同一份。每个会话的提醒记录和子代理追踪放在系统临时目录（`claude-retro-<会话>.*`）。

## 常驻规则

```
- 设了 /goal 的长任务，开始时调用 retro skill；项目根目录有 PROGRESS.md 时，开始工作前先读它。
- 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做别的探索，不要空等；期间不要改它依赖的文件，也不要跑抢同一 GPU/CPU 的任务。
- 长任务中需要用户授权才能继续时，不要干等：把事项记进 PROGRESS.md 的“待授权”，在回复里提一次，然后继续做不依赖它的事；没有答复的，满 30 分钟和满 2 小时时各合并再请求一次（用两个一次性定时提醒），之后不再追问。
```

## 已知限制

- **依赖没有公开文档的内部格式**：Claude Code 的 `goal_status` 和 `Goal cleared` 记录，Codex 的 `thread_goal_updated` 事件和目标数据库。格式一变，hook 会安静地失效，不会报错。
- **hook 只在工具调用之后和一轮结束时说话**：Codex 用代码模式时，`exec` 单元本身不触发 hook。主 agent 长时间等待时，提醒要等到它下一次活动。
- **子代理追踪是推断的**：子代理被直接停掉、没有触发 SubagentStop 时，它会先显示为“没动静”，一小时后才不再算作在跑。反过来，子代理在前台等一个很长的命令时，20 分钟后会被报“没动静”，超过一小时还会被当成名额空着。
- **子代理交回的结论在 Codex 里只在主 agent 活动时送到**，不会把空闲的主 agent 叫醒；`/goal` 会自己开下一轮，所以不会卡住。
- **agent 卡在一次工具调用中间时**（例如权限弹窗正等你确认），没有任何机制能唤醒它。用 Claude Code 的自动模式可以避免这种阻塞。
- **token 开销和并行数成正比**：名额为 N 时，消耗大约是单个 agent 的 N 倍，后台评审和侦察再加一份。想省就在 `/goal` 条件里写并行上限；Codex 也可以给目标设 token 预算（子代理的消耗算在同一个目标上）。
- **结束时可能多一轮**：Stop hook 拦截和 `/goal` 判定达成同时发生时，两者怎么合并没有文档说明，可能会多跑一轮。

## 设计取舍

- **检查点只按时间触发**。主 agent 只调度，回报一到它就在主循环里处理，所以“交回了几个结果”“调用了多少次工具”都不再触发检查点。按调用次数触发在 Codex 里尤其不准：主 agent 和子代理之间的来回消息每次都算一次调用，试运行里 6 分钟就触发了。
- **检查点不改路线**，换路线交给后台的路线评审，并且要满足门槛，以免频繁换路线。觉得路线有问题就用 `retro.mjs request review` 提前要一次评审。
- **检查点完成用 `retro.mjs done` 显式标记**，不看 PROGRESS.md 的修改时间。旧版里任何一次写入都算完成，实测一天写了 58 次，提醒从来触发不了。
- **提醒按种类限频**：同一种提醒最多 10 分钟一次，记录在锁里更新，所以并行的工具调用不会重复。只有到期的检查点和登记了还没启动的评审，在一轮结束时还会再拦一次：带着它们结束这一轮，正是最需要提醒的时候。名额空着之类的提醒不这样做，否则主 agent 有意少开名额时，每一轮都会被多拦一次。
- **一轮结束时的兜底拦截不会循环**：`/goal` 会拦下每一个未完成的 Stop，所以 `stop_hook_active` 在整个运行期间一直是 true，靠它分不出轮次。hook 改为自己记录：上次拦截之后，主 agent 至少调用过一次工具，才会再拦。不能出声的时候，也不改任何状态。
- **名额由主 agent 定、hook 来查**。名额取资源、用户写的上限、harness 上限减 3 这三者的最小值；只有主 agent 知道资源情况，hook 只检查有没有空着。harness 上限减 3 后不到 2 个名额时直接停下，因为后台评审加上主线和探索至少要这么多。
- **超时和没动静由 hook 盯，不靠主 agent 定期去问**。定期问进展会打断子代理、塞满主 agent 的上下文；hook 只在真有异常时提醒一次。
- **到时间上限默认让原来的子代理接着做**：它的上下文还在，最便宜；只有上下文已经很乱或者方向要变时才换人。每接着做一次算新的一段，重新计时。
- **同一个目标按条件原文识别**（Codex 按 createdAt）。Claude Code 在恢复会话和压缩上下文后，会重写一条设定目标的记录，旧版因此会把计时清零。暂停后、或者插了一个临时目标后，12 小时内用原文重新设置，也接着原来的开始时间算，已经启动的评审照常跑完。扩写条件（比如在后面加“成功后……”）也算同一个目标。
- **后台评审同一时间只有一个**，由 hook 在排他锁下登记。并行的工具调用、同一项目的多个会话都只会登记一次。登记后 20 分钟内要启动，时间上限从启动算起。hook 看到主 agent 启动了对应的子代理就自动记下，不会再催。子代理开始和交付时都要通过脚本核对这一轮还有效，作废或超时的结论写不进去。
- **提想法和拍板分开**：评审默认保持路线；侦察只提想法，不受这个约束。两者共用一个后台位置，侦察至少每 4 小时一次；想法池偏少时，评审之后插一次侦察。
- **一小时没有新结果，就不派评审**：没有新东西可评，改为发停滞提醒，因为按设计结果应该一直在流动。
- **压缩上下文后重新注入规则**：skill 的规则只在开始时读一次，长任务会压缩很多次，规则会慢慢淡掉。压缩后 hook 提醒主 agent 重读主循环、PROGRESS.md 和进度快照。
- **后台子代理用 `xhigh` 而不是 `max`**：它们每小时都要跑，`xhigh` 已经够用，开销小得多。
- **会话记录按字节位置增量扫描**：60 MB 的记录第一次扫描约 100 ms，之后约 60 ms。
- **不做“连续失败”提醒**：grep 没匹配、diff 有差异这类正常的非零退出也算失败，误报多了，agent 会连重要的提醒一起忽略。

## 从旧版升级

重新运行 `node install.mjs`，它会补上 SessionStart hook（Codex 需要在 `/hooks` 里信任这一条），并把后台子代理的思考强度改成 `xhigh`。“复盘”改名为“检查点”，不再按结果数和调用数触发；`retro.mjs done` 用法不变。新加的 `retro.mjs slots` 需要主 agent 在目标开始时运行一次，没运行时 hook 会提醒。

更早的版本把路线评审的状态记在 `route-review.md` 的第一行，现在改用 `.retro/slot` 和 `.retro/retro-done`，旧的状态行会被忽略。如果 PROGRESS.md 超过 4 KB，检查点提醒会要求先压缩：命令和环境移到手册，过程细节移到任务笔记。

## License

MIT
