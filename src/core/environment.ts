/**
 * 环境驱动量生成：库水位（蓄水→正常运行年调节）与气温（年/半年周期）
 * 同时提供 HST 模型的全部自变量
 */
import type { AppSettings } from '../types';
import { Rng } from './random';
import { dayOfYear, fractionalYear } from './dates';

export interface EnvironmentSeries {
  waterLevel: Float32Array; // 库水位 m
  airTemp: Float32Array; // 气温 ℃
  head: Float32Array; // 水头 H = 水位 - 坝基高程 m
}

export interface HSTPredictors {
  /** 11 个自变量: [1, H, H², H³, H⁴, sin年, cos年, sin半年, cos半年, θ, ln(1+θ)] */
  values: Float64Array; // 行主序 days × 11
  count: number;
}

/** 一期蓄水天数 */
export const IMPOUND_DAYS = 730;

export function generateEnvironment(settings: AppSettings, seed: number): EnvironmentSeries {
  const rng = new Rng(seed);
  const n = settings.days;
  const waterLevel = new Float32Array(n);
  const airTemp = new Float32Array(n);
  const head = new Float32Array(n);
  const range = settings.normalPoolLevel - settings.deadPoolLevel;

  for (let i = 0; i < n; i++) {
    // 库水位：前两年蓄水（带阶梯停顿），之后年调节（汛末蓄满、汛初消落）
    let level: number;
    if (i < IMPOUND_DAYS) {
      const p = i / IMPOUND_DAYS;
      const staged = 0.75 * p + 0.25 * Math.sin(p * Math.PI * 3) * 0.15;
      level = settings.deadPoolLevel + range * Math.min(1, Math.max(0, staged));
    } else {
      const phase = ((i - IMPOUND_DAYS) % 365) / 365;
      // 10 月蓄满(phase≈0.83)，6 月消落最低(phase≈0.5)
      const seasonal = 0.5 - 0.5 * Math.cos((phase - 0.5) * 2 * Math.PI);
      level = settings.normalPoolLevel - range * seasonal * 0.92;
    }
    waterLevel[i] = level + rng.normal(0, 0.35);

    // 气温：年均 18℃，年变幅 ±12℃，半年谐波 + 噪声
    const doy = dayOfYear(isoAt(settings, i));
    const ang = (2 * Math.PI * (doy - 1)) / 365.25;
    airTemp[i] = 18 - 12 * Math.cos(ang) - 1.8 * Math.cos(2 * ang) + rng.normal(0, 1.6);

    head[i] = Math.max(0, waterLevel[i] - settings.baseElev);
  }
  return { waterLevel, airTemp, head };
}

function isoAt(settings: AppSettings, index: number): string {
  const start = Date.parse(settings.startDate + 'T00:00:00Z');
  return new Date(start + index * 86400000).toISOString().slice(0, 10);
}

/** 构造 HST 设计矩阵
 * 水压项 h..h⁴ 与时效项 θ、ln(1+θ) 内部强共线，
 * 采用 Gram-Schmidt 正交基 + 单位标准差缩放，保证各列可独立辨识、回归系数稳定
 * 列序: [1, 水压正交基×4, 温度谐波×4, 时效正交基×2]
 */
export function buildPredictors(env: EnvironmentSeries, settings: AppSettings): HSTPredictors {
  const n = settings.days;
  const p = 11;
  const raw = new Float64Array(n * p);
  const hMax = settings.normalPoolLevel - settings.baseElev;
  // 有效水头：7 日滑动平均，滤去日水位观测噪声（工程 HST 建模惯例）
  const smoothHead = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
      s += env.head[k];
      c++;
    }
    smoothHead[i] = s / c;
  }
  for (let i = 0; i < n; i++) {
    const h = smoothHead[i] / hMax; // 归一化有效水头 0..1
    const iso = isoAt(settings, i);
    const doy = dayOfYear(iso);
    const ang = (2 * Math.PI * (doy - 1)) / 365.25;
    const theta = fractionalYear(settings.startDate, i);
    const row = i * p;
    raw[row] = 1;
    raw[row + 1] = h;
    raw[row + 2] = h * h;
    raw[row + 3] = h * h * h;
    raw[row + 4] = h * h * h * h;
    raw[row + 5] = Math.sin(ang);
    raw[row + 6] = Math.cos(ang);
    raw[row + 7] = Math.sin(2 * ang);
    raw[row + 8] = Math.cos(2 * ang);
    raw[row + 9] = theta;
    raw[row + 10] = Math.log(1 + theta);
  }
  const x = orthogonalizeGroups(raw, n, [
    [1, 2, 3, 4], // 水压组
    [9, 10], // 时效组
  ]);
  return { values: x, count: n };
}

/**
 * 对指定列组做组内 Gram-Schmidt 正交化并按样本标准差归一化为单位尺度
 */
function orthogonalizeGroups(x: Float64Array, n: number, groups: number[][]): Float64Array {
  const out = Float64Array.from(x);
  for (const group of groups) {
    const basis: number[][] = [];
    for (const col of group) {
      let v = new Float64Array(n);
      for (let i = 0; i < n; i++) v[i] = out[i * 11 + col];
      // 减去在已有基上的投影
      for (const b of basis) {
        let dot = 0;
        let bNorm = 0;
        for (let i = 0; i < n; i++) {
          dot += v[i] * b[i];
          bNorm += b[i] * b[i];
        }
        const k = dot / bNorm;
        for (let i = 0; i < n; i++) v[i] -= k * b[i];
      }
      // 单位标准差缩放
      const mu = v.reduce((a, c) => a + c, 0) / n;
      let sd = 0;
      for (let i = 0; i < n; i++) sd += (v[i] - mu) ** 2;
      sd = Math.sqrt(sd / (n - 1)) || 1;
      for (let i = 0; i < n; i++) v[i] = v[i] / sd;
      basis.push(Array.from(v));
      for (let i = 0; i < n; i++) out[i * 11 + col] = v[i];
    }
  }
  return out;
}
