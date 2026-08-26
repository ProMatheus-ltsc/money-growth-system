# @shared/core - 三项目共用基座包

## 概述

此包是三个项目的共用基础设施层，通过本地路径引用（非npm发布）实现代码共享：

- **公考复盘系统** (`civil-exam-system`)
- **根因分析系统** (`root-cause-analysis`)
- **个人复盘系统** (`personal_review_system`)

## 使用方式

### 1. 在项目 package.json 中添加本地依赖

```json
{
  "dependencies": {
    "@shared/core": "file:../shared-core"
  }
}
```

### 2. 在 vite.config.ts 中配置别名

```typescript
resolve: {
  alias: {
    '@shared/core': path.resolve(__dirname, '../shared-core/src'),
  }
}
```

### 3. 在 tsconfig.json 中配置路径

```json
{
  "compilerOptions": {
    "paths": {
      "@shared/core": ["../shared-core/src/index.ts"],
      "@shared/core/*": ["../shared-core/src/*"]
    }
  }
}
```

### 4. 在项目入口初始化数据库前缀

```typescript
import { configureDB } from '@shared/core';

// 各项目使用不同的数据库前缀，确保数据隔离
configureDB('civil-exam-app');    // 公考系统
configureDB('rca-app');           // 根因分析
configureDB('review-app');        // 个人复盘
```

### 5. 安装 peer 依赖

公共包声明了以下 peerDependencies，使用方项目需自行安装：

```bash
npm install react-hook-form clsx date-fns
```

> 已在项目中的无需重复安装。可选依赖（recharts / @xyflow/react / flexsearch）只在用到对应组件时安装，见下文「可选依赖」。

## 使用示例

### 渲染模板驱动表单（核心能力）

```tsx
import { FormRenderer } from '@shared/core';
import type { FormTemplate, FormRecord } from '@shared/core';

// template: 模板定义（sections/phases/fields）
// record:   已有记录（新建时传 null）
// onSave:   自动保存 / 手动保存草稿回调
// onComplete: 完成回调
<FormRenderer
  template={template}
  record={record}
  onSave={async (r) => { await saveRecord(r); }}
  onComplete={async (r) => { await completeRecord(r); }}
  slots={{ /* 业务插件扩展点（自定义面板/侧栏注入） */ }}
/>
```

### 条件显隐字段（支持嵌套路径 + 通配符）

```tsx
import { ConditionalField } from '@shared/core';

// basePath：repeatable 分区内需传前缀（如 'items.0.'）
// showWhen 支持单个值、数组，以及 '*'（被依赖字段值为任意非空值时显示）
<ConditionalField condition={field.condition} basePath={basePath}>
  <FieldRenderer field={field} />
</ConditionalField>
```

### 版本快照（撤销/回放）

```tsx
import { useSnapshots, VersionHistoryList } from '@shared/core';

const { snapshots, loading, createSnapshot, removeSnapshot } = useSnapshots(recordId);

<button onClick={() => createSnapshot(formData, '重大进展前')}>存档</button>
<VersionHistoryList
  snapshots={snapshots}
  loading={loading}
  onRestore={(s) => form.reset(s.data)}
  onDelete={removeSnapshot}
  onCreateSnapshot={() => createSnapshot(formData)}
/>
```

### 全文搜索（需安装 flexsearch）

```tsx
import { useSearch } from '@shared/core/hooks/useSearch';

const results = useSearch(records, query, (r) => `${r.title} ${r.data.description ?? ''}`);
```

### 回路检测（系统思考分析）

```ts
import { detectLoops } from '@shared/core';

// causalChain: { factorA, factorB, relationType: 'reinforcing'|'balancing'|'causal'|'none' }[]
const { loops, leveragePoints } = detectLoops(causalChain);
```

## 可选依赖

以下模块依赖**可选库**（peerDependenciesMeta 声明为 optional），使用方按需安装并**通过子路径导入**：

| 子路径 | 组件/能力 | 需安装 |
|---|---|---|
| `@shared/core/components/visualize/CausalGraph` | 因果链有向图（ReactFlow） | `@xyflow/react` |
| `@shared/core/components/stats/RootCauseTypePie` | 环形占比图 | `recharts` |
| `@shared/core/hooks/useSearch` | flexsearch 全文搜索 | `flexsearch` |

```bash
npm install @xyflow/react recharts flexsearch
```

```tsx
// 子路径导入示例
import { CausalGraph } from '@shared/core/components/visualize/CausalGraph';
import { RootCauseTypePie } from '@shared/core/components/stats/RootCauseTypePie';
import { useSearch } from '@shared/core/hooks/useSearch';
```

> 主入口 `@shared/core` **不导出**依赖可选库的模块，避免未安装对应库的项目 import 主入口时报模块解析错误。

## 包含模块

