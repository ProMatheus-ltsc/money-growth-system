/**
 * CollapsibleSection — 可折叠表单分区
 *
 * 提取自 personal_review_system/src/components/form/CollapsibleSection.tsx
 * 类型统一使用公共包 shared-core types 的 FormSection。
 *
 * 对于设置了 collapsedByDefault=true 的 section，初始状态为收起，
 * 显示标题和「可选」标签，点击后展开内容。
 * 对于普通 section（collapsedByDefault=false），直接展示所有内容。
 */
import React, { useState } from 'react';
import type { FormSection } from '../../types';

interface CollapsibleSectionProps {
  section: FormSection;
  children: React.ReactNode;
}

/** Collapsible section for collapsedByDefault */
const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({ section, children }) => {
  const [expanded, setExpanded] = useState(!section.collapsedByDefault);

  return (
    <div className="mb-4">
      {section.collapsedByDefault && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between py-2 mb-2 text-left"
        >
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-gray-500">{section.title}</h3>
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
              可选
            </span>
          </div>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
      {expanded && <div className={section.collapsedByDefault ? 'animate-fadeIn' : ''}>{children}</div>}
    </div>
  );
};

export default CollapsibleSection;
