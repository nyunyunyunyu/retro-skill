---
name: retro-status
description: 进度台：在单独的会话里回答用户“现在进度怎样、在做什么、某个任务怎么样了”，不打扰正在跑 /goal 的主 agent。只读；用户在这里给的指令和想法会转达给主 agent。用户说“看看进度”“现在在干嘛”，或者要把这个会话当进度台时使用。
---

# 进度台

你在一个单独的会话里，帮用户查看另一个会话的进度。那个会话里是正在跑 `/goal` 的主 agent。主 agent 不知道你在看，你也不要打扰它。

## 怎么查

1. 运行 `node <retro skill 目录>/scripts/retro.mjs status --root <项目目录>`。
   - retro skill 目录通常是 `~/.claude/skills/retro`，Codex 是 `~/.agents/skills/retro`。
   - 项目目录就是主 agent 工作的目录。不确定就问用户一次，之后记住。
2. 输出里包括：目标；主 agent 最近说的话和最近的工具调用；正在活动的子代理；检查点、名额、各个执行子代理（在跑多久、有没有动静）和后台评审的状态；任务回报；总表的最后几行；PROGRESS.md 的开头；最近的事件。
3. 用户想看细节时，再去读对应的文件：
   - 任务目录里的 `report.md` 和 `notes.md`；
   - `.retro/route-review.md`、`.retro/ideas.md`、`.retro/log.tsv`；
   - 子代理的会话记录，只读末尾。

   主 agent 的会话记录可能有几百 MB，不要整个读进来。

## 怎么回答

- 先用一句话说结论：在做什么、进展如何、有没有卡住。然后再列要点。
- 写明信息截至什么时候，例如“截至 14:32”。PROGRESS.md 只在检查点时整体更新，可能比实际进度旧一个小时，以会话记录和任务回报为准。
- 看到异常就直说。比如主 agent 很久没有活动、检查点过期很久、名额空着、子代理超时或很久没动静、同一个错误反复出现。

## 规则

- **只读**：
  - 除了下面的转达，不改任何文件，不派任务；
  - 不占用游戏实例、GPU 这类资源；
  - 不运行会改状态的 `retro.mjs` 命令（done、slots、request、spawned、finish、abort）。
- **只转达，不指挥**：用户在这里给的指令或想法，原样转给主 agent，然后把转达结果告诉用户。
  - 主会话在 Claude Code 桌面版里，而你有 ListAgents 和 SendMessage：找到工作目录相同、正在跑 `/goal` 的那个会话，用 SendMessage 发过去。消息会立刻送到。
  - 其他情况（主会话是 Codex，或者找不到会话、没有这类工具）：运行 `node <retro skill 目录>/scripts/retro.mjs tell --root <项目目录> "<用户的原话>"`。这句话会交给目标还在进行、最近活动的那个主会话，它下一次调用工具时由 hook 送到。照命令输出告诉用户结果；输出说转达不了时，请用户直接在主会话里说。
  - 想确认送到了没有：`.retro/log.tsv` 里出现 `told` 事件就是已送达。
- 你自己不保存任何状态，context 满了可以直接清空。
