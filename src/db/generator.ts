/**
 * 数据集初始化：按工程参数生成测点、环境量与全部日测序列，写入 IndexedDB
 * 可在 Worker 中运行（不依赖 DOM），通过 onProgress 回报进度
 */
import type { AppSettings, Station } from '../types';
import { buildStations } from '../core/dam/stations';
import { generateEnvironment, buildPredictors } from '../core/environment';
import { generateSeries, makeTrueCoeffs } from '../core/synthesis';
import {
  saveSettings,
  saveStations,
  saveSeriesBatch,
  saveEvents,
  type SeriesRecord,
  resetDatabase,
  kvSet,
} from './idb';
import { hashSeed } from '../core/random';

export const DEFAULT_SETTINGS: AppSettings = {
  damName: '示例双曲拱坝',
  startDate: '2010-01-01',
  days: 15 * 365 + 3, // 2010-01-01 ~ 2024-12-31
  crestElev: 1830,
  baseElev: 1580,
  normalPoolLevel: 1820,
  deadPoolLevel: 1640,
};

export interface GenProgress {
  phase: string;
  done: number;
  total: number;
}

export async function generateAndStore(
  settings: AppSettings,
  onProgress?: (p: GenProgress) => void,
): Promise<{ stationCount: number; seriesCount: number }> {
  await resetDatabase();
  await saveSettings(settings);

  onProgress?.({ phase: '布置工程测点', done: 0, total: 1 });
  const stations = buildStations(settings.days);
  await saveStations(stations);

  onProgress?.({ phase: '生成库水位与气温过程', done: 0, total: 1 });
  const env = generateEnvironment(settings, hashSeed('env-drivers-v1'));
  const predictors = buildPredictors(env, settings);
  await kvSet('env', {
    waterLevel: env.waterLevel.buffer,
    airTemp: env.airTemp.buffer,
    head: env.head.buffer,
    predictors: predictors.values.buffer,
    predictorCount: predictors.count,
  });

  // 真值系数回写到测点记录
  for (const s of stations) {
    s.trueCoeffs = makeTrueCoeffs(s, s.metrics[0]);
  }
  await saveStations(stations);

  const total = stations.reduce((acc, s) => acc + s.metrics.length, 0);
  const records: SeriesRecord[] = [];
  const allEvents = [];
  let done = 0;
  const BATCH = 24;

  for (const station of stations) {
    for (const metric of station.metrics) {
      const gen = generateSeries(station, metric, env, predictors, settings.startDate);
      records.push({
        key: `${station.id}|${metric}`,
        stationId: station.id,
        metric,
        startDate: settings.startDate,
        count: settings.days,
        values: gen.values.buffer as ArrayBuffer,
        quality: gen.quality.buffer as ArrayBuffer,
        trueValues: gen.trueValues.buffer as ArrayBuffer,
        trueCoeffsJson: JSON.stringify(gen.trueCoeffs),
      });
      allEvents.push(...gen.events);
      done++;
      if (records.length >= BATCH) {
        await saveSeriesBatch(records.splice(0, records.length));
        onProgress?.({ phase: '生成监测序列', done, total });
      }
    }
  }
  if (records.length) await saveSeriesBatch(records);
  // 事件量大，分批存
  for (let i = 0; i < allEvents.length; i += 200) {
    await saveEvents(allEvents.slice(i, i + 200));
  }

  await kvSet('generatedAt', new Date().toISOString());
  return { stationCount: stations.length, seriesCount: total };
}

export function listStationMetrics(stations: Station[]): { station: Station; metric: string }[] {
  const out: { station: Station; metric: string }[] = [];
  for (const s of stations) for (const m of s.metrics) out.push({ station: s, metric: m });
  return out;
}
