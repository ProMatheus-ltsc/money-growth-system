/**
 * DrillPanel — 图表下钻面板（02 §3.2 / 04 §6.2）：真实 DOM 表格（可被 PDF 展开），
 * 150~180ms 滑入；再次点击同一元素或点「收起 ✕」收起；月份/报表重绘时由页面清除。
 */
import React from 'react';

export interface DrillColumn {
  key: string;
  title: string;
  align?: 'left' | 'right';
}

export interface DrillRow {
  [key: string]: string | number;
}

interface DrillPanelProps {
  title: string;
  columns: DrillColumn[];
  rows: DrillRow[];
  onClose: () => void;
  footer?: string;
}

export function DrillPanel({ title, columns, rows, onClose, footer }: DrillPanelProps) {
  return (
    <div className="animate-in slide-in-from-bottom-2 duration-200 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-800">{title}</h4>
        <button
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-white hover:text-slate-800"
          aria-label="收起下钻面板"
        >
          收起 ✕
        </button>
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50">
              {columns.map((c) => (
                <th key={c.key} className={`px-3 py-2 text-xs font-medium text-slate-500 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-4 text-center text-xs text-slate-400">
                  无明细数据
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-50 last:border-0">
                  {columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                      {r[c.key]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {footer && <p className="mt-2 text-xs text-slate-400">{footer}</p>}
    </div>
  );
}
