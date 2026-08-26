/**
 * 对比差异图（ComparisonDiffChart）：把 comparisonTable 的「正常 vs 异常 vs 关键差异」
 * 画成每维度一条对照横条的差异图。
 * - 每维度一行：左为正常表现（绿），右为异常表现（红），中间为关键差异标记
 * - 正常/异常文本按长度折算成横条宽度，视觉上直接看出哪一维度差异最大
 * - 顶部为正常情况 / 异常情况摘要（normalCase / abnormalCase）
 * - 提取自 root-cause-analysis 项目（公共图表组件，零依赖纯展示，直接复用）。
 */
import { useMemo } from 'react';

/**
 * 一行对比数据：
 * - dimension：维度名称（如"网络延迟""CPU 使用率"），显示在每行最左侧
 * - normal：正常情况下的表现描述
 * - abnormal：异常情况下的表现描述
 * - diff：关键差异说明（显示在中部的橙色箭头旁）
 */
interface ComparisonRow {
  dimension?: string;
  normal?: string;
  abnormal?: string;
  diff?: string;
}

/**
 * 对比差异图 props：
 * - normalCase / abnormalCase：整件事的"正常情况 / 异常情况"摘要，显示在图顶部（可省略）
 * - rows：各维度的对照数据列表
 */
interface ComparisonDiffChartProps {
  normalCase?: string;
  abnormalCase?: string;
  rows: ComparisonRow[];
}

// 统一字体族，避免不同浏览器默认字体不一致导致文字宽度和位置漂移
const FONT = 'ui-sans-serif, system-ui, sans-serif';

/** 超长文本截断：超过 n 个字符时保留前 n 个并补省略号，防止文字溢出卡片/画布 */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 对比差异图组件：按维度逐行绘制"正常条 + 异常条 + 差异箭头"。
 * 条宽与文字长度成正比（见 barLen），一眼即可比较出哪一维度差异最大。
 */
