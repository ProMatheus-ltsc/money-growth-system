/**
 * 四象限 / 拖拽决策矩阵常量配置
 * 增强自 personal_review_system（constants/quadrant.ts，剥离业务引用）
 *
 * - DEFAULT_QUADRANTS：自我管理矩阵（参考《高效能人士的七个习惯》时间管理矩阵）
 * - DEFAULT_DRAG_QUADRANTS：拖拽决策矩阵（成本 × 效果评估）
 * - isQuadrantMatrix / isDragMatrixValue：结构判定（用于容错旧数据）
 */
import type { QuadrantKey, QuadrantMatrix, QuadrantConfig, DragMatrixValue, DragMatrixQuadrantConfig } from '../../types';

export const QUADRANT_KEYS: QuadrantKey[] = ['q1', 'q2', 'q3', 'q4'];

/** 判断值是否为四象限矩阵结构（用于校验与导出兜底） */
export function isQuadrantMatrix(val: unknown): val is QuadrantMatrix {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return QUADRANT_KEYS.every((k) => Array.isArray(obj[k]));
}

/** 判断值是否为拖拽决策矩阵结构（q1-q4 均为字符串数组） */
export function isDragMatrixValue(val: unknown): val is DragMatrixValue {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return QUADRANT_KEYS.every((k) => Array.isArray(obj[k]));
}

/**
 * 默认四象限配置（自我管理矩阵 · 时间管理矩阵）
 * - Q1 紧急且重要：立即做，但要持续减少
 * - Q2 不紧急但重要：主动预留时间，是效能提升的关键象限
 * - Q3 紧急但不重要：授权 / 简化 / 说不
 * - Q4 不紧急也不重要：尽量减少或避免
 */
export const DEFAULT_QUADRANTS: QuadrantConfig[] = [
  {
    key: 'q1',
    label: '紧急且重要',
    action: '立即做',
    typical: '危机、紧急问题、临期任务、截止日期迫近的工作',
    advice: '立即处理、专注完成，避免拖延。同时反思：其中有多少本可以提前预防？第二象限投入越多，这里的"火情"越少。',
    placeholder: '记录一件紧急且重要的事',
    ratio: '不宜长期占主导',
    dotClass: 'bg-rose-500',
    borderClass: 'border-rose-200',
    adviceClass: 'bg-rose-50 text-rose-700',
  },
  {
    key: 'q2',
    label: '不紧急但重要',
    action: '主动投入',
    typical: '规划与预防、目标拆解、关系经营、学习成长、锻炼健康、深度思考',
    advice: '为它主动预留固定时间（每天 30-60 分钟 / 每周固定时段）。它不紧迫，却决定长期结果 —— 是提升效能的杠杆象限。',
    placeholder: '记录一件不紧急但重要的事',
    ratio: '40-50%（核心）',
    dotClass: 'bg-emerald-500',
    borderClass: 'border-emerald-300',
    adviceClass: 'bg-emerald-50 text-emerald-700',
    ringClass: 'ring-emerald-200',
  },
  {
    key: 'q3',
    label: '紧急但不重要',
    action: '授权 / 简化 / 说不',
    typical: '不必要的中断、临时会议、他人强加的"紧急"、过度查看消息',
    advice: '授权、简化、礼貌地说"不"。很多"看起来紧急"的事，只是别人的优先级，别让它们挤占你的要事时间。',
    placeholder: '记录一件紧急但不重要的事',
    ratio: '<15%',
    dotClass: 'bg-amber-500',
    borderClass: 'border-amber-200',
    adviceClass: 'bg-amber-50 text-amber-700',
  },
  {
    key: 'q4',
    label: '不紧急也不重要',
    action: '尽量减少 / 避免',
    typical: '无目的刷手机、闲聊消磨、无意义娱乐、拖延式"休息"',
    advice: '尽量减少或避免。适度休息是必要的，但要有意识地控制时间，别让它悄悄占据一天的大半。',
    placeholder: '记录一件浪费时间的活动',
    ratio: '<5%',
    dotClass: 'bg-slate-400',
    borderClass: 'border-slate-200',
    adviceClass: 'bg-slate-50 text-slate-500',
  },
];

/**
 * 拖拽决策矩阵默认配置（成本 × 效果评估）
 * - 事半功倍：成本低 · 效果好 —— 优先考虑
 * - 物有所值：成本高 · 效果好 —— 值得投入（评估资源承受力）
 * - 无关痛痒：成本低 · 效果差 —— 可做可不做，谨慎
 * - 劳民伤财：成本高 · 效果差 —— 果断排除
 */
export const DEFAULT_DRAG_QUADRANTS: DragMatrixQuadrantConfig[] = [
  {
    key: 'q1',
    label: '事半功倍',
    desc: '成本低 · 效果好',
    advice: '投入产出比最高的选择，优先考虑。',
    dotClass: 'bg-emerald-500',
    borderClass: 'border-emerald-300',
    adviceClass: 'bg-emerald-50 text-emerald-700',
  },
  {
    key: 'q2',
    label: '物有所值',
    desc: '成本高 · 效果好',
    advice: '值得投入，但需评估资源是否承受得起，必要时分步执行。',
    dotClass: 'bg-blue-500',
    borderClass: 'border-blue-200',
    adviceClass: 'bg-blue-50 text-blue-700',
  },
  {
    key: 'q3',
    label: '无关痛痒',
    desc: '成本低 · 效果差',
    advice: '做了也不会有明显改变，可做可不做，谨慎分配时间。',
    dotClass: 'bg-amber-400',
    borderClass: 'border-amber-200',
    adviceClass: 'bg-amber-50 text-amber-700',
  },
  {
    key: 'q4',
    label: '劳民伤财',
    desc: '成本高 · 效果差',
    advice: '投入大回报低，果断排除，避免沉没成本陷阱。',
    dotClass: 'bg-rose-500',
    borderClass: 'border-rose-200',
    adviceClass: 'bg-rose-50 text-rose-700',
  },
];
