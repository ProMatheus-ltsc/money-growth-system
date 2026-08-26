/**
 * @shared/core - 三项目共用的公共基座包
 * 统一导出所有类型、服务、Hooks、组件和工具函数
 *
 * 说明：主入口只导出"必装 peerDependencies"能覆盖的模块。
 * 依赖可选库的模块走子路径导出（见 package.json exports）：
 * - CausalGraph（@xyflow/react）
 * - RootCauseTypePie（recharts）
 * - useSearch（flexsearch）
 */

// Types
export * from './types';

// Services
export {
  setCurrentAccountId, getCurrentAccountId,
  listAccounts, getAccountByUsername, createAccount,
  getAllRecords, getRecord, putRecord, deleteRecord, deleteRecords,
  getRecordsByTemplate, getRecordsByModule, searchRecords,
  getSetting, setSetting,
  exportAllData, importAllData, clearAllData,
  getRecordsModifiedSince,
  getSnapshotsByRecord, putSnapshot, deleteSnapshot, deleteSnapshotsByRecord,
} from './services/db';
export { registerAccount, verifyAccountPassword, resetAccountPassword } from './services/auth';
export {
  configureSyncService, getSyncConfig, getSyncStatus,
  pushChanges, pullChanges, fullBackupToD1, restoreFromD1,
} from './services/cloudflareD1';

// Hooks
export { AuthProvider, useAuth } from './hooks/useAuth';
export { ToastProvider, useToast } from './hooks/useToast';
export type { ToastType, ToastMessage } from './hooks/useToast';
export { useRecords, useRecord, useSaveRecord, useDeleteRecord, useSearchRecords } from './hooks/useDB';
export { usePhaseLogic, useFormPhaseLogic } from './hooks/usePhaseLogic';
export type { PhaseState, UseFormPhaseLogicParams, UseFormPhaseLogicResult } from './hooks/usePhaseLogic';
export { useSnapshots } from './hooks/useSnapshots';

// 基础组件
export { Layout } from './components/Layout';
export { ToastContainer } from './components/Toast';
export { ConfirmDialog } from './components/ConfirmDialog';
export { LoadingSpinner } from './components/LoadingSpinner';
export { ProtectedRoute } from './components/ProtectedRoute';
export { default as SearchBar } from './components/SearchBar';
export { default as PasswordInput } from './components/PasswordInput';
export { default as TemplateCard } from './components/TemplateCard';
export { default as RecordList } from './components/RecordList';
export { VersionHistoryList } from './components/VersionHistoryList';

// 表单引擎组件
export { FormRenderer } from './components/form/FormRenderer';
export type { FormRendererSlots, FormRendererSlotContext } from './components/form/FormRenderer';
export { FieldRenderer } from './components/form/FieldRenderer';
export { ConditionalField } from './components/form/ConditionalField';
export { FormTabs } from './components/form/FormTabs';
export { RepeatableSection } from './components/form/RepeatableSection';
export { PhaseIndicator } from './components/form/PhaseIndicator';
export type { PhaseIndicatorPhase } from './components/form/PhaseIndicator';
export { default as PhaseNotice } from './components/form/PhaseNotice';
export { default as OptionalFieldsGroup } from './components/form/OptionalFieldsGroup';
export { default as CollapsibleSection } from './components/form/CollapsibleSection';
export { default as FormNavButtons } from './components/form/FormNavButtons';
export * from './components/form/FieldInputs';
export * from './components/form/quadrantConfig';

// 统计与可视化（零重依赖）
export { StatCard } from './components/stats/StatCard';
export { KeywordList } from './components/stats/KeywordList';
export { MatrixHeatmap } from './components/visualize/MatrixHeatmap';
export { FishboneDiagram } from './components/visualize/FishboneDiagram';
export { ComparisonDiffChart } from './components/visualize/ComparisonDiffChart';
export { TimelineChart } from './components/visualize/TimelineChart';
export { WhyLadderChart } from './components/visualize/WhyLadderChart';
export { LoopDiagram } from './components/visualize/LoopDiagram';

// Utils
export {
  isFieldEmpty, resolveDefaultValue, getRequiredFields,
  validateRequiredFields, calculateCompleteness,
  getPhaseSections, buildInitialValues,
  getRepeatableEntriesKey, readRepeatableEntries,
  isEmptyValue, EMPTY_QUADRANT_MATRIX, EMPTY_DRAG_MATRIX,
  getSectionPhaseIndex, getCurrentPhaseIndex,
  getPhaseTimeLockInfo,
} from './utils/formValidation';
export * from './utils/exportFormatter';
export { detectLoops, detectLoopsText } from './utils/loopDetection';
export { getFieldSuggestions } from './utils/suggestions';
