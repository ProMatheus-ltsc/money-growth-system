/**
 * 前端 API 类型（与 05-api-doc.md V1.0 契约一致；金额单位一律为元）
 */

// ---------- 认证 ----------
export type Role = 'admin' | 'viewer';

// ---------- 资产树（§3.5/§3.6） ----------
export type NodeType = 'module' | 'sub' | 'leaf';
export type UpdateFreq = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular';
export type AssetCategory = 'financial' | 'physical';
export type Liquidity = 'high' | 'medium' | 'low';

export interface TreeNode {
  id: number;
  parentId: number | null;
  name: string;
  nodeType: NodeType;
  targetRateAnnual: number | null;
  updateFreq: UpdateFreq | null;
  enabled: boolean;
  sortOrder: number;
  identityInfo: string | null;
  isPlaceholder: boolean;
  assetCategory: AssetCategory;
  liquidity: Liquidity;
}

export interface TreeConfig {
  configId: number;
  version: number;
  effectiveFromMonth: string;
  nodes: TreeNode[];
}

// 前端编辑态节点（保存前以 tempId 引用）
export interface EditTreeNode {
  tempId: string;
  parentId: string | null; // tempId 或 null
  serverId?: number;
  name: string;
  nodeType: NodeType;
  targetRateAnnual: number | null;
  updateFreq: UpdateFreq | null;
  enabled: boolean;
  sortOrder: number;
  identityInfo: string | null;
  isPlaceholder: boolean;
  assetCategory: AssetCategory;
  liquidity: Liquidity;
}

// ---------- 收支分类（§3.16/§3.17） ----------
export interface CatItem {
  id: number;
  name: string;
  sortOrder: number;
  children?: CatItem[];
}

export interface CatConfig {
  configId: number;
  version: number;
  threshold: number;
  income: CatItem[];
  expense: CatItem[];
}

// ---------- 负债（§3.12~§3.15） ----------
export type DebtType = 'mortgage' | 'auto_loan' | 'credit_card' | 'other';
export type DebtTerm = 'short' | 'long';

export interface Debt {
  id: number;
  name: string;
  debtType: DebtType;
  term: DebtTerm;
  annualRate: number;
  monthlyPayment: number;
  fixedRepayment: boolean;
  enabled: boolean;
  monthBalance: number;
  monthRepayment: number | null;
}

export interface DebtTotals {
  totalDebt: number;
  shortTermDebt: number;
  longTermDebt: number;
  debtRatio: number | null;
  monthlyRepayment: number;
  netWorth: number | null;
}

// ---------- 月度快照（§3.7~§3.9） ----------
export interface MonthSummary {
  month: string;
  totalAssets: number;
  totalDebt: number;
  netWorth: number;
  debtRatio: number;
  totalIncome: number;
  totalExpense: number;
  balance: number;
  corrected: boolean;
}

export interface SnapshotsListData {
  range: string;
  months: MonthSummary[];
  byModule: { module: string; points: { month: string; amount: number }[] }[];
}

export interface SnapshotAssetEntry {
  nodeId: number;
  balance: number;
  hasNewFunds: boolean;
  updateSource: 'current' | 'carried';
}

export interface SnapshotDetail {
  exists: boolean;
  month: string;
  // exists=true：
  treeConfigId?: number;
  catConfigId?: number;
  /** 快照绑定版本的资产树节点（用于只读展示，确保历史快照不受后续资产树变更影响） */
  treeNodes?: { id: number; parentId: number | null; name: string; nodeType: string; enabled: boolean; sortOrder: number; identityInfo: string | null; assetCategory: AssetCategory }[];
  assets?: SnapshotAssetEntry[];
  moduleGains?: { nodeId: number; gain: number | null }[];
  income?: { catItemId: number; amount: number }[];
  expense?: { catItemId: number; amount: number }[];
  largeItems?: { id?: number; direction: 'income' | 'expense'; catItemId: number; name: string; amount: number }[];
  debts?: { debtId: number; balance: number; repayment: number; fixedRepayment: boolean }[];
  totals?: SnapshotTotals;
  correctedAt?: string | null;
  locked?: boolean;
  // exists=false：
  carried?: { nodeId: number; balance: number; lastUpdatedMonth: string }[];
  debtDefaults?: { debtId: number; name: string; fixedRepayment: boolean; monthlyPayment: number; lastBalance: number }[];
}

export interface SnapshotTotals {
  totalAssets: number;
  totalDebt: number;
  netWorth: number;
  debtRatio: number;
  totalIncome: number;
  totalExpense: number;
  balance: number;
}

