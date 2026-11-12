/**
 * 备份导出/校验/恢复回归（F-07 / 05 §3.23~3.27）：名称路径可解析、非法载荷逐条报错、恢复走单事务批次。
 */
import { describe, it, expect } from 'vitest';
import {
  BACKUP_SCHEMA_VERSION,
  buildExportPayload,
  validateBackupPayload,
  restoreFromPayload,
  type BackupPayload,
} from '../../backend/services/backupCore.ts';
import { mockDb, ranSql } from '../helpers/mockD1.ts';
import { treeNodes, catItems, debts, bundleFactory } from '../helpers/fixtures.ts';

const b = bundleFactory();

function handler(sql: string) {
  if (sql.includes('FROM tree_configs ORDER BY version')) {
    return [{ id: 1, version: 1, effective_from_month: '2025-01', note: null }];
  }
  if (sql.includes('FROM cat_configs ORDER BY version')) return [{ id: 1, version: 1, threshold_cents: 100000 }];
  if (sql.includes('FROM tree_nodes')) return treeNodes();
  if (sql.includes('FROM cat_items')) return catItems();
  if (sql.includes('FROM debts ORDER BY')) return debts();
  if (sql.includes('SELECT month FROM monthly_snapshots')) return [{ month: '2026-10' }];
  if (sql.includes('FROM monthly_snapshots WHERE month')) return b.snapshot;
  if (sql.includes('FROM tree_configs WHERE id')) return b.treeConfig;
  if (sql.includes('FROM cat_configs WHERE id')) return b.catConfig;
  if (sql.includes('FROM snapshot_assets')) return b.assets;
  if (sql.includes('FROM snapshot_gains')) return b.gains;
  if (sql.includes('FROM snapshot_debts')) return b.debtsSnap;
  if (sql.includes('FROM snapshot_cat_amounts')) return b.catAmounts;
  if (sql.includes('FROM snapshot_large_items')) return b.largeItems;
  if (sql.includes('FROM report_snapshots')) {
    return [{ report_type: 'year', start_month: '2026-01', end_month: '2026-10', generated_at: '2026-10-31', payload_json: '{"kpi":1}' }];
  }
  if (sql.includes('FROM ai_analyses')) {
    return [{ analysis_date: '2026-10-31', asset_month: '2026-10', payload_json: '{"t":1}' }];
  }
  return null;
}

function validPayload(): BackupPayload {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-10-31T00:00:00Z',
    treeConfigs: [
      {
        version: 1,
        effectiveFromMonth: '2025-01',
        note: null,
        nodes: [
          { name: '金融资产', parentKey: null, nodeType: 'module', targetRateAnnual: 0.06, updateFreq: null, enabled: true, sortOrder: 1, identityInfo: null, isPlaceholder: false },
          { name: '活期', parentKey: '金融资产', nodeType: 'leaf', targetRateAnnual: null, updateFreq: 'monthly', enabled: true, sortOrder: 1, identityInfo: null, isPlaceholder: false },
        ],
      },
    ],
    catConfigs: [
      {
        version: 1,
        threshold: 1000,
        items: [
          { name: '工资收入', parentName: null, direction: 'income', sortOrder: 1 },
          { name: '月薪', parentName: '工资收入', direction: 'income', sortOrder: 1 },
        ],
      },
    ],
    debts: [
      { name: '房贷', debtType: 'mortgage', term: 'long', balance: 50000, annualRate: 0.041, monthlyPayment: 3000, fixedRepayment: true, enabled: true },
    ],
    snapshots: [
      {
        month: '2026-10', treeConfigVersion: 1, catConfigVersion: 1,
        assets: [{ nodeKey: '金融资产>活期', balance: 10000, hasNewFunds: false, updateSource: 'current' }],
        moduleGains: [], income: [{ cat: '工资收入>月薪', amount: 20000 }], expense: [],
        largeItems: [], debts: [{ name: '房贷', balance: 50000, repayment: 3000 }], correctedAt: null,
      },
    ],
    reportSnapshots: [],
    aiAnalyses: [],
    // v2 起必含的四组扩展数据（校验器会拒绝缺失，视为文件被截断）
    depreciations: [],
    revaluations: [],
    contingentLiabilities: [],
    healthConfig: [],
  };
}

