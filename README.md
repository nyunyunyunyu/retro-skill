# retro-skill

An enhancement for `/goal` in [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex). `/goal` keeps the agent working until a condition is met; retro organizes that long run. The main agent only decides and delegates, in an explicit main loop. Subagents execute and report observations and ideas. A hook reminds the main agent of a checkpoint at most hourly, when something came back, watches slots and subagents, and schedules a background route review or idea scout every hour. Verification is kept proportional to what it protects. A separate session can answer progress questions without disturbing the run.

`/goal` 的增强插件。`/goal` 负责一直干到完成；retro 负责把这段长时间的工作组织好：
- 主 agent 只决策和调度，按固定的主循环转，上下文留给方向；
- 执行子代理干活，回报结果、观察和想法；
- hook 在有新结果时最多每小时提醒一次检查点，盯着名额和子代理，每小时在后台安排一次路线评审或全局侦察；
- 验证和它保护的东西相称，不在验证上空耗；
- 可以另开一个会话随时看进度，不打扰主 agent。

## 分工

| | `/goal`（原生） | retro（本插件） |
|---|---|---|
| 一直干到完成、判断是否达成 | ✅ | — |
| 暂停、清除、恢复会话后保留 | ✅ `/goal clear`（Codex 也可以 `/goal pause`） | — |
| 等后台任务时唤醒 | ✅ 仅 Claude Code（默认 30 分钟，可以改成 10 分钟，见安装） | — |
| 主 agent 只调度，子代理执行并回报 | — | ✅ skill 规则和统一的执行模板 |
| 检查点、名额、子代理、后台评审的提醒 | — | ✅ 见下表 |
| 想法池和探索 | — | ✅ 默认约三分之一的名额验证新想法；死路由侦察定期复查 |
| 验证不过度 | — | ✅ 探索、采纳、最终三档；全量只跑一层；不急的问题进积压 |
| 等授权时不干等 | — | ✅ 记进“待授权”，30 分钟和 2 小时后各追问一次 |
| 进度台 | — | ✅ 单独的会话只读查看进度，并转达用户的话 |

retro 只在会话有活跃的 `/goal` 时生效，目标结束就自动停。

### hook 什么时候提醒

| 提醒 | 什么时候 | 重复 |
|---|---|---|
| 检查点到期 | 距上次检查点（`retro.mjs done`）或目标开始满 60 分钟，并且这期间有新结果 | 没做之前每 10 分钟一次；一轮结束时也拦一次 |
| 后台评审登记 | 目标开始时一次侦察；之后每小时一次，距上次侦察满 4 小时或想法池少于 3 条时侦察，否则路线评审；`retro.mjs request` 可以提前要 | 没启动就每 10 分钟提醒，一轮结束时也拦一次；20 分钟后作废 |
| 停滞 | 到了每小时那一轮，而过去一小时没有任何新结果 | 代替那一轮评审 |
| 记下名额 | 目标开始 10 分钟还没运行 `retro.mjs slots` | 每 10 分钟一次 |
| 名额空着 | 在跑的执行者（子代理和 Codex 执行者）少于名额超过 5 分钟（从最近一次空出名额或派任务算起） | 每 10 分钟一次 |
| 一段超时 | 一个执行者连续跑了 1 小时还没交回 | 每段一次 |
| 慢测试等瓶颈 | 工具或后台命令启动满 10 分钟、还没收到完成记录；输出、心跳和轮询不重置计时。让主 agent 检查进度、预计剩余时间、资源占用和更便宜的验证方案；不自动杀任务。已经返回但耗时超过门槛的也会报告 | 每次调用一次，写入 `tool-slow` 日志 |
| 没动静 | 一个执行者 5 分钟什么都没做、也没有在等工具，或者一个工具调用 15 分钟没返回：打断它问一句，它带着上下文接着做；问过之后还是没动静，就换人。驱动跑的 Codex 线程由驱动自己问（见下面） | 每次一次 |
| 工具调用太久 | 一个 Claude 子代理的工具调用跑了 5 分钟以上：直接问这个子代理为什么这么久，让它记进 notes.md | 每次 |
| 没开 watch | Claude Code 里一轮结束时有执行者在跑（或者刚派了任务），后台却没有 `retro.mjs watch` | 一轮结束时拦 |
| 上下文被压缩 | 压缩之后 | 每次压缩 |
| 子代理上限太低 | harness 允许的子代理数减 3 后不到 2 | 每 10 分钟一次，其他提醒都停 |
| 进度台转达 | 用户在进度台说了话 | 送到一次 |

