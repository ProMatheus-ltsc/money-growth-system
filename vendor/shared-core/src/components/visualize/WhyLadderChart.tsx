/**
 * 5Why 追问阶梯图（WhyLadderChart）：把 whyChain 每层追问画成"问题 → 逐层 Why → 根因"的阶梯链路。
 * - 顶部为问题（problemTitle），每层 why 向下递减呈现（阶梯式纵深）
 * - 每层显示：第 N 层 Why、why 内容、证据类型徽章
 * - isRootCause === 'yes'（可用 rootCauseValue 自定义）的层高亮为根因终点（红色/金色）
 * - 提取自 root-cause-analysis 项目（公共图表组件）。业务语义已参数化：
 *   根因判定值可通过 rootCauseValue 自定义（默认 'yes'），证据类型中文标签可通过 evidenceLabels 覆盖。
 */
import { useMemo, type ReactNode } from 'react';

/** 一层 5Why 追问数据：why 为追问内容，evidenceType 证据类型，evidence 证据说明，isRootCause 是否根因（rootCauseValue 匹配时视为根因） */
interface WhyEntry {
  why?: string;
  evidenceType?: string;
  evidence?: string;
  isRootCause?: string;
}

/**
 * 5Why 阶梯图 props：
 * - problemTitle：最顶层要分析的问题
 * - entries：逐层追问的数据列表
 */
interface WhyLadderChartProps {
  problemTitle?: string;
  entries: WhyEntry[];
  /** 判定为根因的 isRootCause 取值（默认 'yes'），可自定义为任意字符串 */
  rootCauseValue?: string;
  /** 证据类型 → 中文标签（如 fact=客观事实、data=数据、opinion=主观观点、emotion=情绪感受），覆盖内置默认值 */
  evidenceLabels?: Record<string, string>;
}

// 统一字体族，保证 SVG 内文字渲染一致
const FONT = 'ui-sans-serif, system-ui, sans-serif';

// 证据类型 → 中文标签默认值（显示在每层盒子右上角的徽章里）
const EVIDENCE_LABELS: Record<string, string> = {
  fact: '客观事实',
  data: '数据',
  opinion: '主观观点',
  emotion: '情绪感受',
  primary: '一手数据',
  secondary: '二手数据',
  uncertain: '来源不确定',
};

// 证据类型 → 徽章配色（bg 背景 / fg 文字 / border 边框），与 EVIDENCE_LABELS 一一对应
const EVIDENCE_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  fact: { bg: '#d1fae5', fg: '#065f46', border: '#10b981' },
  data: { bg: '#dbeafe', fg: '#1e40af', border: '#3b82f6' },
  opinion: { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' },
  emotion: { bg: '#fce7f3', fg: '#9d174d', border: '#ec4899' },
};

/** 超长文本截断：超过 n 个字符保留前 n 个并补省略号 */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 5Why 阶梯图组件：把"问题 → 每层 Why → 根因"渲染成向右下逐层偏移的阶梯盒子，
 * 层与层之间用折线箭头连接表示"继续追问"的方向；根因层用红色高亮并画红色标注线。
 */
