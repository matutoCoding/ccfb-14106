/**
 * IndexedDB 存储层
 * 库: dam-monitor-db
 * 时序按 (stationId|metric) 一条记录，values/quality/trueValues 以二进制块存放，
 * 十几年×几百测点的日数据仅占数十 MB
 */
import { openDB, type IDBPDatabase } from 'idb';
import type {
  AlertRecord,
  AlertRule,
  AppSettings,
  DataEvent,
  HSTResult,
  Station,
} from '../types';

const DB_NAME = 'dam-monitor-db';
const DB_VERSION = 1;

export interface SeriesRecord {
  key: string; // `${stationId}|${metric}`
  stationId: string;
  metric: string;
  startDate: string;
  count: number;
  values: ArrayBuffer; // Float32
  quality: ArrayBuffer; // Uint8
  trueValues?: ArrayBuffer; // Float32，核验用真值
  trueCoeffsJson?: string;
}

export interface InterpRecord {
  key: string; // 例如 `face-down|radial`
  neighbors: ArrayBuffer; // Int32
  weights: ArrayBuffer; // Float32
  k: number;
  targetCount: number;
}

interface DamSchema {
  settings: AppSettings;
  stations: Station;
  series: SeriesRecord;
  events: DataEvent;
  models: HSTResult;
  rules: AlertRule;
  alerts: AlertRecord;
  kv: { key: string; value: unknown };
  interp: InterpRecord;
}

let dbPromise: Promise<IDBPDatabase<any>> | null = null;

export function getDb(): Promise<IDBPDatabase<any>> {
  if (!dbPromise) {
    dbPromise = openDB<DamSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('settings');
        const st = db.createObjectStore('stations', { keyPath: 'id' });
        st.createIndex('type', 'type');
        db.createObjectStore('series', { keyPath: 'key' });
        db.createObjectStore('events', { keyPath: 'id' });
        db.createObjectStore('models', { keyPath: 'id' });
        db.createObjectStore('rules', { keyPath: 'id' });
        db.createObjectStore('alerts', { keyPath: 'id' });
        db.createObjectStore('interp', { keyPath: 'key' });
        db.createObjectStore('kv', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

export function seriesKey(stationId: string, metric: string): string {
  return `${stationId}|${metric}`;
}

// ---------- 设置 ----------
export async function saveSettings(s: AppSettings): Promise<void> {
  const db = await getDb();
  await db.put('settings', s, 'app');
}
export async function loadSettings(): Promise<AppSettings | undefined> {
  const db = await getDb();
  return db.get('settings', 'app');
}

// ---------- 测点 ----------
export async function saveStations(stations: Station[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('stations', 'readwrite');
  await tx.store.clear();
  for (const s of stations) await tx.store.put(s);
  await tx.done;
}
export async function loadStations(): Promise<Station[]> {
  const db = await getDb();
  return db.getAll('stations');
}

// ---------- 时序 ----------
export async function saveSeries(rec: SeriesRecord): Promise<void> {
  const db = await getDb();
  await db.put('series', rec);
}
export async function saveSeriesBatch(recs: SeriesRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('series', 'readwrite');
  for (const r of recs) await tx.store.put(r);
  await tx.done;
}
export async function loadSeries(key: string): Promise<SeriesRecord | undefined> {
  const db = await getDb();
  return db.get('series', key);
}
export async function allSeriesKeys(): Promise<string[]> {
  const db = await getDb();
  return db.getAllKeys('series') as Promise<string[]>;
}
export async function clearSeries(): Promise<void> {
  const db = await getDb();
  await db.clear('series');
}

// ---------- 事件 ----------
export async function saveEvents(events: DataEvent[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('events', 'readwrite');
  for (const e of events) await tx.store.put(e);
  await tx.done;
}
export async function loadEvents(): Promise<DataEvent[]> {
  const db = await getDb();
  return db.getAll('events');
}
export async function updateEvent(e: DataEvent): Promise<void> {
  const db = await getDb();
  await db.put('events', e);
}

// ---------- 模型 ----------
function modelKey(stationId: string, metric: string): string {
  return `${stationId}|${metric}`;
}
export async function saveModel(r: HSTResult): Promise<void> {
  const db = await getDb();
  await db.put('models', { ...r, id: modelKey(r.stationId, r.metric) });
}
export async function loadModel(stationId: string, metric: string): Promise<(HSTResult & { id?: string }) | undefined> {
  const db = await getDb();
  return db.get('models', modelKey(stationId, metric));
}
export async function loadAllModels(): Promise<HSTResult[]> {
  const db = await getDb();
  const all = await db.getAll('models');
  return all.map(({ id, ...rest }) => rest as HSTResult);
}
export async function clearModels(): Promise<void> {
  const db = await getDb();
  await db.clear('models');
}

// ---------- 预警规则与记录 ----------
export async function saveRules(rules: AlertRule[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('rules', 'readwrite');
  await tx.store.clear();
  for (const r of rules) await tx.store.put(r);
  await tx.done;
}
export async function loadRules(): Promise<AlertRule[]> {
  const db = await getDb();
  return db.getAll('rules');
}
export async function saveAlerts(alerts: AlertRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('alerts', 'readwrite');
  for (const a of alerts) await tx.store.put(a);
  await tx.done;
}
export async function loadAlerts(): Promise<AlertRecord[]> {
  const db = await getDb();
  return db.getAll('alerts');
}
export async function updateAlertRecord(record: AlertRecord): Promise<void> {
  const db = await getDb();
  await db.put('alerts', record);
}
export async function clearAlerts(): Promise<void> {
  const db = await getDb();
  await db.clear('alerts');
}

// ---------- 插值权重 ----------
export async function saveInterp(rec: InterpRecord): Promise<void> {
  const db = await getDb();
  await db.put('interp', rec);
}
export async function loadInterp(key: string): Promise<InterpRecord | undefined> {
  const db = await getDb();
  return db.get('interp', key);
}

// ---------- 通用 KV ----------
export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('kv', { key, value });
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  const rec = await db.get('kv', key);
  return rec?.value as T | undefined;
}

// ---------- 整库重置 ----------
export async function resetDatabase(): Promise<void> {
  const db = await getDb();
  const names = [...db.objectStoreNames] as string[];
  for (const name of names) {
    if (name === 'settings') continue;
    await db.clear(name as never);
  }
}

export async function isInitialized(): Promise<boolean> {
  const db = await getDb();
  const count = await db.count('stations');
  return count > 0;
}
