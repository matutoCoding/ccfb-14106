/**
 * 监测数据合成
 * 位移 = HST 真值模型（水压 h..h⁴ + 温度谐波 + 时效 θ/ln(1+θ)）+ AR(1) 观测噪声
 * 同步注入：随机缺测、单点跳变、仪器换新基准突变
 * 真值系数保存在 station.trueCoeffs，供回归核验（目标误差 <5%）
 */
import type { DataEvent, HSTCoeffs, Quality, Station } from '../types';
import { Rng, hashSeed } from './random';
import type { EnvironmentSeries, HSTPredictors } from './environment';
import { IMPOUND_DAYS } from './environment';
import { elevT } from './dam/params';

export interface GeneratedSeries {
  stationId: string;
  metric: string;
  values: Float32Array;
  quality: Uint8Array;
  trueValues: Float32Array; // 无噪真值（核验用）
  trueCoeffs: HSTCoeffs;
  events: DataEvent[];
}

/** 按测点高程/位置构造有物理规律的真值系数（量级随坝高放大） */
export function makeTrueCoeffs(station: Station, metric: string): HSTCoeffs {
  const t = elevT(station.elevation);
  const seed = hashSeed(station.id + metric);
  const rng = new Rng(seed);
  const heightFactor = 0.35 + 0.9 * t; // 高处水压响应更大

  if (metric === 'head') {
    // 渗压计也跑 HST（水头受库水位主导），单位 m；温度项保持可辨识量级
    return {
      c0: rng.uniform(2, 6),
      h1: rng.uniform(22, 34) * heightFactor,
      h2: rng.uniform(-7, -3),
      h3: rng.uniform(-3.5, -1.8),
      h4: rng.uniform(1.2, 2.6),
      t1: rng.uniform(1.0, 1.6),
      t2: rng.uniform(-2.2, -1.4),
      t3: rng.uniform(0.8, 1.3),
      t4: rng.uniform(-1.1, -0.7),
      a1: rng.uniform(0.5, 1.4),
      a2: rng.uniform(0.6, 1.8),
    };
  }

  if (metric === 'opening') {
    // 横缝：温度主导（冬张夏合 → cos 项为负），时效缓慢闭合
    return {
      c0: rng.uniform(1.2, 2.4),
      h1: rng.uniform(1.2, 2.2) * heightFactor,
      h2: rng.uniform(-1.1, -0.7),
      h3: rng.uniform(0.7, 1.1),
      h4: rng.uniform(-0.8, -0.4),
      t1: rng.uniform(1.4, 2.0),
      t2: rng.uniform(-3.8, -2.8),
      t3: rng.uniform(1.1, 1.6),
      t4: rng.uniform(-1.5, -1.0),
      a1: rng.uniform(-0.55, -0.25),
      a2: rng.uniform(-0.45, -0.2),
    };
  }

  if (metric === 'tangential') {
    // 切向：岸坡方向带符号，各项保持可辨识量级
    const bank = station.position.x >= 0 ? 1 : -1;
    return {
      c0: rng.uniform(-0.6, 0.6),
      h1: bank * rng.uniform(3.2, 5.0) * heightFactor,
      h2: bank * rng.uniform(1.6, 2.4),
      h3: bank * rng.uniform(0.9, 1.4),
      h4: bank * rng.uniform(0.7, 1.1),
      t1: bank * rng.uniform(1.6, 2.4),
      t2: bank * rng.uniform(2.2, 3.2),
      t3: bank * rng.uniform(1.0, 1.5),
      t4: bank * rng.uniform(1.0, 1.5),
      a1: bank * rng.uniform(0.5, 1.1),
      a2: bank * rng.uniform(0.45, 0.95),
    };
  }

  if (metric === 'vertical') {
    return {
      c0: rng.uniform(-0.5, 0.5),
      h1: rng.uniform(2.8, 4.6) * heightFactor,
      h2: rng.uniform(1.3, 2.1),
      h3: rng.uniform(0.8, 1.3),
      h4: rng.uniform(0.6, 1.0),
      t1: rng.uniform(1.4, 2.0),
      t2: rng.uniform(-2.6, -1.8),
      t3: rng.uniform(0.9, 1.4),
      t4: rng.uniform(-1.2, -0.8),
      a1: rng.uniform(-1.1, -0.5),
      a2: rng.uniform(-0.8, -0.3),
    };
  }

  // 径向位移（核心量）：水压推向下游（正），高温坝顶向上游（负），时效向下游收敛
  // 各次项均保持可辨识量级，避免与噪声同量级
  return {
    c0: rng.uniform(-1.2, 1.2),
    h1: rng.uniform(14, 22) * heightFactor,
    h2: rng.uniform(-8.5, -5.5),
    h3: rng.uniform(-4.5, -2.5),
    h4: rng.uniform(1.5, 3.5),
    t1: rng.uniform(-2.2, -1.2),
    t2: rng.uniform(-4.2, -2.6),
    t3: rng.uniform(-1.4, -0.8),
    t4: rng.uniform(-1.6, -0.9),
    a1: rng.uniform(2.2, 4.2),
    a2: rng.uniform(1.0, 2.6),
  };
}

