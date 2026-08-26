/**
 * CollapseDetail — 渐进式披露「明细折叠」（02 §3.2 / 04 §3.9 行 6 包装层）：
 * 默认折叠，「查看详情 ▸」展开为「收起 ▾」；约 260ms grid-template-rows 过渡 + 箭头旋转，
 * aria-expanded 无障碍；不触发图表重渲染（纯 DOM/CSS）。
 * 注：报表明细表需要受控展开（PDF 导出态全量展开、下钻联动），故在应用层实现受控版本；
 * 表单场景的可选项折叠复用 shared-core CollapsibleSection/OptionalFieldsGroup（见资产树编辑）。
 */
import React, { useEffect, useState } from 'react';

interface CollapseDetailProps {
  title: string;
  children: React.ReactNode;
  /** 受控展开（PDF 导出态强制展开，F-11 规则 1） */
  forceOpen?: boolean;
  defaultOpen?: boolean;
}

export function CollapseDetail({ title, children, forceOpen, defaultOpen = false }: CollapseDetailProps) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-slate-50/60"
      >
        <span className="text-sm font-medium text-slate-800">{title}</span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-blue-600">
          {open ? '收起' : '查看详情'}
          <svg
            className={`h-3.5 w-3.5 transition-transform duration-300 ease-out ${open ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-slate-100 px-5 py-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
