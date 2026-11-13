# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-13

首个版本。

### 新增

- **三类记录**：每轮对话结束后自动压成记录行，写进 `<workspace>/memory/sessions/`，
  自动进入 memory-core 索引，可被 `memory_search` / `memory_get` 检索。
  - 行为类：用户这一轮做了什么（提出问题 / 要求执行任务 / 查询信息 / 反馈纠正）
  - 事实类：用户**明确说过**的偏好 / 关系 / 计划 / 决定
  - 助手结论类：助手**实际完成**用户交代的任务后得出的**可复用**结论，标「助手结论：」
- **不记录待办**、未完成的事、一次性结果。
- **事实只能来自用户发言** —— 助手说了什么，不许变成用户说过的话。
- 用户名 / agent 名 / 时间戳由插件自己拼，模型不碰。
- 两段式写入：`agent_end` 同步落 outbox（<10ms），调度器异步调模型压缩 ——
  不阻塞用户回复，Gateway 重启不丢数据。
- 失败重试 3 次后降级为「用户原话」，记忆不因模型不可用而消失。
- `config.userNames`：agentId → 用户显示名。

### 取代

- 官方 bundled `session-memory`（只在 `/new` / `reset` 时写，且写原文）
- 官方 `compaction.memoryFlush`（依赖模型自己写文件）

### 不改动

- embedding provider / model / `memory.search.*`
- `memory_search` / `memory_get`（仍由 memory-core 提供）
- `plugins.slots.memory`（memory-core 仍是唯一的 memory provider）

[0.1.0]: https://github.com/Mirr0ch1/better-auto-memory-openclaw/releases/tag/v0.1.0
