/**
 * 表单Tab导航组件
 * 增强自 personal_review_system / root-cause-analysis
 *
 * 通用能力：
 * - isLocked 🔒 / isReadOnly ✓ / hasErrors 红点角标
 * - 键盘左右方向键切换
 * - collapsedByDefault 折叠（details/summary，整条 tab 栏可折叠）
 * - flex-wrap 自动换行（页签过多时避免溢出视口）
 * - 兼容旧 API：tabs={[{id,title}]} 简写形式
 */
import type { FormSection } from '../../types';

interface FormTabsProps {
  /** 增强版：传入完整 section 列表（用于展示标题/隐藏/折叠标记） */
  sections?: FormSection[];
  /** 兼容旧 API：简写 tab 列表 */
  tabs?: { id: string; title: string }[];
  activeTab: number;
  /** 返回 true 的 tab 索引将被隐藏（不渲染） */
  shouldHide?: (index: number) => boolean;
  isLocked?: (index: number) => boolean;
  isReadOnly?: (index: number) => boolean;
  hasErrors?: (index: number) => boolean;
  onTabChange: (index: number) => void;
  /** 折叠整个 tab 栏（details/summary），如页签过多时可配置 collapsedByDefault */
  collapsible?: { label?: string; collapsedByDefault?: boolean };
}

export function FormTabs({
  sections,
  tabs,
  activeTab,
  shouldHide = () => false,
  isLocked = () => false,
  isReadOnly = () => false,
  hasErrors = () => false,
  onTabChange,
  collapsible,
}: FormTabsProps) {
  // 兼容旧 API：tabs 简写 → 无 sections 时使用
  const list = sections
    ? sections.map((s, i) => ({ id: s.id, title: s.title, collapsed: s.collapsedByDefault }))
    : (tabs ?? []).map((t) => ({ id: t.id, title: t.title, collapsed: false }));

  if (list.length <= 1) return null;

  const nav = (
    <nav className="flex flex-wrap -mb-px" role="tablist" aria-label="表单部分">
      {list.map((section, index) => {
        if (shouldHide(index)) return null;
        const locked = isLocked(index);
        const readOnly = isReadOnly(index);
        const hasError = hasErrors(index);
        return (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={index === activeTab}
            tabIndex={index === activeTab ? 0 : -1}
            disabled={locked}
            onClick={() => onTabChange(index)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' && index < list.length - 1) {
                onTabChange(index + 1);
              } else if (e.key === 'ArrowLeft' && index > 0) {
                onTabChange(index - 1);
              }
            }}
            className={`whitespace-nowrap px-3.5 py-2.5 text-sm font-medium border-b-2 transition ${hasError ? 'relative' : ''} ${
              locked
                ? 'border-transparent text-slate-300 cursor-not-allowed'
                : index === activeTab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            {locked && <span className="mr-1">🔒</span>}
            {readOnly && !locked && <span className="mr-1 opacity-70">✓</span>}
            {section.title}
            {hasError && <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />}
          </button>
        );
      })}
    </nav>
  );

  // 折叠整个 tab 栏（details/summary）
  if (collapsible) {
    return (
      <details
        className="mb-6 border-b border-slate-200"
        open={!collapsible.collapsedByDefault}
      >
        <summary className="cursor-pointer select-none px-3.5 py-2 text-sm font-medium text-slate-500 hover:text-slate-700">
          {collapsible.label ?? '分区导航'} ▾
        </summary>
        {nav}
      </details>
    );
  }

  return <div className="mb-6 border-b border-slate-200">{nav}</div>;
}
