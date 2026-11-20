/**
 * 空间场插值：测点测值 → 坝面顶点（k 近邻反距离加权 IDW）
 * 权重在数据生成后只计算一次并缓存，播放时间轴时每天仅做稀疏向量运算
 */
import type { MetricKey, Station, Vec3 } from '../types';

export interface InterpWeights {
  /** 每个目标点 k 个近邻的测点序号 */
  neighbors: Int32Array;
  /** 对应权重（未归一化也行，这里存归一化后的） */
  weights: Float32Array;
  k: number;
  targetCount: number;
}

const K_NEIGHBORS = 8;

function dist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * 预计算目标点对测点的 IDW 权重
 * @param eligible 参与插值的测点下标与取数顺序
 */
export function buildIdwWeights(
  targets: Vec3[],
  stations: Station[],
  eligible: number[],
  k: number = K_NEIGHBORS,
  power: number = 2,
): InterpWeights {
  const kk = Math.min(k, eligible.length);
  const targetCount = targets.length;
  const neighbors = new Int32Array(targetCount * kk).fill(-1);
  const weights = new Float32Array(targetCount * kk);

  const d2 = new Float64Array(eligible.length);
  for (let t = 0; t < targetCount; t++) {
    for (let j = 0; j < eligible.length; j++) {
      d2[j] = dist2(targets[t], stations[eligible[j]].position);
    }
    // 取 k 个最小距离（插入排序，k 很小）
    const picked: number[] = [];
    for (let j = 0; j < eligible.length; j++) {
      let pos = picked.length;
      while (pos > 0 && d2[j] < d2[picked[pos - 1]]) pos--;
      if (pos < kk) {
        picked.splice(pos, 0, j);
        if (picked.length > kk) picked.pop();
      }
    }
    let wSum = 0;
    const base = t * kk;
    for (let q = 0; q < kk; q++) {
      const j = picked[q];
      const d = Math.sqrt(d2[j]);
      const w = 1 / Math.pow(d + 1.5, power); // +1.5 避免与测点重合时奇异
      neighbors[base + q] = eligible[j];
      weights[base + q] = w;
      wSum += w;
    }
    for (let q = 0; q < kk; q++) weights[base + q] /= wSum;
  }
  return { neighbors, weights, k: kk, targetCount };
}

/**
 * 用某日各测点测值求目标点场值
 * @param stationValues 长度 = stations.length，NaN 表示该测点当日无值
 */
export function evaluateField(
  w: InterpWeights,
  stationValues: Float32Array | number[],
): Float32Array {
  const out = new Float32Array(w.targetCount);
  for (let t = 0; t < w.targetCount; t++) {
    let sum = 0;
    let wsum = 0;
    const base = t * w.k;
    for (let q = 0; q < w.k; q++) {
      const si = w.neighbors[base + q];
      if (si < 0) continue;
      const v = stationValues[si];
      if (!Number.isFinite(v)) continue;
      const wt = w.weights[base + q];
      sum += wt * v;
      wsum += wt;
    }
    out[t] = wsum > 0 ? sum / wsum : 0;
  }
  return out;
}

/** 与 evaluateField 相同但写入既有缓冲（播放循环零分配） */
export function evaluateFieldInto(
  w: InterpWeights,
  stationValues: Float32Array | number[],
  out: Float32Array,
): void {
  for (let t = 0; t < w.targetCount; t++) {
    let sum = 0;
    let wsum = 0;
    const base = t * w.k;
    for (let q = 0; q < w.k; q++) {
      const si = w.neighbors[base + q];
      if (si < 0) continue;
      const v = stationValues[si];
      if (!Number.isFinite(v)) continue;
      const wt = w.weights[base + q];
      sum += wt * v;
      wsum += wt;
    }
    out[t] = wsum > 0 ? sum / wsum : 0;
  }
}

/** 提取网格顶点坐标数组为 Vec3 列表 */
export function meshTargets(positions: Float32Array): Vec3[] {
  const n = positions.length / 3;
  const out: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
  }
  return out;
}

/** 支持的位移类测值指标（按优先级） */
export const DISPLACEMENT_METRICS: MetricKey[] = ['radial', 'tangential', 'vertical'];