export function evaluateHST(coeffs: HSTCoeffs, predictors: HSTPredictors, index: number): number {
  const x = predictors.values;
  const p = 11;
  const row = index * p;
  return (
    coeffs.c0 * x[row] +
    coeffs.h1 * x[row + 1] +
    coeffs.h2 * x[row + 2] +
    coeffs.h3 * x[row + 3] +
    coeffs.h4 * x[row + 4] +
    coeffs.t1 * x[row + 5] +
    coeffs.t2 * x[row + 6] +
    coeffs.t3 * x[row + 7] +
    coeffs.t4 * x[row + 8] +
    coeffs.a1 * x[row + 9] +
    coeffs.a2 * x[row + 10]
  );
}

function isoAt(startDate: string, index: number): string {
  const start = Date.parse(startDate + 'T00:00:00Z');
  return new Date(start + index * 86400000).toISOString().slice(0, 10);
}

/** 单测点单测值序列合成（含异常注入） */
export function generateSeries(
  station: Station,
  metric: string,
  env: EnvironmentSeries,
  predictors: HSTPredictors,
  startDate: string,
): GeneratedSeries {
  const n = env.waterLevel.length;
  const rng = new Rng(hashSeed(station.id + '|' + metric + '|v1'));
  const coeffs = makeTrueCoeffs(station, metric);
  const values = new Float32Array(n);
  const trueValues = new Float32Array(n);
  const quality = new Uint8Array(n);
  const events: DataEvent[] = [];

  const noiseSigma = metric === 'head' ? 0.1 : metric === 'opening' ? 0.09 : metric === 'tangential' || metric === 'vertical' ? 0.12 : 0.22;
  let ar = 0;
  for (let i = 0; i < n; i++) {
    const truth = evaluateHST(coeffs, predictors, i);
    trueValues[i] = truth;
    // 弱自相关观测噪声（0.25），接近自动化监测仪器的实测特性且不致回归有偏
    ar = 0.25 * ar + rng.normal(0, noiseSigma);
    values[i] = truth + ar;
  }

  // 渗压计在蓄水前库水位接近死水位，水头由 HST 关系自然给出（不做人工压低，保持模型一致性）

  // 异常 1：随机缺测（1.5%~3%，含少量连续缺测段）
  const missingRate = 0.015 + rng.next() * 0.015;
  for (let i = 10; i < n; i++) {
    if (rng.chance(missingRate)) {
      const run = rng.chance(0.18) ? 2 + Math.floor(rng.next() * 4) : 1;
      for (let k = 0; k < run && i + k < n; k++) {
        quality[i + k] |= 1; // Quality.Missing
        values[i + k] = NaN;
      }
      events.push({
        id: `${station.id}-${metric}-miss-${i}`,
        stationId: station.id,
        metric: metric as never,
        index: i,
        date: isoAt(startDate, i),
        kind: 'missing',
        detail: `连续 ${run} 天缺测`,
        status: 'pending',
      });
      i += run;
    }
  }

  // 异常 2：单点/双点跳变（每序列 2~4 次），幅度显著大于噪声以保证质检可识别
  const spikeCount = 2 + Math.floor(rng.next() * 3);
  for (let s = 0; s < spikeCount; s++) {
    const idx = IMPOUND_DAYS + Math.floor(rng.next() * (n - IMPOUND_DAYS - 30));
    if (quality[idx] & 1) continue;
    const amp = (metric === 'head' ? 5 : 9) * (1 + rng.next() * 0.6);
    values[idx] += rng.chance(0.5) ? amp : -amp;
    quality[idx] |= 2; // Quality.Spike
    events.push({
      id: `${station.id}-${metric}-spike-${idx}`,
      stationId: station.id,
      metric: metric as never,
      index: idx,
      date: isoAt(startDate, idx),
      kind: 'spike',
      detail: `单点跳变，幅度约 ${amp.toFixed(1)} ${metric === 'head' ? 'm' : 'mm'}`,
      offset: amp,
      status: 'pending',
    });
  }

  // 异常 3：仪器换新基准突变（约 4% 序列，发生在序列前中段，换新后仍有 8 年以上数据可回归）
  if (station.installIndex > 0 && rng.chance(0.35)) {
    const idx = Math.min(n - 5, station.installIndex + Math.floor(rng.next() * 20));
    const shift = (metric === 'head' ? rng.uniform(0.8, 2.5) : rng.uniform(2.5, 7.5)) * (rng.chance(0.5) ? 1 : -1);
    for (let i = idx; i < n; i++) {
      if (!(quality[i] & 1)) values[i] += shift;
    }
    quality[idx] |= 4; // Quality.DatumShift
    events.push({
      id: `${station.id}-${metric}-shift-${idx}`,
      stationId: station.id,
      metric: metric as never,
      index: idx,
      date: isoAt(startDate, idx),
      kind: 'datum-shift',
      detail: `仪器换新，基准突变，估计偏移 ${shift.toFixed(2)} ${metric === 'head' ? 'm' : 'mm'}`,
      offset: shift,
      status: 'pending',
    });
  }

  return { stationId: station.id, metric, values, quality, trueValues, trueCoeffs: coeffs, events };
}

/** 质量位判定工具 */
export function isMissing(q: number): boolean {
  return (q & 1) !== 0;
}
export function isSpike(q: number): boolean {
  return (q & 2) !== 0;
}
export function isDatumShift(q: number): boolean {
  return (q & 4) !== 0;
}
export function isAdjusted(q: number): boolean {
  return (q & 8) !== 0;
}
export type { Quality };
