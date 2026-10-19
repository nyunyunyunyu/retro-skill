# retro-skill

A coordination layer for long coding tasks in Claude Code and Codex. The main agent stays responsive; subagents execute and investigate. Scripts record facts and raise reminders. Native `/goal` owns continuation and lifecycle.

retro 把长任务中的执行、观察和决定分开，让主 agent 能及时处理用户指令与回报。当前交付是 **两个 skill、hook、辅助脚本和两个评审角色**，用安装脚本部署；尚未打包成平台 plugin。

## 这一版的边界

- **必须保持响应**：主 agent 做沟通、短的证据核对、调度和验收；代码、测试、实验、深入调查和长复盘交给子代理。即使实现很小，也不顺手进入执行。
- **方法由主 agent 判断**：并发多少、探索多少、怎样验证、是否值得独立评审，以及什么时候换路线。没有固定探索比例、最低五代理配置、补满名额或评审批准门槛。
- **脚本记录事实并执行已授权规则**：计时、活动、回报、资源登记和过期状态。没有活动不等于卡死，有输出不等于有进展。明确停止、硬超时和用户启用的限次故障恢复按规则执行。
- **原生目标管理继续运行**：retro 的 Stop hook 不阻止结束一轮、不制造续跑提示；它在工具事件和压缩恢复时提供上下文。暂停与完成以原生目标机制为准。
- **信息按需加载**：主入口保留职责和目标，委派、瓶颈、评审、状态和平台细节拆到参考文件。

一个执行名额也能工作，评审可以与执行错开。没有可用子代理时，主 agent 应说明能力限制，不能默默独自进入长执行。

## 安装与使用

需要 PATH 上的 Node.js；读取 Codex 目标数据库需要 Node 22.13 以上（无需额外的 SQLite 实验开关）。

```bash
git clone https://github.com/nyunyunyunyu/retro-skill
node retro-skill/install.mjs --dry-run
node retro-skill/install.mjs
```

只安装一个平台用 `--codex` 或 `--claude`。安装器会复制两个 skill 及其参考文件、安装评审角色，并合并缺少的 hook；Claude 配置修改前备份为 `.bak-retro`，已有 Codex hook 条目保留。

| 内容 | Claude Code | Codex |
|---|---|---|
| skill | `~/.claude/skills/` | `~/.agents/skills/` |
| 评审角色 | `~/.claude/agents/*.md` | `~/.codex/agents/*.toml`，由同一份 Markdown 生成 |
| hook | `~/.claude/settings.json` | `~/.codex/hooks.json` |

`agents/claude/` 是两个平台共用的角色源文件，目录名表示源文件采用 Claude 的 Markdown 格式。Claude 安装时直接复制；Codex 安装时从同一文件生成 `name`、`description`、推理强度和正文指令，不照搬 Claude 专有的工具列表、后台与轮数参数。它们注册在平台的 **agent 列表**，不是另外两个 skill。

Codex 安装后在 `/hooks` 中信任新增条目，包括用于工具开始计时的 `PreToolUse`。旧条目的信任保留。新会话更适合确认 skill 和角色已经可用；旧会话是否发现新能力取决于平台刷新机制，fork 也不保证重新发现。

设定可验证的目标，再调用 retro：Codex 用 `$retro`，Claude Code 用 `/retro`。建议在项目常驻规则中写：

```text
- 设了 /goal 的长任务，开始时调用 retro skill；开始工作前先读 .retro/PROGRESS.md，不存在时兼容读取根目录的 PROGRESS.md。
- 评测或构建预计超过约 1 分钟时，放到后台运行，等待期间做不冲突的事；不要改它依赖的文件，也不要抢同一 GPU/CPU。
```

hook 是全局安装、按会话目标状态过滤的：没有活跃目标时不产生 retro 提醒。**这不等于 skill 自动加载或卸载**：无目标也可以显式请求一次诊断；已经读入的规则不会因关闭目标从上下文消失。恢复时读现场和需要的参考文件，不依赖“重开目标必然重新读完整 skill”。

