# PATCHES — vendor 本地补丁登记表

> 仅登记对上游源码/清单的必要本地改动；升级上游时逐条核对，能合入上游的先合入。

| # | 文件 | 改动 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | `src/hooks/useAuth.tsx` | 新增可选 `AuthDriver` 注入点（probe/login/logout）；上下文新增 `role`（account?.role）与 `reload`；driver 模式关闭本地 register/resetPassword | 本项目为服务端权威认证（D1 sessions + REST `/api/auth/*`），复用上游四态机但注入 REST 驱动（`src/adapters/auth/restAuthDriver.ts`）；角色路由（viewer 只读）需要 role；首次初始化完成后需 reload 刷新状态机 | 本项目使用 |
| 2 | `src/components/RecordList.tsx` | 删除确认改为外部注入：新增可选 `confirmDelete(id)` prop，注入时跳过 `window.confirm` 直接执行 `onDelete`；缺省保持上游行为 | 统一 ConfirmDialog 交互（本项目 AiPage 删除经 ConfirmDialog 二次确认，避免原生 confirm） | 本项目使用 |
| 3 | `package.json` | exports 增补 finance 六条子路径；`peerDependencies` 增补 `echarts>=5.5.0` + `peerDependenciesMeta.echarts.optional=true` | finance 六组件内部按需引入 ECharts；子路径导入 + optional peer（未装 echarts 的消费方主入口不污染），与上游 recharts/@xyflow/react/flexsearch 的 optional 模式一致 | 本项目使用（上游待合入） |
| 4 | `src/components/Layout.tsx` | 新增 `NavGroup` 类型与可选 `navGroups` prop（分组标题 + 子导航项渲染），兼容原 `navItems` 形态 | 本项目导航需按「概览/数据录入/数据分析/系统设置」分组展示（admin 4 组 / viewer 1 组），上游为扁平 navItems | 本项目使用（上游待合入） |
