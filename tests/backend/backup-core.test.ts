/**
 * 备份导出/校验/恢复回归（F-07 / 05 §3.23~3.27）：
 * 唯一节点引用（v3 ref）、非法载荷逐条报错、引用唯一性闸门、单批原子恢复。
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

/** 服务层 SQL 分发（含 v3 新增的折旧/重估/或有负债/健康阈值查询） */
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
  if (sql.includes('FROM asset_depreciation')) return [];
  if (sql.includes('FROM asset_revaluations')) return [];
  if (sql.includes('FROM contingent_liabilities')) return [];
  if (sql.includes('FROM health_config')) return [{ key: 'savings_rate_min', value: '0.2' }];
  if (sql.includes('FROM report_snapshots')) {
    return [{ report_type: 'year', start_month: '2026-01', end_month: '2026-10', generated_at: '2026-10-31', payload_json: '{"kpi":1}' }];
  }
  if (sql.includes('FROM ai_analyses')) {
    return [{ analysis_date: '2026-10-31', asset_month: '2026-10', payload_json: '{"t":1}' }];
  }
  return null;
}

/** 合法 v3 载荷：节点带 ref/parentRef，明细与折旧/重估都用 nodeRef */
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
          {
            ref: 'n1', name: '金融资产', parentRef: null, parentKey: null, nodeType: 'module',
            targetRateAnnual: 0.06, updateFreq: null, enabled: true, sortOrder: 1,
            identityInfo: null, isPlaceholder: false, assetCategory: 'financial', liquidity: 'high',
          },
          {
            ref: 'n2', name: '活期', parentRef: 'n1', parentKey: '金融资产', nodeType: 'leaf',
            targetRateAnnual: null, updateFreq: 'monthly', enabled: true, sortOrder: 1,
            identityInfo: null, isPlaceholder: false, assetCategory: 'financial', liquidity: 'high',
          },
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
        assets: [{ nodeRef: 'n2', nodeKey: '金融资产>活期', balance: 10000, hasNewFunds: false, updateSource: 'current' }],
        moduleGains: [], income: [{ cat: '工资收入>月薪', amount: 20000 }], expense: [],
        largeItems: [], debts: [{ name: '房贷', balance: 50000, repayment: 3000 }], correctedAt: null,
      },
    ],
    reportSnapshots: [],
    aiAnalyses: [],
    depreciations: [],
    revaluations: [],
    contingentLiabilities: [],
    healthConfig: [{ key: 'savings_rate_min', value: '0.2' }],
  };
}

