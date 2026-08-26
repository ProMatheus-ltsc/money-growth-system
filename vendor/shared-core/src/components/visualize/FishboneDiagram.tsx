/**
 * 鱼骨图（FishboneDiagram）：也叫石川图 / 因果图，把问题放在"鱼头"，
 * 各类原因按分类挂在"鱼骨"（主脊线）上，用于梳理问题的潜在原因。
 * - 输入数据形态：problemTitle（问题描述）+ categories（分类数组，
 *   每项含分类名 name 与具体原因列表 causes）
 * - 视觉呈现逻辑：横向主线为鱼脊（右侧鱼头带箭头），分类竖线（大鱼刺）从脊线上分出，
 *   奇数/偶数分类上下交替布置避免文字拥挤；每个分类下的原因再以小鱼刺挂在分类线两侧，
 *   每个分类最多展示前 4 条原因。
 * - 实现方式：先用 useMemo 拼出 SVG 字符串（lines 存线段/多边形，texts 存文字），
 *   再通过 dangerouslySetInnerHTML 注入，因此本文件中的坐标都是模板字符串拼接。
 * - 提取自 root-cause-analysis 项目（公共图表组件，纯 SVG 展示，直接复用）。
 */
import { useMemo } from 'react';

/** 一个原因分类：name 是分类名（如"人 / 机 / 料 / 法 / 环 / 测"），causes 是该分类下的具体原因列表 */
interface FishboneCategory {
  name: string;
  causes: string[];
}

/** 鱼骨图 props：problemTitle 为待分析的问题（画在鱼头），categories 为各分类及其原因 */
interface FishboneDiagramProps {
  problemTitle: string;
  categories: FishboneCategory[];
}

/**
 * 鱼骨图组件：核心逻辑在 useMemo 中把"分类 / 原因"换算成 SVG 元素的坐标字符串。
 * 依赖 [problemTitle, categories]，数据变化时自动重算。
 */
