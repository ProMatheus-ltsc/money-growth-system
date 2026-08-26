/**
 * Cloudflare D1 远程备份服务
 * 实现 IndexedDB 本地数据与 D1 远程数据库的同步
 * 采用 Local-First 策略：本地为主，D1为备份
 */
import type { FormRecord, SyncStatus, SyncResult, ExportedData } from '../types';
import { exportAllData, importAllData, getRecordsModifiedSince, getAllRecords } from './db';
import { getSetting, setSetting } from './db';

export interface SyncConfig {
  apiEndpoint: string;
  accountId: string;
  authToken?: string;
}

let syncConfig: SyncConfig | null = null;

/**
 * 配置D1同步服务
 */
export function configureSyncService(config: SyncConfig): void {
  syncConfig = config;
}

/**
 * 获取同步配置
 */
export function getSyncConfig(): SyncConfig | null {
  return syncConfig;
}

/**
 * 检查网络连通性
 */
async function checkConnectivity(): Promise<boolean> {
  if (!syncConfig) return false;
  try {
    const response = await fetch(`${syncConfig.apiEndpoint}/api/sync/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 获取同步状态
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  const lastSyncAt = await getSetting<string | null>('lastSyncAt', null);
  const changedRecords = await getRecordsModifiedSince(lastSyncAt);
  const isOnline = await checkConnectivity();

  return {
    lastSyncAt,
    pendingChanges: changedRecords.length,
    isOnline,
  };
}

/**
 * 推送本地变更到D1
 */
export async function pushChanges(): Promise<SyncResult> {
  if (!syncConfig) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: '未配置同步服务',
    };
  }

  try {
    const lastSyncAt = await getSetting<string | null>('lastSyncAt', null);
    const changedRecords = await getRecordsModifiedSince(lastSyncAt);

    if (changedRecords.length === 0) {
      return {
        success: true,
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        timestamp: new Date().toISOString(),
      };
    }

    const response = await fetch(`${syncConfig.apiEndpoint}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(syncConfig.authToken ? { Authorization: `Bearer ${syncConfig.authToken}` } : {}),
      },
      body: JSON.stringify({
        accountId: syncConfig.accountId,
        records: changedRecords,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`推送失败: ${response.statusText}`);
    }

    const result = await response.json();
    const now = new Date().toISOString();
    await setSetting('lastSyncAt', now);

    return {
      success: true,
      pushed: changedRecords.length,
      pulled: 0,
      conflicts: result.conflicts ?? 0,
      timestamp: now,
    };
  } catch (error) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : '未知错误',
    };
  }
}

/**
 * 从D1拉取变更到本地
 */
export async function pullChanges(): Promise<SyncResult> {
  if (!syncConfig) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: '未配置同步服务',
    };
  }

  try {
    const lastSyncAt = await getSetting<string | null>('lastSyncAt', null);

    const response = await fetch(
      `${syncConfig.apiEndpoint}/api/sync/pull?accountId=${syncConfig.accountId}&since=${lastSyncAt ?? ''}`,
      {
        headers: {
          ...(syncConfig.authToken ? { Authorization: `Bearer ${syncConfig.authToken}` } : {}),
        },
      }
    );

    if (!response.ok) {
      throw new Error(`拉取失败: ${response.statusText}`);
    }

    const remoteData: { records: FormRecord[] } = await response.json();

    // Last-Write-Wins 合并策略
    const localRecords = await getAllRecords();
    const localMap = new Map(localRecords.map((r) => [r.id, r]));
    let conflicts = 0;
    const toMerge: FormRecord[] = [];

    for (const remote of remoteData.records) {
      const local = localMap.get(remote.id);
      if (!local) {
        toMerge.push(remote);
      } else if (remote.updatedAt > local.updatedAt) {
        toMerge.push(remote);
        conflicts++;
      }
    }

    if (toMerge.length > 0) {
      const { importAllData: importFn } = await import('./db');
      const currentData = await exportAllData();
      const mergedRecords = [...currentData.records.filter((r) => !toMerge.find((m) => m.id === r.id)), ...toMerge];
      await importFn({ ...currentData, records: mergedRecords });
    }

    const now = new Date().toISOString();
    await setSetting('lastSyncAt', now);

    return {
      success: true,
      pushed: 0,
      pulled: toMerge.length,
      conflicts,
      timestamp: now,
    };
  } catch (error) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : '未知错误',
    };
  }
}

/**
 * 全量备份到D1
 */
export async function fullBackupToD1(): Promise<SyncResult> {
  if (!syncConfig) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: '未配置同步服务',
    };
  }

  try {
    const allData = await exportAllData();

    const response = await fetch(`${syncConfig.apiEndpoint}/api/sync/backup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(syncConfig.authToken ? { Authorization: `Bearer ${syncConfig.authToken}` } : {}),
      },
      body: JSON.stringify({
        accountId: syncConfig.accountId,
        data: allData,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`备份失败: ${response.statusText}`);
    }

    const now = new Date().toISOString();
    await setSetting('lastSyncAt', now);
    await setSetting('lastFullBackupAt', now);

    return {
      success: true,
      pushed: allData.records.length,
      pulled: 0,
      conflicts: 0,
      timestamp: now,
    };
  } catch (error) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : '未知错误',
    };
  }
}

/**
 * 从D1恢复备份
 */
export async function restoreFromD1(timestamp?: string): Promise<SyncResult> {
  if (!syncConfig) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: '未配置同步服务',
    };
  }

  try {
    const url = timestamp
      ? `${syncConfig.apiEndpoint}/api/sync/restore?accountId=${syncConfig.accountId}&timestamp=${timestamp}`
      : `${syncConfig.apiEndpoint}/api/sync/restore?accountId=${syncConfig.accountId}`;

    const response = await fetch(url, {
      headers: {
        ...(syncConfig.authToken ? { Authorization: `Bearer ${syncConfig.authToken}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`恢复失败: ${response.statusText}`);
    }

    const backupData: ExportedData = await response.json();
    await importAllData(backupData);

    return {
      success: true,
      pushed: 0,
      pulled: backupData.records.length,
      conflicts: 0,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      success: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : '未知错误',
    };
  }
}
