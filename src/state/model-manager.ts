/**
 * HST 模型管理：单点拟合、批量拟合、分量过程线缓存、残差缓存
 * 分量/残差缓存以 Map 驻留内存，供三维场插值与时间轴播放直接取用
 */
import type { HSTCoeffs, HSTResult, MetricKey, Station } from '../types';
import { dataService } from '../state/data-service';
import { fitHST, decomposeComponents, residualSeries } from '../core/hst';
import { loadModel, saveModel, loadAllModels } from '../db/idb';

export interface ComponentCache {
  hydro: Float32Array;
  thermal: Float32Array;
  aging: Float32Array;
  fitted: Float32Array;
  residual: Float32Array;
  coeffs: HSTCoeffs;
}

class ModelManager {
  private cache = new Map<string, ComponentCache>();
  results = new Map<string, HSTResult>();

  async restore(): Promise<void> {
    const all = await loadAllModels();
    for (const r of all) this.results.set(`${r.stationId}|${r.metric}`, r);
  }

  async fitStation(station: Station, metric: MetricKey): Promise<HSTResult> {
    const series = await dataService.getSeries(station.id, metric);
    const predictors = dataService.getPredictors();
    const result = fitHST(
      station.id,
      metric,
      series.values,
      series.quality,
      predictors,
      station.trueCoeffs && metric === station.metrics[0] ? station.trueCoeffs : undefined,
    );
    await saveModel(result);
    this.results.set(`${station.id}|${metric}`, result);
    this.cache.delete(`${station.id}|${metric}`);
    return result;
  }

  /** 批量拟合所有测点（位移/缝/渗压），分批让出主线程 */
  async fitAll(onProgress?: (done: number, total: number) => void): Promise<HSTResult[]> {
    const tasks: { station: Station; metric: MetricKey }[] = [];
    for (const s of dataService.stations) for (const m of s.metrics) tasks.push({ station: s, metric: m });
    const out: HSTResult[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const { station, metric } = tasks[i];
      try {
        const r = await this.fitStation(station, metric);
        out.push(r);
      } catch (err) {
        console.warn(`回归失败 ${station.id}/${metric}`, err);
      }
      onProgress?.(i + 1, tasks.length);
      if (i % 12 === 11) await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }

  getResult(stationId: string, metric: MetricKey): HSTResult | undefined {
    return this.results.get(`${stationId}|${metric}`);
  }

  /** 取分量缓存（未拟合返回 null） */
  getComponents(stationId: string, metric: MetricKey): ComponentCache | null {
    const key = `${stationId}|${metric}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const result = this.results.get(key);
    if (!result) return null;
    const predictors = dataService.getPredictors();
    const comp = decomposeComponents(result.coeffs, predictors);
    const series = dataService.peekSeries(stationId, metric);
    const residual = series
      ? residualSeries(series.values, series.quality, predictors, result.coeffs)
      : new Float32Array(predictors.count);
    const entry: ComponentCache = { ...comp, residual, coeffs: result.coeffs };
    this.cache.set(key, entry);
    return entry;
  }

  /** 播放时按显示模式取该指标每个测点在某日的值 */
  valuesAt(metric: MetricKey, index: number, mode: string): Float32Array {
    const out = new Float32Array(dataService.stations.length).fill(NaN);
    return this.valuesAtInto(metric, index, mode, out);
  }

  /** 写入复用缓冲，播放循环零分配 */
  valuesAtInto(metric: MetricKey, index: number, mode: string, out: Float32Array): Float32Array {
    const stations = dataService.stations;
    out.fill(NaN);
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      if (!s.metrics.includes(metric)) continue;
      if (mode === 'total') {
        const se = dataService.peekSeries(s.id, metric);
        if (se) out[i] = se.values[index];
      } else {
        const comp = this.getComponents(s.id, metric);
        if (!comp) continue;
        if (mode === 'hydro') out[i] = comp.hydro[index];
        else if (mode === 'thermal') out[i] = comp.thermal[index];
        else if (mode === 'aging') out[i] = comp.aging[index];
        else if (mode === 'residual') out[i] = comp.residual[index];
      }
    }
    return out;
  }
}

export const modelManager = new ModelManager();
