/**
 * 公共基座类型定义：模板驱动表单引擎的核心类型契约
 * 三个项目（公考复盘、根因分析、个人复盘）共用此类型系统
 * 增强自 personal_review_system / root-cause-analysis
 */

/** 表单字段类型 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'rating'
  | 'table'
  | 'quadrant'
  | 'dragMatrix'
  | 'jsonImport'
  | 'custom'
  | 'hidden';

/** 选项定义 */
export interface FieldOption {
  value: string;
  label: string;
}

/** 四象限矩阵的象限标识（参考《高效能人士的七个习惯》时间管理矩阵） */
export type QuadrantKey = 'q1' | 'q2' | 'q3' | 'q4';

/** 象限中的单个事项 */
export interface QuadrantItem {
  id: string;
  text: string;
}

/** 四象限矩阵的值结构：每个象限一组事项 */
export type QuadrantMatrix = Record<QuadrantKey, QuadrantItem[]>;

/** 四象限配置：名称 / 典型事项 / 处理原则 / 指导建议 / 视觉样式 */
export interface QuadrantConfig {
  key: QuadrantKey;
  /** 象限名称，如「紧急且重要」 */
  label: string;
  /** 处理原则，如「立即做」 */
  action: string;
  /** 典型事项示例，如「危机、紧急问题、临期任务」 */
  typical: string;
  /** 针对该象限的指导建议 */
  advice: string;
  /** 事项输入框占位提示 */
  placeholder: string;
  /** 建议投入时间占比参考，如「40-50%（核心）」 */
  ratio: string;
  /** 象限色点 class */
  dotClass: string;
  /** 卡片边框 class */
  borderClass: string;
  /** 指导建议背景 class */
  adviceClass: string;
  /** 第二象限（重点）外发光 ring class */
  ringClass?: string;
}

/** 拖拽决策矩阵的值结构：每个象限一组选项文本（选项来自表格列，如 options_analysis.option_name） */
export type DragMatrixValue = Record<QuadrantKey, string[]>;

/** 拖拽决策矩阵的象限配置（成本×效果评估） */
export interface DragMatrixQuadrantConfig {
  key: QuadrantKey;
  /** 象限名称，如「事半功倍」 */
  label: string;
  /** 象限描述（成本/效果说明），如「成本低 · 效果好」 */
  desc: string;
  /** 处理建议 */
  advice: string;
  /** 色点 class */
  dotClass: string;
  /** 卡片边框 class */
  borderClass: string;
  /** 建议背景 class */
  adviceClass: string;
}

/** 表格列定义 */
export interface TableColumn {
  id: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  /** 兼容两种写法：`string[]`（简写）或 `FieldOption[]`（带 label/value） */
  options?: FieldOption[] | string[];
  placeholder?: string;
  /** 列宽（可选，如 '30%'） */
  width?: string;
}

/** 字段校验规则 */
export interface FieldValidation {
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternMessage?: string;
}

/** 字段显隐条件 */
export interface FieldCondition {
  dependsOn: string;
  showWhen: string | string[];
}

/** 字段计算公式 */
export interface FieldComputed {
  dependsOn: string[];
  /** 依赖字段 ID 从外部上下文（如父记录）解析，RepeatableSection 条目计算用 */
  externalDeps?: string[];
  formula: (values: Record<string, unknown>) => string | unknown;
  placeholder?: string;
  errorText?: string;
  editable?: boolean;
}