hook 只能在主 agent 调用工具之后和一轮结束时说话；主 agent 长时间等待时，提醒在它下一次活动时送到。Claude Code 里主 agent 结束一轮后，靠后台的 `retro.mjs watch` 叫醒它：watch 一直盯着执行者，有超时、没动静要处理就结束，命令结束会把主 agent 叫醒。主 agent 看不到后台命令的输出，所以要处理什么仍由 hook 在它下一次调用工具或结束这一轮时说。

瓶颈提醒后的分析流程见 [retro skill 第 7 节](skills/retro/SKILL.md#7-瓶颈分析和迭代速度)：按阶段定位耗时，用实际进度和资源证据决定继续、缩小验证或优化，并在任务笔记里留下复查点。多次短调用累计的等待也要分析；加速前后核对结果和必要覆盖，避免把少测当成变快。

## 安装

需要 Node.js 在 PATH 上；Codex 要读它的目标数据库，需要 Node 22.5 以上。

```bash
git clone https://github.com/nyunyunyunyu/retro-skill
```

```bash
node retro-skill/install.mjs
```

安装脚本对已有的 `~/.claude`、`~/.codex` 分别复制两个 skill、安装两个后台子代理（Codex 版生成 `.toml`），补上缺少的 hook（`settings.json` 改之前备份为 `.bak-retro`；`hooks.json` 里已有的条目不动），子代理上限不够时打印警告。只装其中一个就加 `--claude` 或 `--codex`；想先看会改什么，加 `--dry-run`。

安装后：
- **Codex**：在 `/hooks` 里信任安装脚本新加的条目，Codex 不运行没被信任的条目。以后升级脚本不用重新信任。再把子代理上限调到至少 5，建议 12（见下表）。
- **升级慢工具检测**：新增的 `PreToolUse` 负责在命令开始前计时，Codex 需要在 `/hooks` 里单独信任这条新记录。主 agent 等待结果每次不超过 5 分钟，正常运行时在 10 分钟门槛之后的下次活动收到提醒，给 20 分钟内处理留出余量；权限请求、长前台工具调用等阻塞仍会延迟送达。
- **Claude Code**：如果 `~/.claude/agents/` 是这次新建的，已经在运行的会话要重启一次。
- **（可选）** 在 `~/.claude/settings.json` 的 `env` 里加 `"CLAUDE_CODE_GOAL_CHECKIN_MINUTES": "10"`，让 `/goal` 等后台任务时第一次检查提前到 10 分钟（需要 Claude Code v2.1.234 以上）。
- **（可选）** 在 `~/.claude/CLAUDE.md` 或 `~/.codex/AGENTS.md` 加上[常驻规则](#常驻规则)。

## 用法

```text
/goal tests/auth 全部通过，npm test 退出码为 0
```

设了目标后，retro 自动生效。建议一开始就调用一次 retro（Claude Code：`/retro`；Codex：`$retro`），建立 `PROGRESS.md`。条件要可验证，并写明怎么证明：Claude Code 的 `/goal` 由一个独立的模型看对话内容判断，它不会自己去跑命令。想限制并行，就写进条件里，比如“最多并行 4 个”。

- **看进度**：在同一个项目目录里另开一个会话，说“用 retro-status 看看进度”。打开 Remote Control 后用手机也能问。在进度台里说的指令会转给主 agent。
- **临时插一件事**：直接给主 agent 发消息，不要用 `/goal`，新设的目标会覆盖原来的。Claude Code 没有 `/goal resume`，要恢复就用 `/goal` 加原文重新设置，原文在 PROGRESS.md 的“目标”一栏。
- **暂停**：`/goal clear`（Codex：`/goal pause`）。只按 Esc 不够：后台任务还在跑时 `/goal` 可能把 agent 唤醒，你再发任何消息它也会接着干。12 小时内用同一条件重新设置，retro 当作同一个目标接着算。
- **结束**：目标达成后，主 agent 停掉子代理、写最终报告，retro 随之停止。

## 组成

- **retro skill**（`skills/retro/SKILL.md`）：主 agent 的规则：角色和用户输入、主循环和检查点、委派和回报、验证、路线评审、想法池和积压、迭代速度、等待授权、文件格式。
- **执行模板**（`skills/retro/templates/executor.md`）：执行子代理怎么做、怎么验证、什么时候回报、回报格式。
- **后台子代理**（思考强度 `xhigh`，只在 `.retro/probes/` 下做轻量探测，交付时由脚本核对这一轮仍然有效）：
  - 报告之外，细节写在 `.retro/probes/` 下，报告最后一行给出路径。
  - `route-reviewer`：对照想法池给出结论：保持、调整优先级、先探测、换路线，默认保持；也看名额流动、迭代速度和验证占的时间。限 20 分钟。
  - `idea-scout`：从差距分解、假设审计、外部经验、换个问法、从零开始、复查死路六个角度找想法，只提不拍板。限 40 分钟。
- **提醒 hook**（`scripts/retro-nudge.mjs`）：注册 PreToolUse、PostToolUse、Stop、SubagentStop、SessionStart（只在压缩后），Claude Code 另注册 PostToolUseFailure。分别记录工具起止和执行者活动，失败的慢调用也上报。从会话记录判断有没有活跃的 `/goal`（Codex 以目标数据库 `~/.codex/goals_1.sqlite` 为准），追踪子代理，检测 `/goal` 被替换或误用 `/goal resume`。
- **辅助脚本**（`scripts/retro.mjs`）：`watch` 在后台盯着执行者，需要时叫醒主 agent（Claude Code）；`worker start|beat|stop` 给别的驱动登记外部执行者；`done` 标记检查点完成；`inbox` 列出上次检查点以来的回报（后台子代理用 `--since-last review|scout` 看上一轮以来的）；`slots` 记下名额；`request review|scout` 提前要一次后台评审；`status` 进度快照；`metrics [--since <时间>]` 整个运行的统计，供事后分析；`tell` 进度台转达用户的话；`spawned`、`finish`、`abort` 给后台子代理用。
- **Codex 执行驱动**（`scripts/codex-worker.mjs`）：Claude Code 当主 agent 时，把执行任务交给 Codex 线程，见下面的“Claude Code 调度、Codex 执行”。
- **进度台 skill**（`skills/retro-status`）：在另一个会话里只读地回答“现在进度怎样”，把用户的指令转给主 agent。

## Claude Code 和 Codex

| | Claude Code | Codex |
|---|---|---|
| 装到哪 | `~/.claude/skills`、`~/.claude/agents`、`~/.claude/settings.json` | `~/.agents/skills`、`~/.codex/agents/*.toml`、`~/.codex/hooks.json` |
| hook 生效 | 安装后马上生效 | 新加的条目要在 `/hooks` 里信任一次 |
| 子代理上限（名额最多是上限减 3） | 默认 20，环境变量 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 默认 3，**不够用**：在 `~/.codex/config.toml` 加 `[agents]` 和 `max_concurrent_threads_per_session = 12` |
| 主 agent 怎么等 | 结束这一轮，子代理交回、`retro.mjs watch` 退出或 `/goal` 定期检查时被唤醒 | `wait_agent` 加不超过 5 分钟的超时（环境上限更短时按更短的） |
| 判断目标达成 | 独立的模型看对话 | agent 自己标记完成 |
| 进度台转达 | 桌面版里用 SendMessage，立刻送到；否则走 `retro.mjs tell` | 走 `retro.mjs tell`，主 agent 下一次调用工具时送到 |

### Claude Code 调度、Codex 执行

Claude Code 当主 agent，负责调度、核实和后台评审，执行任务交给 Codex：在 `/goal` 条件或对话里告诉它“执行交给 Codex”。主 agent 把任务说明写进 `.retro/tasks/<任务>/brief.md`，在后台运行 `codex-worker.mjs run <任务>`；命令结束时，Claude Code 用新的一轮通知它（通知里只有退出码和输出文件的路径），`/goal` 也会等后台命令跑完。追问用 `resume <任务> "<话>"`，接着同一个线程；停掉用 `stop <任务>`。

驱动做的事：
- 用 `codex exec --json` 跑一轮，`approval_policy` 设为 `never`：没人能回答确认请求，不设的话命令会一直卡在等确认。
- 沙箱是 `workspace-write`，让执行者有和 Claude 执行子代理差不多的权限：
  - 这个沙箱默认断网（实测连域名都解析不了），驱动打开 `sandbox_workspace_write.network_access`，装依赖、拉代码、查资料才做得了。
  - 它还把 `.git` 设成只读（实测 `git add` 报 Permission denied），执行者提交不了，所以驱动把仓库的 git 目录（worktree 共用的那个）加进可写目录。这样它也能改 `.git` 里的 hook、配置（会在沙箱外执行）和所有分支。
  - 工作目录（`--cd`）不包含项目的 `.retro/` 时（比如 worktree），`.retro/` 也加进去，回报才写得进去。
  - 这些可写目录会替换你配置里的 `writable_roots`。`RETRO_CODEX` 里自己给了 `sandbox_mode`、`network_access` 或 `writable_roots` 的，驱动就不加自己的那一项；想收紧，就在那里写上。
- 把线程登记在 `.retro/workers/<任务>.json`：hook 把它算进名额，一段超过 1 小时时提醒主 agent，检查点也能看到它交回。驱动进程没了，就算它停了。
- 没动静时自己问。驱动读 Codex 自己的 rollout（`~/.codex/sessions/…/rollout-…-<线程>.jsonl`），Codex 的每一步都在里面，包括轮询还在跑的命令，`--json` 事件里没有这些。没动静时（门槛同上面的提醒表），驱动就停掉这一轮，接着同一个线程问它在做什么、卡在哪里，让它答完接着做，回答写在最后的输出里。问过之后它什么都没做又没动静，就按“卡住了”结束。找不到 rollout 时改看 `--json` 事件，正在跑的命令算作在等工具。
- `stop` 让正在跑的驱动结束这个线程和它起的所有进程。驱动已经不在了的：Windows 上 codex 会随驱动一起结束；其他系统上先确认那还是这一段启动的 codex 进程，才结束它的进程组，免得误伤用了同一个进程号的别的程序。
- codex 退出后，驱动最多再等 2 秒读完输出就交回，不会被它留在后台的进程拖住。
- 事件存在任务目录的 `codex-events.jsonl`（命令输出太长的截断），最后一条消息存在 `codex-last.md`；超过一天的登记会被清掉，`resume` 从事件里找回线程。一轮超过 2 小时会被强制停掉，作为兜底。

**用哪个 codex**：一般不用配。
- Windows 上，驱动用 Codex 桌面版自带的那份：在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<版本目录>\` 里找同时有 `codex.exe` 和 `codex-code-mode-host.exe` 的、最新的一个，带上桌面版启动它时用的两个开关（`features.code_mode_host`、`features.prefer_mxc`）。版本目录每次更新都会变，所以每次现找。单独装的 CLI（比如 `~/.local/bin/codex.exe`）可能缺 `codex-code-mode-host.exe`，跑不了任何命令，所以不优先用它。
- 找不到桌面版，或者不是 Windows，就用 PATH 上的 `codex`。
- 要指定，就设环境变量 `RETRO_CODEX`（比如写在 `~/.claude/settings.json` 的 `env` 里）：一个可执行文件，或者 JSON 数组（可执行文件加前置参数），比如 `["C:/tools/codex.exe", "-c", "model_reasoning_effort=\"high\""]`。设了它就不再自动找，桌面版的两个开关也要自己写上。
- 模型和思考强度用 Codex 自己的配置。

**别的驱动**（比如走 Codex app-server）：每个线程开始时运行 `retro.mjs worker start <任务> [说明] --pid <驱动进程> --type <类型>`，有动静时 `worker beat <任务>`（至少每 5 分钟一次，跑长命令时也要，否则算没动静），结束时 `worker stop <任务>`。不给 `--pid` 的，60 分钟没动静就算停了。

**测试**：`node test/run.mjs` 用一个假的 codex 测驱动；`node test/codex-live.mjs` 用真的 Codex 跑一遍派任务、回报、检查点、追问、长命令不算没动静、卡住时的追问和停掉，要十几分钟，会用一点 Codex 额度。

## 项目里的文件

| 文件 | 谁写 | 内容 |
|---|---|---|
| `PROGRESS.md`（项目根目录） | 主 agent | 方向快照，不超过 4 KB |
| `RUNBOOK.md` 和 `runbook/` | 改了运行方法的子代理 | 手册：`RUNBOOK.md` 只做索引，构建、测试、评测、代码地图放在 `runbook/` 下 |
| 项目的 `AGENTS.md` | 主 agent 交给子代理写 | 所有代理都要遵守的规则；`CLAUDE.md` 里写 `@AGENTS.md` |
| `.retro/ideas.md` | 主 agent | 想法池和死路 |
| `.retro/backlog.md` | 主 agent；重评时交给子代理 | 积压：不急着修的问题 |
| `.retro/results.tsv` | 评测脚本 | 影响决策的数字，一次评测一行 |
| `.retro/tasks/<任务>/` | 执行子代理 | `report.md`、`notes.md`、原始数据；Codex 执行时还有 `brief.md`、`codex-events.jsonl`、`codex-last.md` |
| `.retro/workers/` | `codex-worker.mjs` 或别的驱动 | 外部执行者的状态 |
| `.retro/route-review.md`、`reviews/`、`tasks/scout-*/` | 后台子代理，经由脚本写入 | 评审和侦察报告 |
| `.retro/probes/` | 后台子代理 | 探测脚本，评审和侦察的细节 |
| `.retro/` 里的其他文件 | hook 和脚本 | 状态和事件日志，不要手改 |

`.retro/` 不进 git，所有分支和 worktree 共用一份。hook 新建 `.retro/` 时放一个忽略全部内容的 `.gitignore`；已有的 `.retro/` 没有 `.gitignore` 时，只忽略脚本和代理生成的文件。每个会话的提醒记录、子代理追踪和 watch 的进程号放在系统临时目录（`claude-retro-<会话>.*`）。

## 常驻规则

```
- 设了 /goal 的长任务，开始时调用 retro skill；项目根目录有 PROGRESS.md 时，开始工作前先读它。
- 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做别的探索，不要空等；期间不要改它依赖的文件，也不要跑抢同一 GPU/CPU 的任务。
- 长任务中需要用户授权才能继续时，不要干等：把事项记进 PROGRESS.md 的“待授权”，在回复里提一次，然后继续做不依赖它的事；没有答复的，满 30 分钟和满 2 小时时各合并再请求一次（用两个一次性定时提醒），之后不再追问。
```

## 已知限制

- **依赖没有公开文档的内部格式**：Claude Code 的 `goal_status` 和 `Goal cleared` 记录，Codex 的 `thread_goal_updated` 事件和目标数据库。格式一变，hook 会安静地失效。
- **hook 只在工具调用之后和一轮结束时说话**：Codex 用代码模式时，`exec` 单元本身不触发 hook。
- **子代理追踪是推断的**：子代理被直接停掉、没有触发 SubagentStop 时，会先显示为“没动静”，一小时后才不算在跑。停掉时触发了的，被叫回来之后要到它下一次调用工具才重新算在跑，这之间卡住看不到。
- **同一个项目里同时有两个会话在跑目标时，Codex 执行者会算进两边的名额**：登记按项目记，不按会话；Claude 子代理没有这个问题。
- **Codex 执行者跑着的时候收不到消息**：追问要等这一轮结束；急的话停掉再 `resume`，上下文还在，只丢掉手头这一步。
- **Codex 里子代理交回的结论只在主 agent 活动时送到**；`/goal` 会自己开下一轮，所以不会卡住。
- **agent 卡在一次工具调用中间时**（例如权限弹窗等你确认），没有机制能唤醒它。用 Claude Code 的自动模式可以避免。
- **token 开销和并行数成正比**：名额为 N 时，消耗约是单个 agent 的 N 倍，后台评审再加一份。想省就在 `/goal` 条件里写并行上限；Codex 也可以给目标设 token 预算。
- **结束时可能多一轮**：Stop hook 拦截和 `/goal` 判定达成同时发生时，可能会多跑一轮。

## 设计取舍

- **检查点按时间触发，没有新结果就不触发**：主 agent 只调度时，回报数和调用次数都不反映该不该整理，按调用次数触发在 Codex 试运行里 6 分钟就触发了。没有新结果时没东西可整理，名额空着和停滞另有提醒。
- **检查点不改路线**：换路线交给后台的路线评审，并且要满足门槛，以免频繁换路线。
- **检查点用 `retro.mjs done` 显式标记**：旧版把任何一次写 PROGRESS.md 都算完成，实测一天写了 58 次，提醒从来触发不了。
- **提醒按种类限频**：同一种最多 10 分钟一次。只有到期的检查点和没启动的评审在一轮结束时还会拦一次；名额空着之类的不拦，否则主 agent 有意少开名额时每一轮都会被拦。
- **兜底拦截不会循环**：`/goal` 让 `stop_hook_active` 一直是 true，分不出轮次，所以 hook 自己记录：上次拦截之后主 agent 调用过工具，才会再拦。
- **名额由主 agent 定、hook 来查**：只有主 agent 知道资源情况。不到 2 个名额时直接停下，因为后台评审、主线和探索至少要这么多。
- **超时和没动静由脚本盯**：主 agent 定期问进展会打断子代理、塞满自己的上下文。
- **在等工具不算没动静**：问话要打断执行者，因为 Claude 子代理到下一步才收到消息，Codex 一轮之中收不到。所以只在它真的什么都没做时问；工具调用跑得久的，等它返回时由 hook 直接问它为什么这么久。Claude Code 的前台命令 10 分钟会转后台，Codex 轮询一次最多等 5 分钟，所以工具调用 15 分钟没返回才算卡住。
- **用后台命令叫醒主 agent**：hook 只在事件发生时运行，卡住的执行者不产生事件。Claude Code 把后台命令的结束当作新的一轮送给主 agent，这是叫醒已经结束一轮的主 agent 的唯一办法，所以由 `retro.mjs watch` 来盯。
- **到时间上限默认让原来的子代理接着做**：它的上下文最便宜。
- **同一个目标按条件原文识别**（Codex 按 createdAt）：Claude Code 恢复会话和压缩后会重写设定目标的记录；暂停后 12 小时内用原文重设，也接着原来的开始时间算。
- **后台评审同一时间只有一个**，在排他锁下登记；子代理开始和交付时都由脚本核对这一轮还有效，作废的结论写不进去。
- **提想法和拍板分开**：评审默认保持路线，侦察只提想法。一小时没有新结果时不派评审，改发停滞提醒。
- **复查点之前只换验证过的路线**：门槛防的是凭推测换来换去。按事先写好的标准验证成立的备选路线，评审判断收益明显超过切换成本就可以换；验证成立时主 agent 马上要一次评审，不等下一个整点。侦察指出的最危险的假设会马上被检验，证伪了按“推翻前提”处理。
- **压缩上下文后重新注入规则**：长任务会压缩很多次，开始时读过的规则会慢慢淡掉。
- **验证和它保护的东西相称**：实测中，一个大重构把一天的大部分时间花在验证上：每个任务都跑全套证明，执行者和核实者各跑一遍全量，评审的小问题变成加固任务，加固完又被评审，几小时的评测到最后才失败。所以有三档验证、全量只跑一层、验证工具审过就冻结、问题按影响分流；怎么验证由主 agent 判断，不给公式。
- **积压单独一个文件**：后台评审每小时都读想法池，不急的问题放在一起会让它越来越长。积压在里程碑和目标达成前由子代理重评。
- **死路写重试条件，由侦察复查**：判定死路的评测可能有 bug，失败也可能只是当时条件不够，好想法不该永远被埋掉。
- **后台子代理用 `xhigh` 而不是 `max`**：每小时都要跑，`xhigh` 够用，开销小得多。
- **主 agent 先摸底再定路线，并且会被检查**：主 agent 只看摘要，最容易出问题的是第一条路线拍脑袋、凭自评的回报下结论、压缩后理解缩水。所以目标开始时先派摸底任务，PROGRESS.md 维护一行定量的差距，检查点抽查一份回报的原始证据，路线评审顺带检查主 agent 关键决定的依据。
- **指标事后算，不放进 hook**：`retro.mjs metrics` 从事件日志、评审存档和任务回报里算检查点、后台评审、名额利用率、核实结果等。主 agent 的决定被推翻了几次、任务说明是否要反复澄清这类要理解语义的，结束后派一个子代理读这些材料判断。
- **Codex 执行用驱动登记，而不是让 hook 去读 Codex 的会话记录**：`codex exec` 的线程没有父线程，hook 也看不到它的工具调用；驱动最清楚一轮什么时候开始和结束、正在跑什么命令。登记接口是通用的，别的驱动也能接进来。
- **不做“连续失败”提醒**：grep 没匹配、diff 有差异这类正常的非零退出太多，误报会让 agent 连重要的提醒一起忽略。

## 从旧版升级

重新运行 `node install.mjs`。在 Codex 里，新加的 hook 条目要到 `/hooks` 信任一次。想法池里旧的“积压”一栏，主 agent 会移到 `.retro/backlog.md`。更早版本记在 `route-review.md` 第一行的评审状态会被忽略。

## License

MIT
