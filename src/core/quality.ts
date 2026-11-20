/**
 * 数据质量自动识别：缺测、单点跳变（中位数稳健检测）、仪器换新基准突变（分段均值检验）
 * 仅打标与生成事件，不自动改值；基准变化经人工确认后由 spliceDatumShift 接边
 */
import type { DataEvent, MetricKey, Quality } from '../types';
import { isMissing } from './synthesis';

const Q_MISSING = 1;
const Q_SPIKE = 2;
const Q_SHIFT = 4;
const Q_ADJUSTED = 8;

function isoAt(startDate: string, index: number): string {
  const start = Date.parse(startDate + 'T00:00:00Z');
  return new Date(start + index * 86400000).toISOString().slice(0, 10);
}

/** 滑动中位数（窗口 2w+1，忽略 NaN） */
function rollingMedian(values: Float32Array, i: number, w: number): number {
  const buf: number[] = [];
  for (let k = i - w; k <= i + w; k++) {
    if (k < 0 || k >= values.length) continue;
    if (Number.isFinite(values[k])) buf.push(values[k]);
  }
  if (buf.length < 5) return NaN;
  buf.sort((a, b) => a - b);
  return buf[Math.floor(buf.length / 2)];
}

function mad(values: Float32Array, medians: Float32Array): number {
  const dev: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i]) && Number.isFinite(medians[i])) dev.push(Math.abs(values[i] - medians[i]));
  }
  dev.sort((a, b) => a - b);
  const medianOfDev = dev[Math.floor(dev.length / 2)] ?? 1;
  return 1.4826 * medianOfDev || 1;
}

export interface QcResult {
  quality: Uint8Array;
  events: DataEvent[];
}

/**
 * 对一条导入序列做完整质检
 * @param values 长度 n，缺测用 NaN
 * @param existing 复用已有质量位（合成数据已注入的异常标记保留）
 */
export function runQualityCheck(
  stationId: string,
  metric: MetricKey,
  values: Float32Array,
  startDate: string,
  existing?: Uint8Array,
): QcResult {
  const n = values.length;
  const quality = existing ? Uint8Array.from(existing) : new Uint8Array(n);
  const events: DataEvent[] = [];

  // 1) 缺测识别
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i <= n; i++) {
    const missing = i < n && !Number.isFinite(values[i]);
    if (missing) {
      if (runStart < 0) runStart = i;
      runLen++;
    } else if (runStart >= 0) {
      quality[runStart] |= Q_MISSING;
      events.push({
        id: `${stationId}-${metric}-miss-${runStart}`,
        stationId,
        metric,
        index: runStart,
        date: isoAt(startDate, runStart),
        kind: 'missing',
        detail: `连续 ${runLen} 天缺测`,
        status: 'pending',
      });
      runStart = -1;
      runLen = 0;
    }
  }

  // 2) 跳变识别：偏离滑动中位数 > 5×MAD（稳健 Z 分数）
  const medians = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) medians[i] = rollingMedian(values, i, 7);
  const sigma = mad(values, medians);
  for (let i = 1; i < n - 1; i++) {
    if (!Number.isFinite(values[i]) || (quality[i] & Q_MISSING)) continue;
    const z = Math.abs(values[i] - medians[i]) / sigma;
    if (z > 5 && Number.isFinite(medians[i])) {
      quality[i] |= Q_SPIKE;
      if (!events.some((e) => e.kind === 'spike' && e.index === i)) {
        events.push({
          id: `${stationId}-${metric}-spike-${i}`,
          stationId,
          metric,
          index: i,
          date: isoAt(startDate, i),
          kind: 'spike',
          detail: `稳健Z分数 ${z.toFixed(1)}，疑似跳变`,
          offset: values[i] - medians[i],
          status: 'pending',
        });
      }
    }
  }

  // 3) 基准突变：对跳变点做前后 30 天均值差检验（>6σ 且持续）
  for (let i = 30; i < n - 30; i++) {
    if (quality[i] & (Q_MISSING | Q_SHIFT)) continue;
    const before = sliceMean(values, i - 30, i);
    const after = sliceMean(values, i + 1, i + 31);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const localSigma = sliceStd(values, i - 30, i);
    const diff = after - before;
    if (localSigma > 0 && Math.abs(diff) > 6 * localSigma && Math.abs(diff) > 1.5) {
      quality[i] |= Q_SHIFT;
      events.push({
        id: `${stationId}-${metric}-shift-${i}`,
        stationId,
        metric,
        index: i,
        date: isoAt(startDate, i),
        kind: 'datum-shift',
        detail: `前后均值差 ${diff.toFixed(2)}，疑似仪器换新基准变化`,
        offset: diff,
        status: 'pending',
      });
      i += 30; // 跳过该段，避免重复报
    }
  }

  return { quality, events };
}

function sliceMean(v: Float32Array, a: number, b: number): number {
  let s = 0;
  let c = 0;
  for (let i = Math.max(0, a); i < Math.min(v.length, b); i++) {
    if (Number.isFinite(v[i])) {
      s += v[i];
      c++;
    }
  }
  return c >= 10 ? s / c : NaN;
}

function sliceStd(v: Float32Array, a: number, b: number): number {
  const mu = sliceMean(v, a, b);
  if (!Number.isFinite(mu)) return NaN;
  let s = 0;
  let c = 0;
  for (let i = Math.max(0, a); i < Math.min(v.length, b); i++) {
    if (Number.isFinite(v[i])) {
      s += (v[i] - mu) ** 2;
      c++;
    }
  }
  return c >= 10 ? Math.sqrt(s / (c - 1)) : NaN;
}

/**
 * 基准变化人工确认后接边：将突变点之后整段平移 -offset，使前后基准统一
 * 返回新数组与更新后的质量位
 */
export function spliceDatumShift(
  values: Float32Array,
  quality: Uint8Array,
  shiftIndex: number,
  offset: number,
): { values: Float32Array; quality: Uint8Array } {
  const out = Float32Array.from(values);
  const q = Uint8Array.from(quality);
  for (let i = shiftIndex; i < out.length; i++) {
    if (Number.isFinite(out[i])) out[i] -= offset;
    q[i] |= Q_ADJUSTED;
  }
  q[shiftIndex] &= ~Q_SHIFT;
  return { values: out, quality: q };
}

/** 缺测线性插补（用于播放/回归前的临时填充，标记 Interpolated） */
export function fillMissing(values: Float32Array, quality: Uint8Array): Float32Array {
  const out = Float32Array.from(values);
  const n = out.length;
  for (let i = 0; i < n; i++) {
    if (isMissing(quality[i]) || !Number.isFinite(out[i])) {
      let lo = i - 1;
      while (lo >= 0 && !Number.isFinite(out[lo])) lo--;
      let hi = i + 1;
      while (hi < n && !Number.isFinite(out[hi])) hi++;
      if (lo >= 0 && hi < n) out[i] = out[lo] + ((out[hi] - out[lo]) * (i - lo)) / (hi - lo);
      else if (lo >= 0) out[i] = out[lo];
      else if (hi < n) out[i] = out[hi];
    }
  }
  return out;
}

export type { Quality };