### 类型 (`types/`)
- `FormTemplate`, `FormField`, `FormSection`, `FormRecord`
- `Account`, `ExportedData`, `SyncStatus`, `SyncResult`
- `Snapshot`（版本快照）, `CausalChainItem`（回路检测）, `AiLoop`/`AiLeveragePoint`/`AiAnalysisResult`
- `QuadrantKey`/`QuadrantItem`/`QuadrantConfig`/`DragMatrixValue`/`DragMatrixQuadrantConfig`（象限/矩阵字段）

### 服务 (`services/`)
- `db.ts` — IndexedDB 多账户隔离数据层（可配置数据库前缀，含快照 CRUD：getSnapshotsByRecord/putSnapshot/deleteSnapshot）
- `auth.ts` — PBKDF2-SHA256 本地认证
- `cloudflareD1.ts` — Cloudflare D1 远程备份同步

### Hooks (`hooks/`)
- `useAuth.tsx` — 认证状态机 Provider + Hook
- `useToast.tsx` — 全局通知系统
- `useDB.ts` — 数据 CRUD Hooks
- `usePhaseLogic.ts` — 多阶段表单生命周期（含 useFormPhaseLogic 增强版）
- `useSnapshots.ts` — 版本快照（保存/查看/删除，每记录上限 20 条）
- `useSearch.ts` — flexsearch 全文搜索（依赖可选库，走子路径导入）

### 组件 (`components/`)
- 基础：`Layout`、`ToastContainer`、`ConfirmDialog`、`LoadingSpinner`、`ProtectedRoute`、`SearchBar`、`PasswordInput`、`TemplateCard`、`RecordList`、`VersionHistoryList`
- 表单引擎（RHF 增强版）：`form/FormRenderer`（自动保存/分阶段校验/锁定只读/业务 slots 扩展点）、`form/FieldRenderer`、`form/FieldInputs`（text/textarea/number/date/select/radio/checkbox/rating/table/quadrant/dragMatrix/computed/singleCheckbox + 自动补全）、`form/ConditionalField`（basePath 嵌套 + '*' 通配）、`form/FormTabs`（锁定/只读/错误角标）、`form/RepeatableSection`（折叠/撤销删除/stopAppendWhen）、`form/PhaseIndicator`（时间锁/冷静期）、`form/PhaseNotice`、`form/OptionalFieldsGroup`、`form/CollapsibleSection`、`form/FormNavButtons`
- 统计与可视化：`stats/StatCard`、`stats/KeywordList`、`stats/RootCauseTypePie`（recharts，可选依赖）、`visualize/MatrixHeatmap`、`visualize/FishboneDiagram`、`visualize/ComparisonDiffChart`、`visualize/CausalGraph`（@xyflow/react，可选依赖）、`visualize/TimelineChart`、`visualize/WhyLadderChart`、`visualize/LoopDiagram`

### 工具 (`utils/`)
- `formValidation.ts` — 字段校验、默认值解析、完成度计算、阶段时间锁
- `exportFormatter.ts` — 导出字段格式化（select/checkbox/date/table 等 → 文本/Markdown）
- `loopDetection.ts` — 因果链回路检测（DFS 找环 + 奇偶判型 + 杠杆点）
- `suggestions.ts` — 从历史记录提取字段建议值

> 注：`CausalGraph`（@xyflow/react）、`RootCauseTypePie`（recharts）、`useSearch`（flexsearch）依赖可选库，
> 使用方需自行安装对应依赖，并通过子路径导入（如 `@shared/core/components/visualize/CausalGraph`）。

## 迁移指南（从本地副本切换到公共包）

本包的表单组件为 **react-hook-form 增强版**（自动保存、分阶段校验、锁定/只读、条件字段、业务 slots 插件点）。
从项目本地副本切换时按以下步骤：

1. **安装依赖**：确保项目已安装 `react-hook-form`（表单引擎必需）+ 按需的可选库
2. **改 import**：把本地组件导入替换为 `@shared/core` 子路径导入
   ```ts
   // 之前（本地副本）
   import FormRenderer from '@/components/FormRenderer';
   import ConditionalField from '@/components/form/ConditionalField';
   // 之后（公共包）
   import { FormRenderer, ConditionalField } from '@shared/core';
   ```
3. **删除本地副本**：确认无引用后删除项目内的 `components/FormRenderer.tsx`、`components/form/FieldInputs.tsx` 等重复文件
4. **业务插件迁移**：若本地 FormRenderer 注入了投资/决策/周复盘等业务面板，通过 `slots` / `renderField` props 重新注入（业务逻辑留在业务项目，不进公共包）
5. **数据兼容**：业务库自动从版本 1 升级到版本 2（新增 snapshots 表），旧数据不受影响，无需手动迁移

## 设计原则

1. **数据隔离**：各项目通过 `configureDB(prefix)` 使用独立的 IndexedDB 数据库
2. **零耦合**：共用包不依赖任何项目的业务逻辑
3. **可配置**：Layout 等组件通过 props 接收项目特定配置
4. **向后兼容**：已有项目的数据不受影响（数据库名不变）
