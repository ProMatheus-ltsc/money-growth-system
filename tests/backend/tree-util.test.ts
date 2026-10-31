/**
 * 资产树纯函数回归（F-12 / 报表同源）：层级遍历、收益率继承、更新频率默认值。
 */
import { describe, it, expect } from 'vitest';
import {
  FREQ_INTERVAL,
  childrenOf,
  nodesById,
  topLevelModules,
  topAncestor,
  effectiveRate,
  effectiveFreq,
  enabledLeaves,
  descendantLeaves,
  nodeKeyPath,
} from '../../backend/services/treeUtil.ts';
import { treeNodes } from '../helpers/fixtures.ts';

const nodes = treeNodes();

describe('treeUtil', () => {
  it('nodesById / childrenOf 排序稳定', () => {
    expect(nodesById(nodes).get(11)?.name).toBe('活期');
    expect(childrenOf(nodes, 1).map((n) => n.id)).toEqual([11, 12, 13]);
  });

  it('topLevelModules 只含根节点', () => {
    expect(topLevelModules(nodes).map((n) => n.name)).toEqual(['金融资产', '实物资产']);
  });

  it('topAncestor 返回顶层模块；未知节点返回 null', () => {
    expect(topAncestor(nodes, 11)?.id).toBe(1);
    expect(topAncestor(nodes, 21)?.id).toBe(2);
    expect(topAncestor(nodes, 999)).toBeNull();
  });

  it('effectiveRate 自身优先、否则向上继承', () => {
    expect(effectiveRate(nodes, 21)).toBe(0.02);
    expect(effectiveRate(nodes, 11)).toBe(0.06);
    expect(effectiveRate(nodes, 2)).toBeNull();
  });

  it('effectiveFreq 继承，全无为 monthly', () => {
    expect(effectiveFreq(nodes, 12)).toBe('quarterly');
    expect(effectiveFreq(nodes, 13)).toBe('irregular');
    expect(effectiveFreq(nodes, 999)).toBe('monthly');
  });

  it('enabledLeaves 排除停用与父节点', () => {
    expect(enabledLeaves(nodes).map((n) => n.id)).toEqual([11, 12, 21]);
  });

  it('descendantLeaves 递归取末级', () => {
    expect(descendantLeaves(nodes, 1).map((n) => n.id)).toEqual([11, 12, 13]);
    expect(descendantLeaves(nodes, 21).map((n) => n.id)).toEqual([21]);
  });

  it('nodeKeyPath 输出名称路径', () => {
    expect(nodeKeyPath(nodes, 11)).toBe('金融资产>活期');
    expect(nodeKeyPath(nodes, 1)).toBe('金融资产');
  });

  it('FREQ_INTERVAL 覆盖全部频率', () => {
    expect(FREQ_INTERVAL.monthly).toBe(1);
    expect(FREQ_INTERVAL.irregular).toBeNull();
  });
});
