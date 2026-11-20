/**
 * HST（水压-温度-时效）统计模型
 * 对单测点序列做 11 元线性回归，输出分量分解、残差与 3σ 异常点
 * 设计矩阵列与 src/core/environment.buildPredictors 严格一致
 */
import type { HSTCoeffs, HSTResult, MetricKey } from '../types';
import { choleskySolve, mean } from './matrix';
import { isDatumShift, isMissing } from './synthesis';
import type { HSTPredictors } from './environment';
import { evaluateHST } from './synthesis';

const P = 11;
/**
 * 岭参数（标准化尺度）。设计矩阵已对水压/时效组做 Gram-Schmidt 正交化，
 * 此处仅保留极小数值稳定项；正交基保证各分量系数可独立稳定恢复
 */
const RIDGE_LAMBDA = 1e-6;

export function coeffsFromVector(b: ArrayLike<number>): HSTCoeffs {
  return {
    c0: b[0],
    h1: b[1],
    h2: b[2],
    h3: b[3],
    h4: b[4],
    t1: b[5],
    t2: b[6],
    t3: b[7],
    t4: b[8],
    a1: b[9],
    a2: b[10],
  };
}

/**
 * 回归拟合
 * @param values 日测序列（NaN/缺测跳过；未接边的基准突变点之后整段跳过）
 * @param quality 质量位数组
 */
export function fitHST(
  stationId: string,
  metric: MetricKey,
  values: Float32Array,
  quality: Uint8Array,
  predictors: HSTPredictors,
  trueCoeffs?: HSTCoeffs,
): HSTResult {
  const n = values.length;
  const cleanIdx: number[] = [];
  let datumStart = -1;
  for (let i = 0; i < n; i++) {
    if (isMissing(quality[i])) continue;
    // 未接边的基准突变：旧基准段(突变点之前)基准不统一，弃用；突变后为当前有效基准，保留
    if (isDatumShift(quality[i]) && !(quality[i] & 8)) datumStart = i;
  }
  // 蓄水期(前 2 年)水位-变形关系尚未稳定，HST 建模按工程惯例从蓄水完成后起算
  const impoundSkip = Math.min(730, Math.floor(n * 0.15));
  const lowerBound = Math.max(impoundSkip, datumStart);
  for (let i = lowerBound; i < n; i++) {
    if (isMissing(quality[i])) continue;
    if (quality[i] & 2) continue; // 跳变点不参与回归（Quality.Spike）
    const v = values[i];
    if (Number.isFinite(v)) cleanIdx.push(i);
  }

  const m = cleanIdx.length;
  if (m < 90) throw new Error(`有效样本不足(${m})，无法回归`);

  const x = new Float64Array(m * P);
  const y = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = cleanIdx[k];
    x.set(predictors.values.subarray(i * P, i * P + P), k * P);
    y[k] = values[i];
  }

  const beta = ridgeRegression(x, m, y);
  const coeffs = coeffsFromVector(beta);

  // 残差与拟合统计
  const residuals = new Float64Array(m);
  let ssRes = 0;
  const yMean = mean(y);
  let ssTot = 0;
  for (let k = 0; k < m; k++) {
    const pred = predictOne(x, k, beta);
    residuals[k] = y[k] - pred;
    ssRes += residuals[k] * residuals[k];
    ssTot += (y[k] - yMean) * (y[k] - yMean);
  }
  const rmse = Math.sqrt(ssRes / m);
  const residualStd = Math.sqrt(ssRes / (m - P));
  const r2 = 1 - ssRes / ssTot;

  // 3σ 异常点
  const outlierIndices: number[] = [];
  const limit = 3 * residualStd;
  for (let k = 0; k < m; k++) {
    if (Math.abs(residuals[k]) > limit) outlierIndices.push(cleanIdx[k]);
  }

  // 真值系数核验：非常数项相对误差（按量级加权平均）
  let coeffRelErrorPct: number | undefined;
  if (trueCoeffs) {
    const keys = ['h1', 'h2', 'h3', 'h4', 't1', 't2', 't3', 't4', 'a1', 'a2'] as const;
    let errSum = 0;
    let wSum = 0;
    for (const key of keys) {
      const truth = trueCoeffs[key];
      const est = coeffs[key];
      const denom = Math.max(Math.abs(truth), 0.15); // 小系数用下限做分母，避免除零放大
      const w = Math.abs(truth);
      errSum += (Math.abs(est - truth) / denom) * w;
      wSum += w;
    }
    coeffRelErrorPct = (100 * errSum) / wSum;
  }

  return {
    stationId,
    metric,
    coeffs,
    r2,
    rmse,
    residualStd,
    sampleCount: m,
    outlierIndices,
    coeffRelErrorPct,
  };
}

