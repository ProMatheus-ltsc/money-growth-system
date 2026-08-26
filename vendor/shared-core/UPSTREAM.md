# UPSTREAM — vendor 来源登记

| 项 | 值 |
|----|-----|
| 上游仓库 | https://github.com/ProMatheus-ltsc/shared-core.git |
| pin commit | `ba59707`（2026-08-26，含 finance 六组件 + financeChartShared） |
| vendor 日期 | 2026-08-26 |
| 上游上一 pin | `911aff9`（2026-08-18） |

## 版本差异（911aff9 → ba59707）

上游新增（本项目贡献并回流，见 04 §3.10）：

- `src/components/visualize/finance/FinanceStackedArea.tsx` — 堆叠面积（预期虚线/实际实线）
- `src/components/visualize/finance/FinanceTreemap.tsx` — 树图
- `src/components/visualize/finance/FinanceSankey.tsx` — 桑基（节点金额标注、linkColorMode）
- `src/components/visualize/finance/FinanceWaterfall.tsx` — 瀑布（增绿减红）
- `src/components/visualize/finance/FinanceCompareBar.tsx` — 对比柱（目标灰/实际模块色）
- `src/components/visualize/finance/FinanceDonut.tsx` — 环形（环心总额）
- `src/components/visualize/finance/financeChartShared.ts` — 共享基座（useFinanceChart 生命周期封装 + 格式化工具）

> 上游 exports 未含 finance 子路径与 echarts optional peer 声明——本 vendor 副本已补齐
> （见 PATCHES.md #3），不影响消费方经 `@shared/core/components/visualize/finance/*` 子路径导入。

## 升级方式

仅按需评估后一次性同步：`git -C <upstream> pull` 后重新复制（剥离 .git），核对 PATCHES 兼容性。
不跟踪上游 HEAD，保证构建可复现。