看进度时，在同一项目的另一个会话使用 `retro-status`。它只读查看，用户明确要求转达的指令通过现有渠道交给主 agent，不替主 agent 执行。

## 模块

| 入口 | 用途 |
|---|---|
| [retro/SKILL.md](skills/retro/SKILL.md) | 职责边界、结果要求、灵活的主循环与收尾 |
| [execution.md](skills/retro/references/execution.md) | 委派、资源、验收与相称的验证 |
| [bottlenecks.md](skills/retro/references/bottlenecks.md) | 阶段计时、有效进度、资源证据、决策与复查 |
| [review.md](skills/retro/references/review.md) | 可选评审、登记协议、独立意见与路线决定 |
| [state.md](skills/retro/references/state.md) | PROGRESS、回报、想法、死路、积压和证据 |
| [platforms.md](skills/retro/references/platforms.md) | 平台等待、原生 goal、授权提醒与外部驱动 |
| [executor.md](skills/retro/templates/executor.md) | 执行者的范围、验证、回报和协作 |
| [route-reviewer](agents/claude/route-reviewer.md)、[idea-scout](agents/claude/idea-scout.md) | 独立路线评审与全局侦察；提供建议 |
| [retro-status](skills/retro-status/SKILL.md) | 独立的进度台 |

保留两个用户入口，参考文件不各自注册成 skill。执行者读自己的模板，主 agent 只按当前决策读取细节。

## 脚本提醒与决定

| 信号 | 脚本行为 | 主 agent 的责任 |
|---|---|---|
| 新结果且距检查点满 60 分钟 | 提醒整理，未处理每 10 分钟重复 | 读未处理回报、更新决定、`done`；深复盘委派 |
| 慢工具或命令满 10 分钟 | 不因输出、心跳或轮询重置；每次调用提醒一次，慢失败也记录 | 委派瓶颈分析，决定继续、缩小或优化 |
| 阶段超过 1 小时 | 观察提醒一次 | 核对任务约定与有效进度，决定是否续期 |
| 无活动 5 分钟，或等待工具且无活动 15 分钟 | 提醒；再次无活动可再次提示，**不自动打断** | 核实是否正常等待，再决定追问、停止或另派 |
| 名额未记录或空闲 | 10 分钟后提醒记录；空闲 5 分钟后提示，重复间隔 10 分钟 | 解释资源约束，安排有价值的工作或调整计划 |
| 后台评审机会 | 开始时登记侦察，之后每小时考虑一轮；可用 `request` 提前请求 | 有价值且有容量才启动，否则 `abort` |
| 过去一小时没有可见新结果 | 当轮不登记评审，报告观测 | 检查进度与等待原因，不据此判定路线失败 |
| 上下文压缩、用户转达 | 提示恢复入口与现场，交付转达内容 | 恢复状态、及时处理用户命令 |

评审种类沿用现有启发式：距上次侦察满 4 小时，或想法池少于 3 条且上轮不是侦察时，优先登记侦察。这只是可取消的机会，不要求为凑想法启动工作。登记 20 分钟未启动失效；启动后的路线评审/侦察有 20/40 分钟交付期限，过期报告不写入。

正常可响应时，目标是在长调用启动后 **20 分钟内完成第一次瓶颈判断**。hook 不能抢占前台长调用、权限等待或不可响应的模型；它不保证墙钟时间内强制唤醒。主 agent 用有界等待，耗时工作留给执行者。选择继续后留下复查点，由后续主循环处理；当前没有任意复查点的定时器。

Claude Code 可在后台运行 `retro.mjs watch`，让待判断的事件结束该后台命令；收到完成通知后，主 agent 查看 `status`，下一次工具事件送达提醒。Codex 使用原生子代理与有界等待。Stop 保留兼容注册但不输出续跑要求。

## 常用命令与状态

