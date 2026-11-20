/**
 * 运行期数据服务：环境量、测站序列缓存、HST 预测因子、插值权重
 * 序列按需加载并缓存 TypedArray 视图，播放时间轴时零 IndexedDB 等待
 */
import type { AppSettings, MetricKey, Station } from '../types';
import {
  getDb,
  kvGet,
  loadInterp,
  loadSeries,
  saveInterp,
  type SeriesRecord,
} from '../db/idb';
import { buildIdwWeights, evaluateFieldInto, meshTargets, type InterpWeights } from '../core/interpolate';
import { buildDamFace } from '../core/dam/geometry';

interface EnvCache {
  waterLevel: Float32Array;
  airTemp: Float32Array;
  head: Float32Array;
  predictors: Float64Array;
  predictorCount: number;
}

interface SeriesCacheEntry {
  values: Float32Array;
  quality: Uint8Array;
  trueValues: Float32Array | null;
  count: number;
}

export interface FieldWeights {
  /** 下游坝面顶点 × 位移指标 */
  face: Partial<Record<MetricKey, InterpWeights>>;
  /** 横缝测缝计 → 横缝编号权重（缝宽用） */
  joints: Map<number, { stationIndex: number; weight: number }[]>;
}

class DataService {
  settings!: AppSettings;
  stations: Station[] = [];
  private env: EnvCache | null = null;
  private seriesCache = new Map<string, SeriesCacheEntry>();
  fieldWeights: FieldWeights | null = null;
  /** 坝面顶点数（下游面） */
  faceVertexCount = 0;

  async init(settings: AppSettings, stations: Station[]): Promise<void> {
    this.settings = settings;
    this.stations = stations;
    this.seriesCache.clear();
    const raw = await kvGet<{
      waterLevel: ArrayBuffer;
      airTemp: ArrayBuffer;
      head: ArrayBuffer;
      predictors: ArrayBuffer;
      predictorCount: number;
    }>('env');
    if (!raw) throw new Error('环境量数据缺失，请重新生成数据集');
    this.env = {
      waterLevel: new Float32Array(raw.waterLevel),
      airTemp: new Float32Array(airTempFix(raw.airTemp)),
      head: new Float32Array(raw.head),
      predictors: new Float64Array(raw.predictors),
      predictorCount: raw.predictorCount,
    };
  }

  getEnv(): EnvCache {
    if (!this.env) throw new Error('DataService 未初始化');
    return this.env;
  }

  getPredictors() {
    return { values: this.getEnv().predictors, count: this.getEnv().predictorCount };
  }

  async getSeries(stationId: string, metric: string): Promise<SeriesCacheEntry> {
    const key = `${stationId}|${metric}`;
    const hit = this.seriesCache.get(key);
    if (hit) return hit;
    const rec: SeriesRecord | undefined = await loadSeries(key);
    if (!rec) throw new Error(`序列不存在: ${key}`);
    const entry: SeriesCacheEntry = {
      values: new Float32Array(rec.values),
      quality: new Uint8Array(rec.quality),
      trueValues: rec.trueValues ? new Float32Array(rec.trueValues) : null,
      count: rec.count,
    };
    if (this.seriesCache.size > 120) {
      const firstKey = this.seriesCache.keys().next().value;
      if (firstKey) this.seriesCache.delete(firstKey);
    }
    this.seriesCache.set(key, entry);
    return entry;
  }

  /** 同步取缓存序列（播放循环用，未缓存返回 null） */
  peekSeries(stationId: string, metric: string): SeriesCacheEntry | null {
    return this.seriesCache.get(`${stationId}|${metric}`) ?? null;
  }

  /** 预热：把所有位移类序列加载进缓存 */
  async preloadDisplacement(): Promise<void> {
    const db = await getDb();
    const all = await db.getAll('series');
    for (const rec of all as SeriesRecord[]) {
      if (rec.metric === 'head') continue;
      this.seriesCache.set(rec.key, {
        values: new Float32Array(rec.values),
        quality: new Uint8Array(rec.quality),
        trueValues: rec.trueValues ? new Float32Array(rec.trueValues) : null,
        count: rec.count,
      });
    }
  }