describe('buildExportPayload', () => {
  it('导出名称路径结构与报告/分析条目', async () => {
    const payload = await buildExportPayload(mockDb(handler));
    expect(payload.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(payload.treeConfigs[0].nodes[0].parentKey).toBeNull();
    expect(payload.treeConfigs[0].nodes[1].parentKey).toBe('金融资产');
    expect(payload.snapshots[0].assets[0].nodeKey).toBe('金融资产>活期');
    expect(payload.snapshots[0].income[0].cat).toBe('工资收入>月薪');
    expect(payload.reportSnapshots[0].payload).toEqual({ kpi: 1 });
    expect(payload.aiAnalyses[0].assetMonth).toBe('2026-10');
  });

  it('导出的载荷自身通过校验', async () => {
    const payload = await buildExportPayload(mockDb(handler));
    expect(validateBackupPayload(payload)).toEqual([]);
  });
});

describe('validateBackupPayload', () => {
  it('合法载荷零错误', () => {
    expect(validateBackupPayload(validPayload())).toEqual([]);
  });

  it('非对象/版本不符直接拒绝', () => {
    expect(validateBackupPayload(null)[0].field).toBe('payload');
    expect(validateBackupPayload({ schemaVersion: 99 })[0].field).toBe('schemaVersion');
  });

  it('缺失必需数组逐条列出', () => {
    const errors = validateBackupPayload({ schemaVersion: BACKUP_SCHEMA_VERSION });
    expect(errors.map((e) => e.field)).toEqual(expect.arrayContaining(['treeConfigs', 'catConfigs', 'debts', 'snapshots']));
  });

  it('父路径不存在被拒绝', () => {
    const p = validPayload();
    p.treeConfigs[0].nodes[1].parentKey = '不存在的父';
    expect(validateBackupPayload(p).some((e) => e.message.includes('父节点路径'))).toBe(true);

    const q = validPayload();
    (q.catConfigs[0].items[1] as unknown as { parentName: string | null }).parentName = '不存在分类';
    expect(validateBackupPayload(q).some((e) => e.message.includes('父分类不存在'))).toBe(true);
  });

  it('负债与节点字段非法被拒绝', () => {
    const p = validPayload();
    (p.debts[0] as unknown as { term: string }).term = 'mid';
    (p.treeConfigs[0].nodes[0] as unknown as { nodeType: string }).nodeType = 'root';
    const messages = validateBackupPayload(p).map((e) => e.message);
    expect(messages).toEqual(expect.arrayContaining(['期限非法', '节点类型非法']));
  });
});

describe('restoreFromPayload', () => {
  it('恢复先清空后重建，返回统计', async () => {
    const db = mockDb(handler);
    const res = await restoreFromPayload(db, validPayload());
    expect(ranSql(db, 'DELETE FROM monthly_snapshots')).toBe(true);
    expect(ranSql(db, 'INSERT INTO tree_configs')).toBe(true);
    expect(ranSql(db, 'INSERT INTO cat_configs')).toBe(true);
    expect(ranSql(db, 'INSERT INTO debts')).toBe(true);
    expect(res.restored).toBe(true);
    expect(res.counts.treeConfigs).toBe(1);
    expect(res.counts.snapshots).toBe(1);
  });

  // P0-1 回归：asset_depreciation / asset_revaluations 外键引用 tree_nodes，
  // 必须在 DELETE FROM tree_nodes 之前清空，否则 D1 强制外键会让整批回滚。
  it('扩展表清理早于 tree_nodes（外键顺序）', async () => {
    const db = mockDb(handler);
    await restoreFromPayload(db, validPayload());
    const sqls = ((db as unknown as { __calls: { sql: string }[] }).__calls ?? []).map((c) => c.sql);
    const idx = (fragment: string) => sqls.findIndex((s) => s.includes(fragment));
    const treeNodesAt = idx('DELETE FROM tree_nodes');
    expect(treeNodesAt).toBeGreaterThan(-1);
    expect(idx('DELETE FROM asset_revaluations')).toBeGreaterThan(-1);
    expect(idx('DELETE FROM asset_revaluations')).toBeLessThan(treeNodesAt);
    expect(idx('DELETE FROM asset_depreciation')).toBeLessThan(treeNodesAt);
    expect(idx('DELETE FROM tree_configs')).toBeGreaterThan(treeNodesAt);
  });

  // P0-2 回归：节点必须带 assetCategory / liquidity，否则恢复后实物资产退化为 financial/medium
  it('恢复节点时写入 asset_category 与 liquidity', async () => {
    const db = mockDb(handler);
    const p = validPayload();
    p.treeConfigs[0].nodes[1].assetCategory = 'physical';
    p.treeConfigs[0].nodes[1].liquidity = 'low';
    await restoreFromPayload(db, p);
    // mockD1 先记录 prepare（args 为空），再记录每次 bind；取最后一条带参数的 tree_nodes 插入
    const calls = ((db as unknown as { __calls: { sql: string; args: unknown[] }[] }).__calls ?? []).filter(
      (c) => c.sql.includes('INSERT INTO tree_nodes') && c.args.length > 0
    );
    expect(calls.length).toBeGreaterThan(0);
    const insert = calls[calls.length - 1];
    expect(insert.sql).toContain('asset_category');
    expect(insert.sql).toContain('liquidity');
    expect(insert.args).toContain('physical');
    expect(insert.args).toContain('low');
  });

  it('v1 历史备份可恢复，并给出折旧丢失告警', async () => {
    const db = mockDb((sql, args) => {
      if (sql.includes('COUNT(*) AS c FROM asset_depreciation')) return { c: 3 };
      if (sql.includes('COUNT(*) AS c FROM asset_revaluations')) return { c: 2 };
      return handler(sql, args);
    });
    const v1 = validPayload();
    v1.schemaVersion = 1;
    for (const k of ['depreciations', 'revaluations', 'contingentLiabilities', 'healthConfig'] as const) {
      delete (v1 as Record<string, unknown>)[k];
    }
    for (const n of v1.treeConfigs[0].nodes) {
      delete n.assetCategory;
      delete n.liquidity;
    }
    expect(validateBackupPayload(v1)).toEqual([]);
    const res = await restoreFromPayload(db, v1);
    expect(res.schemaVersion).toBe(1);
    expect(res.warnings.some((w) => w.includes('折旧'))).toBe(true);
    // v1 不含这两张表 → 保留原值，不做 DELETE
    expect(ranSql(db, 'DELETE FROM contingent_liabilities')).toBe(false);
    expect(ranSql(db, 'DELETE FROM health_config')).toBe(false);
  });

  it('v2 备份恢复覆盖扩展表（先删后建）', async () => {
    const db = mockDb(handler);
    const p = validPayload();
    delete p.depreciations;
    delete p.revaluations;
    delete p.contingentLiabilities;
    delete p.healthConfig;
    const res = await restoreFromPayload(db, p);
    expect(res.counts.depreciations).toBe(0);
    expect(res.counts.revaluations).toBe(0);
  });
});