命令都带 `--root <项目绝对路径>`，脚本在 `skills/retro/scripts/` 下：

| 命令 | 作用 |
|---|---|
| `retro.mjs init` | 配置过程记录的 Git 本地排除，列出已经被跟踪的记录路径 |
| `retro.mjs status` | 目标、回报、执行者、评审和近期事件 |
| `retro.mjs inbox --session <会话>` / `done "<决定>" --session <会话>` | 该会话当前目标尚未处理的结果 / 标记检查点完成 |
| `retro.mjs slots <N> <理由>` | 记录并发计划，不强制用满或固定预留 |
| `retro.mjs request review\|scout` | 请求评审机会；仍由主 agent 启动 |
| `retro.mjs spawned <开始时间>` / `finish <开始时间> <报告文件>` / `abort <开始时间>` | 后台评审的归属、交付和取消 |
| `retro.mjs watch --session <会话>` | Claude 后台运行监控 |
| `retro.mjs metrics [--since <时间>]` | 事后统计，不能单独证明进展或正确性 |
| `retro.mjs tell "<用户原话>"` | 进度台转达；下一次主 agent 工具事件交付 |
| `codex-recover.mjs start\|status\|stop` | 为当前本机 Codex 目标启用、查看或停用临时故障恢复 |

`.retro/PROGRESS.md` 是主 agent 的简短恢复快照，不存在时兼容读取根目录旧版 `PROGRESS.md`。任务细节在 `.retro/tasks/<任务>/`。想法池、积压与结果表按需要维护，具体归属见 [state.md](skills/retro/references/state.md)。`.retro/` 由主 checkout 与 worktree 共用，新建时写入忽略规则；会话提醒和追踪文件在系统临时目录。不要手改脚本维护的登记和锁。

并行执行者各自在任务 `notes.md` 记录方法和踩坑，回报后由主 agent 按需要指派一名执行者合并到共享 RUNBOOK；其他执行者只读手册。影响当前工作的发现及时回报，不等到收尾才共享。

过程记录默认不纳入版本控制。Git 项目写记录前运行 `retro.mjs init --root <项目>`，将 `.retro/` 和旧布局的 PROGRESS.md、RUNBOOK.md、runbook/、results.tsv 加入本地 `info/exclude`；不修改项目 `.gitignore`，同仓库 worktree 共用。新进度与工作手册分别放 `.retro/PROGRESS.md`、`.retro/RUNBOOK.md`，中间笔记与报告也留在 `.retro/`。已跟踪文件会被列出，确认属于过程记录后仅取消索引跟踪，保留本地文件。代码、测试、AGENTS.md 中的项目规则和正式交付文档照常按需提交。

检查点及上轮评审的读取位置按会话和目标分别保存。`inbox`、`done` 在只有一个候选主会话时可以省略 `--session`，多个候选时会要求明确指定；后台 `inbox --since-last review|scout` 从当前登记取得归属。升级后无法归属的旧读取位置不沿用，首次可能重读当前目标已有的回报。报告和结果表仍在项目内共享，读取位置不代表报告归属。

`tell` 排队时绑定会话和目标身份；交付时目标已变更，或旧格式消息缺少目标身份，会存入 `.retro/user-said.md` 并标为未送达，不自动交给新目标执行。

等待用户授权时，记录待授权事项并继续独立工作。有项目追问约定就按它安排真实的一次性提醒；没有可用定时能力时说明未设定，不能只写笔记就声称已安排。

## Codex 主会话服务中断恢复（可选）

用户要求服务中断后自动继续时，在对应桌面会话运行 `node <skill>/scripts/codex-recover.mjs start --root <项目>`。独立监控只处理 **active goal 的明确临时故障**，以 30/60/120 秒退避向原会话发继续消息，每个目标最多 3 次。普通 hook 不能在会话 idle 时启动新轮次，所以这项能力不依赖 Stop hook 或主 agent 自己醒来。