  async preloadPiezo(): Promise<void> {
    const db = await getDb();
    const all = await db.getAll('series');
    for (const rec of all as SeriesRecord[]) {
      if (rec.metric !== 'head') continue;
      this.seriesCache.set(rec.key, {
        values: new Float32Array(rec.values),
        quality: new Uint8Array(rec.quality),
        trueValues: rec.trueValues ? new Float32Array(rec.trueValues) : null,
        count: rec.count,
      });
    }
  }

  /** 某指标下全部有该测项的测点下标 */
  eligibleStations(metric: MetricKey): number[] {
    const out: number[] = [];
    this.stations.forEach((s, i) => {
      if (s.metrics.includes(metric)) out.push(i);
    });
    return out;
  }

  /**
   * 预计算坝面插值权重（优先读 IndexedDB 缓存）
   */
  async ensureFieldWeights(): Promise<FieldWeights> {
    if (this.fieldWeights) return this.fieldWeights;
    const face = buildDamFace(1);
    this.faceVertexCount = face.vertexCount;
    const targets = meshTargets(face.positions);
    const weights: FieldWeights = { face: {}, joints: new Map() };

    const metrics: MetricKey[] = ['radial', 'tangential', 'vertical', 'opening', 'head'];
    for (const metric of metrics) {
      const cacheKey = `face-down|${metric}`;
      const cached = await loadInterp(cacheKey);
      if (cached) {
        weights.face[metric] = {
          neighbors: new Int32Array(cached.neighbors),
          weights: new Float32Array(cached.weights),
          k: cached.k,
          targetCount: cached.targetCount,
        };
      } else {
        const eligible = this.eligibleStations(metric);
        const w = buildIdwWeights(targets, this.stations, eligible);
        weights.face[metric] = w;
        await saveInterp({
          key: cacheKey,
          neighbors: w.neighbors.buffer as ArrayBuffer,
          weights: w.weights.buffer as ArrayBuffer,
          k: w.k,
          targetCount: w.targetCount,
        });
      }
    }

    // 横缝：每条缝收集该缝上的测缝计（按高程），渲染时按顶点高程取最近两层
    this.stations.forEach((si, idx) => {
      if (si.type === 'joint' && si.jointId != null) {
        const list = weights.joints.get(si.jointId) ?? [];
        list.push({ stationIndex: idx, weight: 1 });
        weights.joints.set(si.jointId, list);
      }
    });

    this.fieldWeights = weights;
    return weights;
  }

  /** 取某日某指标的测点值数组（长度 = 测点数，无值 NaN） */
  stationValuesAt(metric: MetricKey, index: number, useTrueValues = false): Float32Array {
    const out = new Float32Array(this.stations.length).fill(NaN);
    for (let i = 0; i < this.stations.length; i++) {
      const s = this.stations[i];
      if (!s.metrics.includes(metric)) continue;
      const entry = this.peekSeries(s.id, metric);
      if (!entry) continue;
      const v = useTrueValues && entry.trueValues ? entry.trueValues[index] : entry.values[index];
      out[i] = Number.isFinite(v) ? v : NaN;
    }
    return out;
  }

  /** 插值到坝面顶点场（复用输出缓冲，播放循环零分配） */
  fieldAt(metric: MetricKey, index: number, out: Float32Array, useTrueValues = false): Float32Array {
    const w = this.fieldWeights?.face[metric];
    if (!w) throw new Error('插值权重未初始化');
    const vals = this.stationValuesAt(metric, index, useTrueValues);
    evaluateFieldInto(w, vals, out);
    return out;
  }
}

/** 旧版缓存 airTemp 可能缺失字段的防御处理 */
function airTempFix(buf: ArrayBuffer): ArrayBuffer {
  return buf;
}

export const dataService = new DataService();
