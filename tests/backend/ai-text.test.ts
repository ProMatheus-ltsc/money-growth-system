/**
 * AI 数据包文本生成回归（F-06）：四分区结构与关键内容存在，缺失上期时降级。
 */
import { describe, it, expect } from 'vitest';
import { buildAiExportText } from '../../backend/services/aiText.ts';
import { mockDb } from '../helpers/mockD1.ts';
import { bundleFactory, treeNodes, catItems, debts } from '../helpers/fixtures.ts';

const b = bundleFactory();

function handler(sql: string) {
  if (sql.includes('FROM monthly_snapshots WHERE month')) return b.snapshot;
  if (sql.includes('FROM tree_configs WHERE id')) return b.treeConfig;
  if (sql.includes('FROM cat_configs WHERE id')) return b.catConfig;
  if (sql.includes('FROM tree_nodes')) return treeNodes();
  if (sql.includes('FROM cat_items')) return catItems();
  if (sql.includes('FROM debts ORDER BY')) return debts();
  if (sql.includes('FROM snapshot_assets')) return b.assets;
  if (sql.includes('FROM snapshot_gains')) return b.gains;
  if (sql.includes('FROM snapshot_debts')) return b.debtsSnap;
  if (sql.includes('FROM snapshot_cat_amounts')) return b.catAmounts;
  if (sql.includes('FROM snapshot_large_items')) return b.largeItems;
  if (sql.includes('SELECT ms.month FROM snapshot_assets sa')) return { month: '2026-10' };
  return null;
}

describe('buildAiExportText', () => {
  it('输出四分区文本并包含月份与资产总额', async () => {
    const text = await buildAiExportText(mockDb(handler), b);
    expect(text).toContain('2026-10');
    expect(text).toContain('330,000'); // 总资产（元，千分位）
    expect(text.length).toBeGreaterThan(200);
  });

  it('无上期快照时仍可生成（现金流降级）', async () => {
    const db = mockDb((sql) => (sql.includes('FROM monthly_snapshots WHERE month') && !sql.includes('2026-10') ? null : handler(sql)));
    const text = await buildAiExportText(db, b);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