// ---------- 报表（§3.10/§3.11） ----------
export interface AssetReportData {
  kpi: { totalAssets: number; netWorth: number; momGrowth: number | null; debtRatio: number };
  trend: {
    months: string[];
    total: number[];
    expected: number[];
    byModule: { module: string; amounts: number[] }[];
  };
  treemap: { module: string; amount: number; children: { name: string; amount: number }[] }[];
  sankey: {
    income: { cat: string; amount: number }[];
    totalIncome: number;
    expense: { cat: string; amount: number }[];
    balance: number;
    balanceRatio: number;
  };
  gainCompare: {
    module: string;
    mode: 'auto' | 'converted' | 'blank' | 'na';
    targetMonthlyRate: number | null;
    actualRate: number | null;
    gain: number | null;
  }[];
  updateStatus: { nodeId: number; name: string; freq: string; status: 'updated' | 'carried'; lastUpdatedMonth: string }[];
}

export interface FinanceReportData {
  month: string;
  balanceSheet: {
    kpi: { totalAssets: number; totalDebt: number; shortTermDebt: number; longTermDebt: number; netWorth: number; debtRatio: number };
    assetTreemap: { module: string; amount: number; children: { name: string; amount: number }[] }[];
    debtDonut: { term: 'short' | 'long'; amount: number }[];
    details: { assets: { name: string; amount: number }[]; debts: { name: string; term: 'short' | 'long'; balance: number }[] };
  };
  incomeStatement: {
    kpi: { totalIncome: number; totalExpense: number; balance: number };
    sankey: AssetReportData['sankey'];
    groupBar: { income: { cat: string; amount: number }[]; expense: { cat: string; amount: number }[] };
    details: {
      income: FinanceCatDetail[];
      expense: FinanceCatDetail[];
      history?: { direction: 'income' | 'expense'; cat: string; amount: number }[];
    };
  };
  cashFlow: null | {
    kpi: { openingCash: number; netCashFlow: number; closingCash: number };
    waterfall: { name: string; amount: number; type: 'start' | 'delta' | 'end' }[];
    details: { name: string; formula: string; amount: number }[];
  };
  notes: Record<string, string>;
}

export interface FinanceCatDetail {
  cat: string;
  amount: number;
  children?: { cat: string; amount: number; largeItems?: { name: string; amount: number }[] }[];
}

// ---------- 报告快照（§3.18~§3.21） ----------
export interface ReportSnapshotListItem {
  id: number;
  reportType: 'quarter' | 'half' | 'year';
  startMonth: string;
  endMonth: string;
  generatedAt: string;
  totalAssets: number;
  netWorth: number;
  debtRatio: number;
  periodBalance: number;
  frozen: boolean;
}

export interface ReportSnapshotDetail extends ReportSnapshotListItem {
  kpis: { totalAssets: number; netWorth: number; debtRatio: number; periodBalance: number };
  charts: {
    treemap: AssetReportData['treemap'];
    waterfall: { name: string; amount: number; type: 'start' | 'delta' | 'end' }[];
    sankey: AssetReportData['sankey'];
    debtDonut: { term: 'short' | 'long'; amount: number }[];
  };
  statements: {
    balanceSheet?: FinanceReportData['balanceSheet'];
    incomeStatement?: FinanceReportData['incomeStatement'];
    cashFlow?: FinanceReportData['cashFlow'];
    [k: string]: unknown;
  };
  details: Record<string, unknown>;
  aiRecords: { id: number; analysisDate: string; assetMonth: string; payload: AiPayload }[];
}

export interface ReportCompareData {
  a: { id: number; label: string; reportType: string; startMonth: string; endMonth: string; kpis: { totalAssets: number; netWorth: number; debtRatio: number; periodBalance: number } };
  b: ReportCompareData['a'];
  diffs: { metric: string; aValue: number; bValue: number; absDiff: number; pctDiff: number | null; direction: 'up' | 'down' | 'flat' }[];
  moduleCompare: { module: string; aAmount: number | null; bAmount: number | null; absDiff: number; pctDiff: number | null }[];
  debtCompare: { name: string; aBalance: number | null; bBalance: number | null; absDiff: number }[];
}

// ---------- AI（§3.28~§3.31） ----------
export interface AiSuggestion {
  type: string;
  module: string;
  current: string;
  plan: string;
  reason: string;
  priority: string;
}

export interface AiPayload {
  analysisDate?: string;
  assetMonth?: string;
  suggestions?: AiSuggestion[];
  [k: string]: unknown;
}

export interface AiRecord {
  id: number;
  analysisDate: string;
  assetMonth: string;
  suggestionCount: number;
  createdAt: string;
  payload: AiPayload;
}

// ---------- 备份（§3.23~§3.27） ----------
export interface BackupListItem {
  key: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupCounts {
  treeConfigs: number;
  catConfigs: number;
  debts: number;
  snapshots: number;
  reportSnapshots: number;
  aiAnalyses: number;
}

// ---------- PDF（§3.32） ----------
export interface PdfPayload {
  scope: 'month' | 'report';
  month?: string;
  reportId?: number;
  title: string;
  kpis: Record<string, number | null>;
  statements: Record<string, unknown>;
  charts: Record<string, unknown>;
  aiRecords: { id: number; analysisDate: string; assetMonth?: string; payload: AiPayload }[];
  meta: { generatedAt: string; unit: string; noPII: boolean };
}