/** 表单字段定义 */
export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  options?: FieldOption[];
  validation?: FieldValidation;
  tableColumns?: TableColumn[];
  priority?: 'required' | 'recommended' | 'optional';
  condition?: FieldCondition;
  hint?: string;
  defaultValue?: unknown;
  autocomplete?: boolean;
  emphasis?: boolean;
  computed?: FieldComputed;
  collapsedByDefault?: boolean;
  autoTimestamp?: boolean;
  /** 只读字段：展示已存值，禁止手动编辑 */
  readOnly?: boolean;
  /** 条件提示：根据 hintDependsOn 字段的值展示不同 hint 文案 */
  conditionalHints?: Record<string, string>;
  /** 条件占位符：根据 hintDependsOn 字段的值展示不同 placeholder */
  conditionalPlaceholders?: Record<string, string>;
  /** 联动提示/占位符监听的依赖字段 id */
  hintDependsOn?: string;
  /** 动态选项来源：从某个 table 字段的列取值去重（select 类型用） */
  optionsFrom?: { fieldId: string; columnId: string };
  /** 四象限矩阵配置（quadrant 类型专用）：定义 4 个象限的名称与指导建议 */
  quadrants?: QuadrantConfig[];
  /** 拖拽决策矩阵配置（dragMatrix 类型专用）：定义成本×效果四象限；选项来源复用 optionsFrom */
  dragQuadrants?: DragMatrixQuadrantConfig[];
}

/** 表单分区 */
export interface FormSection {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
  collapsedByDefault?: boolean;
  repeatable?: boolean;
  repeatLabel?: string;
  minEntries?: number;
  stopAppendWhen?: { fieldId: string; value: string };
}

/** 阶段配置 */
export interface PhaseConfig {
  id: string;
  label: string;
  icon: string;
  description?: string;
  sectionIndices: number[];
  completionFields: string[];
  /** 冷静期天数：基于 activateAfterField 日期计算，到天数后才建议复盘 */
  activateAfterDays?: number;
  /** 冷静期基准日期字段 id（如 sell_date） */
  activateAfterField?: string;
  /** 硬性时间锁：基于解锁参考日期后的天数，未到期阶段不可进入 */
  unlockAfterDays?: number;
  /** 时间锁参考日期字段 id（缺省用记录创建时间） */
  unlockAfterField?: string;
  completesRecord?: boolean;
}

/** 表单模板 */
export interface FormTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  module?: string;
  recommended?: boolean;
  scenarios?: string[];
  flowSteps?: string[];
  sections: FormSection[];
  phases?: PhaseConfig[];
  timing?: { frequency: string; suggestion: string };
}

/** 表单记录 */
export interface FormRecord {
  id: string;
  templateId: string;
  title: string;
  data: Record<string, unknown>;
  status: 'draft' | 'completed';
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  module?: string;
}

/** 账户 */
export interface Account {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
}

/** 应用设置 */
export interface AppSettings {
  cooldownDays: number;
  d1Endpoint?: string;
  autoSync?: boolean;
  syncInterval?: number;
}

/** 同步状态 */
export interface SyncStatus {
  lastSyncAt: string | null;
  pendingChanges: number;
  isOnline: boolean;
}

/** 同步结果 */
export interface SyncResult {
  success: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  timestamp: string;
  error?: string;
}

/** 导出数据格式 */
export interface ExportedData {
  records: FormRecord[];
  settings: Record<string, unknown>;
  version: string;
  exportedAt: string;
}

/** 因果链条目（回路检测输入，来源 root-cause-analysis） */
export interface CausalChainItem {
  /** 源因素名 */
  factorA: string;
  /** 目标因素名 */
  factorB: string;
  /** 因果类型：增强/抑制/普通因果/无/未填 */
  relationType: 'reinforcing' | 'balancing' | 'causal' | 'none' | '';
  [key: string]: unknown;
}

/** 版本快照（手动存档点，来源 root-cause-analysis） */
export interface Snapshot {
  id: string;
  /** 所属记录 id */
  recordId: string;
  /** 快照时点的表单数据 */
  data: Record<string, unknown>;
  /** 快照标签（用户命名） */
  label: string;
  createdAt: string;
}

/** AI 分析结果：系统思考回路（来源 root-cause-analysis） */
export interface AiLoop {
  name: string;
  type: 'reinforcing' | 'balancing';
  causes: string[];
  description?: string;
}

/** AI 分析结果：杠杆点 */
export interface AiLeveragePoint {
  cause: string;
  intervention?: string;
  reason?: string;
}

/** AI 系统思考分析结果 */
export interface AiAnalysisResult {
  loops: AiLoop[];
  leveragePoints: AiLeveragePoint[];
}