describe('buildExportPayload', () => {
  it('导出唯一 ref 与名称路径，且报告/分析条目完整', async () => {
    const payload = await buildExportPayload(mockDb(handler));
    expect(payload.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    const nodes = payload.treeConfigs[0].nodes;
    // 每个节点都有唯一 ref；父引用用 ref 而非路径
    expect(nodes.every((n) => typeof n.ref === 'string' && n.ref.length > 0)).toBe(true);
    expect(new Set(nodes.map((n) => n.ref)).size).toBe(nodes.length);
    expect(nodes[0].parentRef).toBeNull();
    expect(nodes[1].parentRef).toBe(nodes[0].ref);
    // 名称路径仍保留（可读性 + 跨版本兼容）
    expect(nodes[1].parentKey).toBe('金融资产');
    // 明细按 ref 引用节点
    expect(payload.snapshots[0].assets[0].nodeRef).toBe(nodes[1].ref);
    expect(payload.snapshots[0].assets[0].nodeKey).toBe('金融资产>活期');
    expect(payload.snapshots[0].income[0].cat).toBe('工资收入>月薪');
    expect(payload.reportSnapshots[0].payload).toEqual({ kpi: 1 });
    expect(payload.aiAnalyses[0].assetMonth).toBe('2026-10');
  });

  it('同名同级节点获得不同 ref（不再塌成一个 key）', async () => {
    // 两个同名叶子，挂在同一个父下
    const dupTree = {
      ...treeNodes()[0],
      id: 99, parent_id: 1, name: '活期', node_type: 'leaf' as const, sort_order: 9,
    };
    const payload = await buildExportPayload(
      mockDb((sql) => (sql.includes('FROM tree_nodes') ? [...treeNodes(), dupTree] : handler(sql)))
    );
    const same = payload.treeConfigs[0].nodes.filter((n) => n.name === '活期');
    expect(same.length).toBe(2);
    expect(same[0].ref).not.toBe(same[1].ref);
    // 但名称路径确实相同——这正是旧协议会塌陷的地方
    const keys = same.map((n) => (n.parentKey === null ? n.name : `${n.parentKey}>${n.name}`));
    expect(keys[0]).toBe(keys[1]);
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

  it('父引用不存在被拒绝', () => {
    const p = validPayload();
    p.treeConfigs[0].nodes[1].parentRef = 'nope';
    expect(validateBackupPayload(p).some((e) => e.message.includes('父节点引用不存在'))).toBe(true);

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

  // ---- v3：引用唯一性闸门（这是恢复能单事务跑完的前提） ----
  describe('引用唯一性', () => {
    it('节点 ref 重复被拒绝', () => {
      const p = validPayload();
      p.treeConfigs[0].nodes[1].ref = 'n1';
      expect(validateBackupPayload(p).some((e) => e.message.includes('节点引用重复'))).toBe(true);
    });

    it('v3 节点缺 ref 被拒绝', () => {
      const p = validPayload();
      delete p.treeConfigs[0].nodes[1].ref;
      expect(validateBackupPayload(p).some((e) => e.message.includes('缺少唯一引用 ref'))).toBe(true);
    });

    it('同一快照内节点重复被拒绝（否则撞 UNIQUE(snapshot_id,node_id)）', () => {
      const p = validPayload();
      p.snapshots[0].assets.push({ ...p.snapshots[0].assets[0] });
      const msgs = validateBackupPayload(p).map((e) => e.message);
      expect(msgs.some((m) => m.includes('同一快照内节点重复'))).toBe(true);
    });

    it('同一快照内收益节点重复被拒绝', () => {
      const p = validPayload();
      p.snapshots[0].moduleGains = [{ nodeRef: 'n2', gain: 1 }, { nodeRef: 'n2', gain: 2 }];
      expect(validateBackupPayload(p).some((e) => e.message.includes('收益节点重复'))).toBe(true);
    });

    it('负债名称重复被拒绝', () => {
      const p = validPayload();
      p.debts.push({ ...p.debts[0] });
      expect(validateBackupPayload(p).some((e) => e.message.includes('负债名称重复'))).toBe(true);
    });

    it('健康阈值键重复被拒绝', () => {
      const p = validPayload();
      p.healthConfig = [{ key: 'a', value: '1' }, { key: 'a', value: '2' }];
      expect(validateBackupPayload(p).some((e) => e.message.includes('健康阈值键重复'))).toBe(true);
    });
  });

  // ---- 旧格式（v1/v2）遇到同名同级节点：必须在校验阶段拒绝，而不是恢复中途炸 UNIQUE ----
  describe('v2 旧格式的重名节点', () => {
    function v2WithDupNodes(): BackupPayload {
      const p = validPayload();
      p.schemaVersion = 2;
      for (const n of p.treeConfigs[0].nodes) {
        delete n.ref;
        delete n.parentRef;
      }
      // 同一父下再加一个同名叶子
      p.treeConfigs[0].nodes.push({
        name: '活期', parentKey: '金融资产', nodeType: 'leaf', targetRateAnnual: null,
        updateFreq: 'monthly', enabled: true, sortOrder: 2, identityInfo: null, isPlaceholder: false,
      });
      for (const a of p.snapshots[0].assets) {
        (a as unknown as { nodeKey: string }).nodeKey = '金融资产>活期';
        delete a.nodeRef;
      }
      return p;
    }

    it('同路径重名 → 拒绝并提示重新导出', () => {
      const msgs = validateBackupPayload(v2WithDupNodes()).map((e) => e.message);
      expect(msgs.some((m) => m.includes('同路径重名') && m.includes('重新导出'))).toBe(true);
    });

    it('无重名时 v2 仍可恢复（向后兼容不丢失）', () => {
      const p = v2WithDupNodes();
      p.treeConfigs[0].nodes.pop(); // 去掉重名节点
      expect(validateBackupPayload(p)).toEqual([]);
    });
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

  // P0-1 回归：扩展表外键引用 tree_nodes，必须先于 tree_nodes 清空
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

  // v3：恢复必须是单批原子提交（不读 last_row_id，改用预分配显式主键）
  it('整次恢复只发 1 个 batch（单事务原子）', async () => {
    let batchCalls = 0;
    const db = mockDb(handler) as unknown as Record<string, unknown> & {
      batch: (list: unknown[]) => Promise<unknown[]>;
    };
    const inner = db.batch;
    db.batch = async (list: unknown[]) => {
      batchCalls++;
      return inner(list);
    };
    await restoreFromPayload(db as never, validPayload());
    expect(batchCalls).toBe(1);
  });

  it('恢复不再依赖 last_row_id（显式主键写入）', async () => {
    const db = mockDb(handler);
    await restoreFromPayload(db, validPayload());
    const sqls = ((db as unknown as { __bound: { sql: string }[] }).__bound ?? []).map((c) => c.sql);
    const insertTree = sqls.find((s) => s.includes('INSERT INTO tree_nodes')) ?? '';
    expect(insertTree).toMatch(/INSERT INTO tree_nodes \(id,/);
    const insertSnap = sqls.find((s) => s.includes('INSERT INTO monthly_snapshots')) ?? '';
    expect(insertSnap).toMatch(/INSERT INTO monthly_snapshots \(id,/);
  });

  // P0-2 回归：节点必须带 assetCategory / liquidity
  it('恢复节点时写入 asset_category 与 liquidity', async () => {
    const db = mockDb(handler);
    const p = validPayload();
    p.treeConfigs[0].nodes[1].assetCategory = 'physical';
    p.treeConfigs[0].nodes[1].liquidity = 'low';
    await restoreFromPayload(db, p);
    const calls = ((db as unknown as { __bound: { sql: string; args: unknown[] }[] }).__bound ?? []).filter(
      (c) => c.sql.includes('INSERT INTO tree_nodes')
    );
    expect(calls.length).toBeGreaterThan(0);
    const insert = calls[calls.length - 1];
    expect(insert.sql).toContain('asset_category');
    expect(insert.sql).toContain('liquidity');
    // 最后两个「业务值」应透传 physical / low（时间戳在其后）
    expect(insert.args).toContain('physical');
    expect(insert.args).toContain('low');
  });

  it('v1 历史备份可恢复，并给出折旧丢失告警', async () => {
    const db = mockDb((sql, args) => {
      if (sql.includes('COUNT(*) AS c FROM asset_depreciation')) return { c: 3 };
      if (sql.includes('COUNT(*) AS c FROM asset_revaluations')) return { c: 2 };
      return handler(sql);
    });
    const v1 = validPayload();
    v1.schemaVersion = 1;
    for (const k of ['depreciations', 'revaluations', 'contingentLiabilities', 'healthConfig'] as const) {
      delete (v1 as Record<string, unknown>)[k];
    }
    for (const n of v1.treeConfigs[0].nodes) {
      delete n.ref;
      delete n.parentRef;
      delete n.assetCategory;
      delete n.liquidity;
    }
    for (const a of v1.snapshots[0].assets) delete a.nodeRef;
    expect(validateBackupPayload(v1)).toEqual([]);
    const res = await restoreFromPayload(db, v1);
    expect(res.schemaVersion).toBe(1);
    expect(res.warnings.some((w) => w.includes('折旧'))).toBe(true);
    // v1 不含这两张表 → 保留原值，不做 DELETE
    expect(ranSql(db, 'DELETE FROM contingent_liabilities')).toBe(false);
    expect(ranSql(db, 'DELETE FROM health_config')).toBe(false);
  });
});
