---
name: money-growth-autofix
description: money-growth 网站 bug 的最小复现、三分类定位与自动修复（仅外围代码，提交到 fix/* 分支）。TRIGGER when 录入/验证过程遇到 5xx、校验矛盾、API 行为与文档不符，或用户报告网站 bug 需要定位/修复时使用。
---

# money-growth 自动修复

> 修复动作全程受 `scripts/autofix/mg-branch-guard.mjs` 与 `scripts/autofix/mg-verify.mjs` 约束，不得手工绕过。

## 流程

### 1. bug 观察与最小复现
- 记录 `bugObservation = {symptom, request, response, logRef}`。
- 构造最小可复现请求（curl 或只读 API 调用），确认稳定复现。

### 2. 三分类定位（triage）
在 money-growth-system 源码中定位责任文件与根因，输出：

```json
{ "class": "a|b|c", "repro": "<curl>", "files": ["..."], "rootCause": "...", "rationale": "..." }
```

- **(a) 外围代码 bug**：纯函数、工具、类型、非破坏性逻辑错误 → 可进入自动修复。
- **(b) 业务逻辑 / 数据库结构或数据问题**：涉及快照写入语义、鉴权模型、D1 schema、历史口径 → **只报告，绝不自动修复**，终止于报告。
- **(c) 用法/数据问题**：调用方参数错误或数据本身异常，非代码 bug → 只报告并给出正确用法。

区分依据必须写入 `rationale`，防止把 (b)/(c) 误判为 (a)。

### 3. 修复（仅 class=a）
- 切到 `fix/<slug>` 分支：`node scripts/autofix/mg-branch-guard.mjs check`。
- 最小化 diff：只改与 bug 直接相关的行，禁止顺带重命名/格式化。
- 补/改对应 Vitest 用例锁定回归。

### 4. 四项验证（全绿才允许提交）

```bash
node scripts/autofix/mg-verify.mjs            # typecheck + build + vitest + 只读冒烟
```

任一失败（`E_VERIFY_FAILED`）：停止、保留本地现场、通知用户，不产生提交。

### 5. 提交与推送（受护栏约束）

```bash
git add <精确路径>
git commit -m "fix(<scope>): <描述>"
node scripts/autofix/mg-branch-guard.mjs assert-push origin fix/<slug>
git push origin fix/<slug>
```

## 约束（红线）

- 自动修复**只提交 fix/\* 分支**；禁止直接 push main/master、禁止自动合并、禁止 force push。
- 合并 fix/* 永远由用户在目标仓决定（Agent 侧无合并工具面）。
- (b)/(c) 类零代码改动；涉及数据库结构/数据的改动不允许自动修复。
- 凭据不进任何复现脚本、diff、日志。
- 冒烟只读（`mg-verify.mjs` 仅 GET /api/health），S7 测试禁止写线上站点。

## 自检命令

```bash
node scripts/autofix/mg-branch-guard.mjs check
node scripts/autofix/mg-verify.mjs --skip-smoke
```