paused、预算或额度限制、安全阻止、未知错误都不自动继续；真正暂停的 goal 仍由用户 `/goal resume`。桌面关闭或接口失效时停止。此实现使用本机桌面内部管道，已核对 `0.163.0-alpha.10.2` 的会话读取接口；实际故障恢复仍需真实场景验证。权限、竞态与重新启用规则见 [平台接入](skills/retro/references/platforms.md#临时服务故障恢复)。安装器会复制该脚本，但不会为所有会话自动启用。

## Claude 调度 Codex 执行（可选）

Codex 当主 agent 通常使用原生子代理。只有用户选择跨平台执行时使用 `codex-worker.mjs`：

```text
codex-worker.mjs run <任务> --root <项目> [--cd <worktree>] [--timeout <分钟>]
codex-worker.mjs resume <任务> "<追问>" --root <项目>
codex-worker.mjs stop <任务> --root <项目>
```

先写 `.retro/tasks/<任务>/brief.md`，run/resume 在后台运行。驱动登记线程、命令、rollout 活动和心跳，事件存到 `codex-events.jsonl`，最后消息存到 `codex-last.md`。**静默不再自动 stop/resume**；心跳与模型活动分开记录，让 hook 提醒主 agent 判断。

每次 run/resume 默认 **120 分钟硬超时**，可用 `--timeout` 改变。显式 stop 或硬超时尝试终止进程树，未落盘结果可能丢失。运行中的线程不能直接收追问，需要等结束或明确停止后再 resume。驱动失联时，停止结果仍须核对实际进程。

外部驱动沿用以下权限设置，选择这条路径前应了解：

- `approval_policy="never"`，不能交互批准。
- 默认 `workspace-write`，开启网络，把仓库共用 git 目录及工作目录外的 `.retro/` 加入可写根。git 目录可写也意味着能改其他分支、配置和 Git hook。
- `RETRO_CODEX` 显式设置的 `sandbox_mode`、`sandbox_workspace_write.network_access`、`sandbox_workspace_write.writable_roots` 不被驱动覆盖；驱动提供的可写根会替换配置中的同名列表。

Windows 默认查找桌面版目录中同时含 `codex.exe` 和 `codex-code-mode-host.exe` 的版本，并带上对应功能开关；找不到或其他系统用 PATH 上的 codex。可用 `RETRO_CODEX` 指定可执行文件或 JSON 数组，例如 `["C:/tools/codex.exe", "-c", "model_reasoning_effort=\"high\""]`；指定后不再自动发现。模型与思考强度沿用 Codex 配置。

其他驱动可使用 `retro.mjs worker start|beat|stop` 登记；未提供进程号时，60 分钟无心跳视为失联。旧登记格式仍可读，新驱动可额外报告 `activityAt` 和 `waiting`，区分心跳与真实活动。

## 验证与限制

`node test/run.mjs` 使用临时项目、合成 hook 事件和假的 Codex，覆盖目标过滤、提醒去重、评审锁、安装、驱动活动和显式停止。`node test/recovery.mjs` 使用模拟桌面管道验证独立进程的恢复、退避、暂停与发送失败去重，不向真实会话发消息。`node test/codex-live.mjs` 是可选真实 Codex 检查，会耗时和使用额度；合成测试通过不能代替真实平台长程验证。

- 目标与活动读取依赖 Claude/Codex 内部记录、Codex 目标数据库和 rollout 格式。平台变化可能让检测失效。
- hook 只能在平台提供的事件触发。代码模式的外层 exec 单元不一定触发，不能把所有命令都看见作为前提。
- 子代理追踪可能滞后；外部执行者按项目登记，同项目多个目标会话可能看到同一执行者。
- Claude 同一目标文本在 12 小时内重设沿用旧计时；不能可靠区分“恢复”与“从头开始”。Codex 使用目标创建时间。
- 取消目标会停止后续提醒，不自动取消已运行的进程，也不会清空上下文；主 agent 要安排执行者收尾。

## License

MIT