export function WhyLadderChart({ problemTitle, entries, rootCauseValue, evidenceLabels }: WhyLadderChartProps) {
  // 合并证据类型标签：默认值打底，props 传入的 evidenceLabels 覆盖同名类型
  const labels = { ...EVIDENCE_LABELS, ...evidenceLabels };
  // 根因判定值：isRootCause 等于该值（默认 'yes'）的层视为根因
  const rootCauseVal = rootCauseValue ?? 'yes';

  // 过滤出有效的 why 层（why 非空才算一层）；rootIdx 是根因层的下标（isRootCause 命中 rootCauseVal 的那层，找不到为 -1）
  const chain = useMemo(() => entries.filter((e) => e && typeof e.why === 'string' && e.why.trim()), [entries]);

  // 没有任何有效 why 层时不渲染
  if (chain.length === 0) return null;

  // ---- 布局参数（初学者注意这些常量如何决定阶梯形状）----
  // levels = 问题 + 各层 Why 的总行数；stepX 是每层向右的偏移量（形成阶梯）；
  // boxW/boxH 是盒子尺寸；gapY 是相邻两层的垂直间距；startY 是第一行（问题）的起始 Y。
  const rootIdx = chain.findIndex((e) => e.isRootCause === rootCauseVal);
  const levels = chain.length + 1; // 问题 + N 层 why
  const stepX = 42; // 每层向右偏移（阶梯感）
  const boxW = 520;
  const boxH = 64;
  const gapY = 92;
  const width = 640;
  const startY = 64;
  // 总高度 = 起始 Y + (行数-1)×行间距 + 一个盒子高 + 底部留白 12px
  const height = startY + (levels - 1) * gapY + boxH + 12;

  // 组装展示行：第 0 行固定为"问题"，后续每行对应一个 why 层。
  // isRoot 标记根因层（用于红色高亮）；evidenceType/evidence 留给徽章与底部说明使用。
  const rows = [
    {
      label: '问题',
      text: problemTitle || '待分析的问题',
      isRoot: false,
      evidenceType: undefined,
      evidence: undefined,
    },
    ...chain.map((e, i) => ({
      label: `第 ${i + 1} 层 Why`,
      text: e.why ?? '',
      isRoot: i === rootIdx,
      evidenceType: e.evidenceType,
      evidence: e.evidence,
    })),
  ];

  const parts: ReactNode[] = [];

  rows.forEach((row, i) => {
    // 行定位（阶梯的核心公式）：
    //   x = 40 + Math.min(i*stepX, width-boxW-40) —— 每层向右移 stepX，但用 Math.min 封顶，
    //       最多右移到"盒子右端不超出画布"为止，防止最后几层被截断；
    //   y = startY + i*gapY —— 每层向下移 gapY，形成向右下延伸的阶梯。
    const x = 40 + Math.min(i * stepX, (width - boxW - 40));
    const y = startY + i * gapY;
    const isRoot = row.isRoot;

    // 阶梯连接线（上一行 → 本行的折线箭头），坐标讲解：
    // 起点是上一行盒子右端中点 (prevX+boxW, prevY+boxH/2)，
    // 先水平走到本行左侧 (x+14)，再垂直下降到本行中点高度，最后水平 14px 指向本行盒子左端 (x, y+boxH/2)。
    // 三段式折线让"追问"方向更明确；根因行用红色实线，普通行用灰色虚线。
    if (i > 0) {
      const prevX = 40 + Math.min((i - 1) * stepX, width - boxW - 40);
      const prevY = startY + (i - 1) * gapY;
      parts.push(
        <path
          key={`conn-${i}`}
          d={`M ${prevX + boxW} ${prevY + boxH / 2} L ${x + 14} ${prevY + boxH / 2} L ${x + 14} ${y + boxH / 2} L ${x} ${y + boxH / 2}`}
          fill="none"
          stroke={isRoot ? '#e11d48' : '#94a3b8'}
          strokeWidth={2}
          strokeDasharray={isRoot ? 'none' : '4 3'}
          markerEnd="url(#arrowWhy)"
        />
      );
    }

    // 盒子配色：根因层 = 红底红边；问题层（i===0）= 蓝底蓝边；中间层 = 浅灰。
    // 视觉优先级：根因 > 问题 > 中间层，读者一眼看到重点。
    const boxColor = isRoot
      ? { bg: '#fef2f2', border: '#e11d48', title: '#991b1b' }
      : i === 0
        ? { bg: '#eef2ff', border: '#6366f1', title: '#3730a3' }
        : { bg: '#f8fafc', border: '#cbd5e1', title: '#334155' };

    parts.push(
      <g key={`box-${i}`}>
        <rect x={x} y={y} width={boxW} height={boxH} rx={10} fill={boxColor.bg} stroke={boxColor.border} strokeWidth={isRoot ? 2.5 : 1.5} />
        <text x={x + 14} y={y + 18} fontSize={11} fontWeight={500} fill={boxColor.title} fontFamily={FONT}>
          {row.label}
          {isRoot && '  ← 根因'}
        </text>
        <text x={x + 14} y={y + 40} fontSize={13} fill="#1e293b" fontFamily={FONT}>
          {truncate(row.text, 58)}
        </text>
        {row.evidenceType && labels[row.evidenceType] && (
          // 证据类型徽章：固定在盒子右上角的圆角小胶囊（X 取 x+boxW-108，即盒子右缘往左 108px 处），
          // 配色从 EVIDENCE_COLORS 取，没有对应类型时回退为默认灰。
          <g>
            <rect x={x + boxW - 108} y={y + 8} width={96} height={20} rx={10} fill={EVIDENCE_COLORS[row.evidenceType]?.bg ?? '#f1f5f9'} stroke={EVIDENCE_COLORS[row.evidenceType]?.border ?? '#94a3b8'} strokeWidth={1} />
            <text x={x + boxW - 60} y={y + 18} fontSize={10.5} fontWeight={500} fill={EVIDENCE_COLORS[row.evidenceType]?.fg ?? '#334155'} textAnchor="middle" dominantBaseline="central" fontFamily={FONT}>
              {labels[row.evidenceType]}
            </text>
          </g>
        )}
      </g>,
    );
  });

  // ---- 根因标注线：在根因层盒子正下方画一条红色横线，右端带一个小三角形箭头 ----
  // 位置推导：Y 取根因层盒子底部往下 4px（startY + rootIdx*gapY + boxH + 4）；
  // 线从盒子左端（rootLineX2）画到右端（rootLineX），箭头朝右，起到"圈住根因"的强调作用。
  const rootLineY = startY + rootIdx * gapY + boxH + 4;
  const rootLineX = 40 + Math.min(rootIdx * stepX, width - boxW - 40) + boxW - 12;
  const rootLineX2 = 40 + Math.min(rootIdx * stepX, width - boxW - 40) + 12;
  if (rootIdx >= 0) {
    parts.push(
      <g key="root-flag">
        <path d={`M ${rootLineX2} ${rootLineY} L ${rootLineX} ${rootLineY}`} fill="none" stroke="#e11d48" strokeWidth={2} />
        <path d={`M ${rootLineX} ${rootLineY} L ${rootLineX - 10} ${rootLineY - 4} L ${rootLineX - 10} ${rootLineY + 4} Z`} fill="#e11d48" />
      </g>,
    );
  }

  // 底部说明文字：有根因时提示"共追问 N 层、第 M 层确认为根因"并附上证据（截断 40 字），
  // 没有根因则提示"尚未标记根因"。颜色跟随是否有根因（红 / 灰）。
  const noteY = height + 18;
  const note =
    rootIdx >= 0
      ? `共追问 ${chain.length} 层，第 ${rootIdx + 1} 层确认为根因${chain[rootIdx].evidence ? '：' + truncate(chain[rootIdx].evidence, 40) : ''}`
      : `共追问 ${chain.length} 层，尚未标记根因`;

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <svg viewBox={`0 0 ${width} ${noteY + 20}`} width="100%" role="img" aria-label="5Why 追问阶梯图">
        <title>5Why 追问阶梯图</title>
        <desc>从问题逐层追问 Why 到根因的阶梯链路</desc>
        <defs>
          <marker id="arrowWhy" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        {parts}
        <text x={40} y={noteY} fontSize={11.5} fill={rootIdx >= 0 ? '#b91c1c' : '#64748b'} fontFamily={FONT}>
          {note}
        </text>
      </svg>
    </div>
  );
}
