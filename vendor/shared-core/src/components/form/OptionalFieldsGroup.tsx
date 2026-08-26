/**
 * OptionalFieldsGroup — 可选字段折叠组
 *
 * 提取自 personal_review_system/src/components/form/OptionalFieldsGroup.tsx
 *
 * 将 priority='optional' 的字段收纳在一个可展开的区域中，
 * 默认折叠以减少表单视觉压力。显示「更多选项 (N)」提示用户存在额外字段。
 * 当无可选字段时（count=0）不渲染任何内容。
 */
import React, { useState } from 'react';

interface OptionalFieldsGroupProps {
  count: number;
  children: React.ReactNode;
}

/** Collapsible group for optional fields */
const OptionalFieldsGroup: React.FC<OptionalFieldsGroupProps> = ({ count, children }) => {
  const [expanded, setExpanded] = useState(false);

  if (count === 0) return null;

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors mb-2"
      >
        <svg
          className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        更多选项 ({count})
      </button>
      {expanded && <div className="animate-fadeIn">{children}</div>}
    </div>
  );
};

export default OptionalFieldsGroup;