export function ComparisonDiffChart({ normalCase, abnormalCase, rows }: ComparisonDiffChartProps) {
  // 先过滤出有效行：至少 normal 或 abnormal 有一项非空，空行直接丢弃
  const validRows = useMemo(() => rows.filter((r) => r && (r.normal?.trim() || r.abnormal?.trim())), [rows]);

  if (validRows.length === 0) return null;

  // ---- 纵向布局坐标系（初学者注意这些常量的作用）----
  // rowH：每个维度行的高度（96px，容纳上下两条横条 + 两条之间的间隔）
  // headerH：顶部摘要区高度（有摘要才占位，否则为 0）
  // legendH：图例高度；labelW：左侧维度名栏宽；barW：横条的最大宽度
  // 总高度 = 摘要 + 图例 + 行数×行高 + 底部留白 20px
  const rowH = 96;
  const headerH = normalCase || abnormalCase ? 96 : 0;
  const legendH = 26;
  const labelW = 130;
  const barW = 150;
  const height = headerH + legendH + validRows.length * rowH + 20;

  // 文本长度 → 条宽（8 字以下按比例，超过封顶）
  const barLen = (s: string) => Math.max(24, Math.min(barW - 12, s.replace(/\s/g, '').length * 8 + 20));

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <svg viewBox={`0 0 640 ${height}`} width="100%" role="img" aria-label="对比分析差异图">
        <title>对比分析差异图</title>
        <desc>正常情况与异常情况在各维度的对照差异</desc>
        <defs>
          {/* 箭头 marker：被 <line> 的 markerEnd 属性引用，画在线的末端表示"指向"；
              context-stroke 让箭头颜色自动继承线条的 stroke 颜色 */}
          <marker id="arrowDiff" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>

        {headerH > 0 && (
          // 顶部摘要区：先显示"正常情况"摘要，分隔线后显示"异常情况"摘要，
          // 让读者先看到正常基线，再看到异常表现，形成前后对照。
          <g>
            <text x={40} y={26} fontSize={12} fontWeight={500} fill="#065f46" fontFamily={FONT}>
              正常情况
            </text>
            <text x={40} y={46} fontSize={12} fill="#475569" fontFamily={FONT}>
              {truncate(normalCase ?? '', 90)}
            </text>
            <line x1={40} y1={54} x2={600} y2={54} stroke="#e2e8f0" strokeWidth={1} />
            <text x={40} y={72} fontSize={12} fontWeight={500} fill="#991b1b" fontFamily={FONT}>
              异常情况
            </text>
            <text x={40} y={92} fontSize={12} fill="#475569" fontFamily={FONT}>
              {truncate(abnormalCase ?? '', 90)}
            </text>
          </g>
        )}

        {/* 图例 */}
        <g fontFamily={FONT}>
          <rect x={40} y={headerH + 8} width={14} height={10} rx={3} fill="#10b981" />
          <text x={60} y={headerH + 18} fontSize={11} fill="#475569">正常</text>
          <rect x={120} y={headerH + 8} width={14} height={10} rx={3} fill="#ef4444" />
          <text x={140} y={headerH + 18} fontSize={11} fill="#475569">异常</text>
          <rect x={200} y={headerH + 8} width={14} height={10} rx={3} fill="#f59e0b" />
          <text x={220} y={headerH + 18} fontSize={11} fill="#475569">关键差异</text>
        </g>

        {validRows.map((row, idx) => {
          // 每行基准 Y：headerH（摘要高度）+ legendH（图例高度）+ 行号×行高 + 12px 顶部留白。
          // 之后本行的正常条、异常条、差异箭头都以这个 y 为起点往下排（见下面的 y+12 / y+46 / y+24 等）。
          const y = headerH + legendH + idx * rowH + 12;
          const normalText = row.normal ?? '';
          const abnormalText = row.abnormal ?? '';
          const diffText = row.diff ?? '';

          return (
            <g key={idx} fontFamily={FONT}>
              {/* 维度名 */}
              <text x={40} y={y + rowH / 2 - 4} fontSize={12.5} fontWeight={500} fill="#0f172a">
                {truncate(row.dimension || `维度 ${idx + 1}`, 10)}
              </text>
              <text x={40} y={y + rowH / 2 + 14} fontSize={10.5} fill="#94a3b8">
                {idx + 1}
              </text>

              {/* 正常条 */}
              <rect x={labelW} y={y + 12} width={barLen(normalText)} height={20} rx={5} fill="#d1fae5" stroke="#10b981" strokeWidth={1} />
              <text x={labelW + 8} y={y + 22} fontSize={11} fill="#065f46" dominantBaseline="central">
                {truncate(normalText, 14)}
              </text>

              {/* 异常条 */}
              <rect x={labelW} y={y + 46} width={barLen(abnormalText)} height={20} rx={5} fill="#fee2e2" stroke="#ef4444" strokeWidth={1} />
              <text x={labelW + 8} y={y + 56} fontSize={11} fill="#991b1b" dominantBaseline="central">
                {truncate(abnormalText, 14)}
              </text>

              {/* 差异箭头 + 文本：一条从"正常条下方"指向"异常条右侧"的橙色斜线，
                  视觉上连接前后状态、标出差异所在。坐标讲解：
                  起点 (labelW+barW+14, y+24) 在正常条尾端下方，终点 (labelW+barW+34, y+38)
                  向右下方偏移 20px，形成 45° 斜向箭头；文本再往右 8px 起排，避免压线。 */}
              {diffText && (
                <g>
                  <line x1={labelW + barW + 14} y1={y + 24} x2={labelW + barW + 34} y2={y + 38} stroke="#f59e0b" strokeWidth={2} markerEnd="url(#arrowDiff)" />
                  <text x={labelW + barW + 42} y={y + 36} fontSize={11.5} fill="#92400e" fontWeight={500}>
                    {truncate(diffText, 24)}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