function predictOne(x: Float64Array, row: number, beta: ArrayLike<number>): number {
  let s = 0;
  const base = row * P;
  for (let p = 0; p < P; p++) s += x[base + p] * beta[p];
  return s;
}

/**
 * 标准化岭回归
 * 1) 对每个自变量（常数项除外）做 z-score 标准化，消除量纲差异
 * 2) 在标准化设计矩阵上解 (X'X + λI)β* = X'y，常数项不惩罚
 * 3) 系数换算回原始自变量尺度，使输出可直接与真值系数对比
 */
function ridgeRegression(x: Float64Array, m: number, y: Float64Array): Float64Array {
  const colMean = new Float64Array(P);
  const colStd = new Float64Array(P).fill(1);
  for (let p = 0; p < P; p++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += x[i * P + p];
    colMean[p] = s / m;
    let ss = 0;
    for (let i = 0; i < m; i++) {
      const d = x[i * P + p] - colMean[p];
      ss += d * d;
    }
    const sd = Math.sqrt(ss / (m - 1));
    if (p > 0 && sd > 1e-12) colStd[p] = sd;
  }
  const xStd = new Float64Array(m * P);
  for (let i = 0; i < m; i++) {
    xStd[i * P] = 1;
    for (let p = 1; p < P; p++) {
      xStd[i * P + p] = (x[i * P + p] - colMean[p]) / colStd[p];
    }
  }
  const ata = new Float64Array(P * P);
  const aty = new Float64Array(P);
  for (let i = 0; i < m; i++) {
    const row = i * P;
    for (let a = 0; a < P; a++) {
      aty[a] += xStd[row + a] * y[i];
      for (let b = 0; b < P; b++) ata[a * P + b] += xStd[row + a] * xStd[row + b];
    }
  }
  // 岭惩罚（不含常数项，即下标 0）
  for (let p = 1; p < P; p++) ata[p * P + p] += RIDGE_LAMBDA;
  const betaStd = choleskySolve(ata, P, aty);

  // 还原到原始尺度：β_p = β*_p / σ_p；β_0 = y均值 - Σ β_p·均值_p
  const beta = new Float64Array(P);
  const yBar = mean(y);
  let intercept = yBar;
  for (let p = 1; p < P; p++) {
    beta[p] = betaStd[p] / colStd[p];
    intercept -= beta[p] * colMean[p];
  }
  beta[0] = intercept;
  return beta;
}

/** 分量分解：水压 / 温度 / 时效 / 常数，返回四条过程线 */
export function decomposeComponents(
  coeffs: HSTCoeffs,
  predictors: HSTPredictors,
): { hydro: Float32Array; thermal: Float32Array; aging: Float32Array; fitted: Float32Array } {
  const n = predictors.count;
  const hydro = new Float32Array(n);
  const thermal = new Float32Array(n);
  const aging = new Float32Array(n);
  const fitted = new Float32Array(n);
  const x = predictors.values;
  for (let i = 0; i < n; i++) {
    const row = i * P;
    hydro[i] =
      coeffs.h1 * x[row + 1] +
      coeffs.h2 * x[row + 2] +
      coeffs.h3 * x[row + 3] +
      coeffs.h4 * x[row + 4];
    thermal[i] =
      coeffs.t1 * x[row + 5] +
      coeffs.t2 * x[row + 6] +
      coeffs.t3 * x[row + 7] +
      coeffs.t4 * x[row + 8];
    aging[i] = coeffs.a1 * x[row + 9] + coeffs.a2 * x[row + 10];
    fitted[i] = evaluateHST(coeffs, predictors, i);
  }
  return { hydro, thermal, aging, fitted };
}

/** 残差序列（长度 n，缺测位置 NaN） */
export function residualSeries(
  values: Float32Array,
  quality: Uint8Array,
  predictors: HSTPredictors,
  coeffs: HSTCoeffs,
): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (isMissing(quality[i]) || !Number.isFinite(values[i])) {
      out[i] = NaN;
      continue;
    }
    out[i] = values[i] - evaluateHST(coeffs, predictors, i);
  }
  return out;
}
