/**
 * 因果矩阵热力图（MatrixHeatmap）：把"因素 × 因素"的因果强度矩阵画成颜色深浅的热力表格。
 * - 输入数据形态：factorNames（因素名列表）+ matrix（n×n 数字矩阵，
 *   matrix[i][j] = 因素 i 对因素 j 的影响强度，0 表示无影响）
 * - 视觉呈现逻辑：值越大格子颜色越深（getHeatColor 按"值/全矩阵最大值"归一化后分 4 档），
 *   对角线（i===j，自己对自己）用"—"占位不参与显示；
 *   行首 / 列表头因素名用 sticky 定位，横向滚动时保持可见，方便对照行列。
 * - 底部附"弱 → 强"渐变色图例，帮助读者把颜色深浅对应到强度大小。
 * - 提取自 root-cause-analysis 项目（公共图表组件，纯表格热力图，直接复用）。
 */
import { useMemo } from 'react';
import clsx from 'clsx';

/** 热力图 props：factorNames 为因素名数组（同时充当行、列表头），matrix 为对应的 n×n 强度矩阵 */
interface MatrixHeatMapProps {
  factorNames: string[];
  matrix: number[][];
}

/**
 * 把矩阵值映射为 Tailwind 背景/文字颜色类（值越大颜色越深）。初学者注意这里的归一化思路：
 * 1. ratio = value / max：把原始值缩放到 0~1（除以最大值，Math.max(max,1) 防止 max 为 0 时除零）；
 * 2. 按 ratio 落在哪个区间选颜色档位，共 4 档由浅到深：
 *    0        → 返回空串（不填色，配合外层显示灰色占位点"·"）
 *    < 0.25   → brand-50（最浅）
 *    < 0.5    → brand-100
 *    < 0.75   → brand-200
 *    ≥ 0.75   → brand-300（最深）+ 加粗，表示强因果
 * 这样强度的差异一眼就能通过颜色深浅读出来。
 */
function getHeatColor(value: number, max: number): string {
  if (value === 0) return '';
  const ratio = Math.min(value / Math.max(max, 1), 1);
  if (ratio < 0.25) return 'bg-blue-50 text-blue-600';
  if (ratio < 0.5) return 'bg-blue-100 text-blue-700';
  if (ratio < 0.75) return 'bg-blue-200 text-blue-800';
  return 'bg-blue-300 text-blue-900 font-semibold';
}

/**
 * 热力图组件：渲染一个 n×n 的 HTML 表格（非 SVG），用 Tailwind 类控制颜色。
 * maxVal 提前算好作为颜色归一化的基准。
 */
export function MatrixHeatmap({ factorNames, matrix }: MatrixHeatMapProps) {
  // 找出矩阵中的最大值，作为 getHeatColor 的 max 参数（颜色归一化基准）。
  // 值全部为 0 时 max 保持 0，getHeatColor 里会通过 Math.max(max,1) 兜底避免除零。
  const maxVal = useMemo(() => {
    let m = 0;
    for (const row of matrix) {
      for (const v of row) {
        if (v > m) m = v;
      }
    }
    return m;
  }, [matrix]);

  const n = factorNames.length;

  // 没有任何因素时展示占位提示，避免渲染空表格
  if (n === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-8 text-center text-sm text-gray-400">
        添加因素并填写矩阵后，此处将显示热力图
      </div>
    );
  }

  return (
    // 外层 overflow-x-auto：矩阵宽时允许横向滚动；role/aria-label 方便无障碍阅读。
    // 表头单元格 sticky left-0 + z-10：横向滚动时列表头固定在左侧不跟着滚走。
    <div className="overflow-x-auto rounded-xl border border-gray-200 p-4" role="img" aria-label="因果矩阵热力图">
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white px-2 py-2 text-left font-medium text-gray-400 text-[10px] align-bottom">
              行↓ \ 列→
            </th>
            {factorNames.map((fname, j) => (
              <th
                key={j}
                title={fname}
                className="min-w-[160px] max-w-[200px] px-2 py-2 text-center font-medium text-gray-600 align-bottom"
              >
                <div className="break-words leading-tight whitespace-pre-wrap">{fname}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {factorNames.map((rowName, i) => (
            <tr key={i}>
              <td
                title={rowName}
                className="sticky left-0 z-10 bg-white px-2 py-2 text-left font-medium text-gray-600 align-middle min-w-[140px] max-w-[200px]"
              >
                <div className="break-words leading-tight whitespace-pre-wrap">{rowName}</div>
              </td>
              {factorNames.map((_, j) => {
                // 对角线（i === j）：自己对自己的因果没有意义，画"—"占位、灰底显示；
                // 非对角线取 matrix[i][j]，交给 getHeatColor 上色；值为 0 时显示灰色占位点"·"。
                if (i === j) {
                  return (
                    <td key={j} className="border border-gray-100 bg-gray-50 px-1 py-2 text-center text-gray-300 text-[10px] align-middle">
                      —
                    </td>
                  );
                }
                const val = matrix[i]?.[j] ?? 0;
                return (
                  <td
                    key={j}
                    className={clsx(
                      'min-w-[48px] border border-gray-100 px-1 py-2 text-center text-[12px] transition-colors align-middle tabular-nums',
                      getHeatColor(val, maxVal),
                      !val && 'text-gray-400',
                    )}
                    title={`${rowName} → ${factorNames[j]}: ${val}`}
                  >
                    {val || '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* 图例：左侧"弱"右侧"强"，中间 4 个色块与 getHeatColor 的 4 档颜色一一对应 */}
      <div className="mt-3 flex items-center gap-2 text-[10px] text-gray-400">
        <span>弱</span>
        <div className="flex gap-0.5">
          <span className="inline-block h-3 w-6 rounded-sm bg-blue-50" />
          <span className="inline-block h-3 w-6 rounded-sm bg-blue-100" />
          <span className="inline-block h-3 w-6 rounded-sm bg-blue-200" />
          <span className="inline-block h-3 w-6 rounded-sm bg-blue-300" />
        </div>
        <span>强</span>
      </div>
    </div>
  );
}