export function FishboneDiagram({ problemTitle, categories }: FishboneDiagramProps) {
  const svgContent = useMemo(() => {
    // ---- 画布与坐标系（初学者注意这些坐标怎么来的）----
    // 脊线（脊柱）画在画布正中：spineY = 高度一半；
    // 鱼头在右侧 headX，鱼尾在左侧 tailX，脊线从 tailX 画到 headX。
    // spacing 是相邻两根大鱼刺（分类竖线）之间的水平间距，
    // 用"脊线可用长度（headX - tailX 再扣去两端 20px 余量）÷ 分类数"均分。
    const width = 900;
    const height = 400;
    const spineY = height / 2;
    const headX = width - 80;
    const tailX = 60;
    const categoryCount = categories.length;

    if (categoryCount === 0) return null;

    const spacing = (headX - tailX - 40) / Math.max(categoryCount, 1);

    // 收集渲染元素的容器：lines 存线段 / 多边形的 SVG 字符串，texts 存文字（坐标 + 样式 + 内容）。
    // 分开收集最后统一使用，方便渲染时分别生成 <g>（原始字符串）与 <text>（JSX 元素）。
    const lines: string[] = [];
    const texts: Array<{ x: number; y: number; text: string; size: number; weight: string; anchor: string }> = [];

    // 主脊骨：一条从鱼尾到鱼头的横线（stroke-width 3 加粗），末端是一个朝右的小三角形（鱼头箭头）。
    // 三角形坐标：顶点在 (headX, spineY)，上下各张开 12px、向右伸出 20px，形成箭头指向问题。
    lines.push(`<line x1="${tailX}" y1="${spineY}" x2="${headX}" y2="${spineY}" stroke="#6366f1" stroke-width="3" />`);
    lines.push(`<polygon points="${headX},${spineY - 12} ${headX + 20},${spineY} ${headX},${spineY + 12}" fill="#6366f1" />`);

    // 问题标题放在鱼头右侧（headX + 30），超过 12 字截断，避免太长超出画布
    texts.push({ x: headX + 30, y: spineY + 5, text: problemTitle.length > 12 ? problemTitle.slice(0, 12) + '…' : problemTitle, size: 13, weight: '600', anchor: 'start' });

    // ---- 每个分类 = 一根大鱼刺 ----
    // baseX：大鱼刺在脊线上的落点（从鱼尾右侧 40px 起，按 spacing 等距分布）。
    // isTop 用 idx % 2 奇偶交替：偶数分类朝上、奇数分类朝下，让上下两侧均衡分布，
    // 避免所有分类挤在同一侧导致文字互相遮挡。
    // branchEndY 是大鱼刺末端：朝上 = spineY - 100，朝下 = spineY + 100（各从脊线伸出 100px）。
    categories.forEach((cat, idx) => {
      const baseX = tailX + 40 + idx * spacing;
      const isTop = idx % 2 === 0;
      const branchEndY = isTop ? spineY - 100 : spineY + 100;

      // 大鱼刺竖线：从脊线（spineY）画到分类末端（branchEndY）
      lines.push(`<line x1="${baseX}" y1="${spineY}" x2="${baseX}" y2="${branchEndY}" stroke="#94a3b8" stroke-width="2" />`);

      // 分类名：放在大鱼刺末端外侧（朝上的分类文字在线段上方 12px，朝下的在线段下方 18px），
      // 并水平居中对齐，保证分类名紧贴对应鱼刺。
      texts.push({
        x: baseX,
        y: isTop ? branchEndY - 12 : branchEndY + 18,
        text: cat.name,
        size: 12,
        weight: '600',
        anchor: 'middle',
      });

      // ---- 分类下的原因 = 小鱼刺 ----
      // 最多展示前 4 条原因（slice(0,4)），避免鱼刺过长超出画布高度。
      // causeY：小鱼刺的纵向位置，从分类末端往"朝脊线方向"逐行下移 18px 依次排列
      //   （朝上的分类从 branchEndY+20 往下排，朝下的从 branchEndY-20 往上排）；
      // causeX：在分类竖线左右各偏移 10px（ci % 2 交替），让文字微微错开不那么死板。
      cat.causes.slice(0, 4).forEach((cause, ci) => {
        const causeY = isTop
          ? branchEndY + 20 + ci * 18
          : branchEndY - 20 - ci * 18;
        const causeX = baseX + (ci % 2 === 0 ? -10 : 10);

        // 小鱼刺线段：从分类末端附近连到原因文字位置（朝上时从上方 8px 连下，朝下则从下方 8px 连上）
        lines.push(`<line x1="${baseX}" y1="${causeY + (isTop ? -8 : 8)}" x2="${baseX}" y2="${causeY}" stroke="#cbd5e1" stroke-width="1" />`);
        // 原因文字：居中对齐，超过 8 字截断，字号比分类名小一级以示层级
        texts.push({
          x: causeX,
          y: causeY + 4,
          text: cause.length > 8 ? cause.slice(0, 8) + '…' : cause,
          size: 10,
          weight: '400',
          anchor: 'middle',
        });
      });
    });

    // 返回画布尺寸 + 拼好的元素集合，供 JSX 渲染使用
    return { width, height, lines, texts };
  }, [problemTitle, categories]);

  // 无分类数据（或计算出空内容）时显示占位提示，避免渲染空画布
  if (!svgContent || categories.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-8 text-center text-sm text-gray-400">
        完成鱼骨图分析后，此处将显示可视化鱼骨图
      </div>
    );
  }

  // 渲染：svg 的 viewBox 用计算出的画布尺寸，width 100% + 高度自适应实现响应式缩放；
  // lines 用 dangerouslySetInnerHTML 注入原始 SVG 字符串（注意：注入内容来自本组件内部拼接，无用户脚本风险）；
  // texts 走正常的 JSX <text>，坐标、字号、字重、锚点都来自 texts 数组。
  return (
    <div className="rounded-xl border border-gray-200 overflow-x-auto bg-white p-2" role="img" aria-label="鱼骨图（因果分析图）">
      <svg
        viewBox={`0 0 ${svgContent.width} ${svgContent.height}`}
        className="w-full h-auto min-h-[300px]"
        xmlns="http://www.w3.org/2000/svg"
      >
        {svgContent.lines.map((line, idx) => (
          <g key={idx} dangerouslySetInnerHTML={{ __html: line }} />
        ))}
        {svgContent.texts.map((t, idx) => (
          <text
            key={idx}
            x={t.x}
            y={t.y}
            fontSize={t.size}
            fontWeight={t.weight}
            textAnchor={t.anchor as 'start' | 'middle' | 'end'}
            fill="#334155"
          >
            {t.text}
          </text>
        ))}
      </svg>
    </div>
  );
}
