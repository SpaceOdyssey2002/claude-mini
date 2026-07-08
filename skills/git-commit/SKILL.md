---
name: git-commit
description: 写规范的 Git 提交信息（Conventional Commits 风格）
---

# 规范的 Git 提交信息

当用户需要写 git commit message 时，按 Conventional Commits 规范生成：

格式：`<type>(<scope>): <subject>`

- **type** 取值：
  - `feat` 新功能
  - `fix` 修 bug
  - `docs` 文档
  - `refactor` 重构（不改行为）
  - `test` 测试
  - `chore` 杂项/构建
- **scope**：影响范围（可选），如模块名
- **subject**：祈使句、简洁、不超过 50 字，结尾不加句号

如改动较复杂，空一行后写正文，说明「为什么」而不仅是「做了什么」。

示例：

```
feat(agent): 增加并行子 agent 支持

原先多个子任务只能串行，长调查很慢。
改为 spawn_agents 用 Promise.all 同时跑，wall-clock 取决于最慢的一个。
```
