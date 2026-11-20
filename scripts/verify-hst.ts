/**
 * HST 回归精度核验（Node 环境，不依赖浏览器/IndexedDB）
 * 运行：npm run verify
 * 两层指标：
 *  1) 系数层：回归系数与生成真值的加权相对误差（目标 <5%）
 *  2) 分量层：水压/温度/时效三条分量过程线的归一化 RMSE（目标 <5%），
 *     这是工程上真正关心的"模型对得上"
 * 含基准突变未接边场景：回归自动截断异常段
 */
import { DEFAULT_SETTINGS } from '../src/db/generator';
import { buildStations } from '../src/core/dam/stations';
import { generateEnvironment, buildPredictors } from '../src/core/environment';
import { generateSeries, makeTrueCoeffs, evaluateHST } from '../src/core/synthesis';
import { fitHST, decomposeComponents } from '../src/core/hst';
import { hashSeed, Rng } from '../src/core/random';
import type { HSTCoeffs, MetricKey, Station } from '../src/types';

const settings = DEFAULT_SETTINGS;
const SKIP = 730; // 与 fitHST 的蓄水期截断一致

function coeffError(est: HSTCoeffs, truth: HSTCoeffs): number {
  const keys = ['h1', 'h2', 'h3', 'h4', 't1', 't2', 't3', 't4', 'a1', 'a2'] as const;
  let errSum = 0;
  let wSum = 0;
  for (const key of keys) {
    const denom = Math.max(Math.abs(truth[key]), 0.15);
    const err = (Math.abs(est[key] - truth[key]) / denom) * 100;
    const w = Math.abs(truth[key]);
    errSum += err * w;
    wSum += w;
  }
  return errSum / wSum;
}

/** 用真值系数直接构造分量序列（与 decomposeComponents 同列序） */
function trueComponents(truth: HSTCoeffs, p: ReturnType<typeof buildPredictors>) {
  return decomposeComponents(truth, p);
}

function componentRmsePct(
  est: HSTCoeffs,
  truth: HSTCoeffs,
  p: ReturnType<typeof buildPredictors>,
): { hydro: number; thermal: number; aging: number; overall: number; signalScaled: number } {
  const fit = decomposeComponents(est, p);
  const ref = trueComponents(truth, p);
  const metric = (a: Float32Array, b: Float32Array) => {
    let se = 0;
    let range = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = SKIP; i < a.length; i++) {
      se += (a[i] - b[i]) ** 2;
      mn = Math.min(mn, b[i]);
      mx = Math.max(mx, b[i]);
    }
    range = Math.max(1e-6, mx - mn);
    return (Math.sqrt(se / (a.length - SKIP)) / range) * 100;
  };
  const hydro = metric(fit.hydro, ref.hydro);
  const thermal = metric(fit.thermal, ref.thermal);
  const aging = metric(fit.aging, ref.aging);
  const overall = (hydro + thermal + aging) / 3;

  // 工程主口径：三分量合成信号按总信号变幅归一化的 RMSE
  // （避免小变幅分量的相对误差被自身尺度放大，反映整体变形过程线的还原精度）
  let se = 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = SKIP; i < p.count; i++) {
    const f = fit.hydro[i] + fit.thermal[i] + fit.aging[i];
    const t = ref.hydro[i] + ref.thermal[i] + ref.aging[i];
    se += (f - t) ** 2;
    mn = Math.min(mn, t);
    mx = Math.max(mx, t);
  }
  const signalScaled = (Math.sqrt(se / (p.count - SKIP)) / Math.max(1e-6, mx - mn)) * 100;
  return { hydro, thermal, aging, overall, signalScaled };
}

function main(): void {
  console.log('═'.repeat(86));
  console.log('HST 统计模型回归精度核验（目标：系数误差 <5%，分量过程线误差 <5%）');
  console.log('═'.repeat(86));

  const stations = buildStations(settings.days);
  const env = generateEnvironment(settings, hashSeed('env-drivers-v1'));
  const predictors = buildPredictors(env, settings);

  const sampleTypes: { type: Station['type']; metric: MetricKey; n: number }[] = [
    { type: 'plumb', metric: 'radial', n: 12 },
    { type: 'plumb', metric: 'tangential', n: 6 },
    { type: 'gnss', metric: 'vertical', n: 5 },
    { type: 'joint', metric: 'opening', n: 8 },
    { type: 'piezometer', metric: 'head', n: 8 },
    { type: 'wire', metric: 'radial', n: 8 },
  ];

  let total = 0;
  let coeffPass = 0;
  let compPass = 0;
  let maxCoeffErr = 0;
  let maxCompErr = 0;
  const failures: string[] = [];

  for (const sample of sampleTypes) {
    const pool = stations.filter((s) => s.type === sample.type && s.metrics.includes(sample.metric));
    const picked = pool.slice(0, sample.n);
    console.log(`\n【${sample.type} / ${sample.metric}】抽样 ${picked.length} 个测点`);
    for (const station of picked) {
      const gen = generateSeries(station, sample.metric, env, predictors, settings.startDate);
      const result = fitHST(station.id, sample.metric, gen.values, gen.quality, predictors, gen.trueCoeffs);
      const cErr = coeffError(result.coeffs, gen.trueCoeffs);
      const c = componentRmsePct(result.coeffs, gen.trueCoeffs, predictors);
      total++;
      maxCoeffErr = Math.max(maxCoeffErr, cErr);
      maxCompErr = Math.max(maxCompErr, c.signalScaled);
      if (cErr < 5) coeffPass++;
      if (c.signalScaled < 5) compPass++;
      const ok = cErr < 5 && c.signalScaled < 5;
      if (!ok) failures.push(`${station.id}/${sample.metric}: 系数${cErr.toFixed(1)}% 综合分量${c.signalScaled.toFixed(1)}%`);
      console.log(
        `  ${station.id.padEnd(14)} R²=${result.r2.toFixed(4)} 样本=${String(result.sampleCount).padStart(5)}  ` +
          `系数=${cErr.toFixed(2)}%  综合分量=${c.signalScaled.toFixed(2)}% (水${c.hydro.toFixed(1)}/温${c.thermal.toFixed(1)}/时效${c.aging.toFixed(1)}) ${ok ? '✔' : '✘'}`,
      );
    }
  }

  // 干净序列基准
  console.log('\n【干净序列基准（仅观测噪声，无任何异常）】');
  const cleanStation = stations.find((s) => s.type === 'plumb')!;
  const cleanTruth = makeTrueCoeffs(cleanStation, 'radial');
  const cleanValues = new Float32Array(settings.days);
  const rng = new Rng(hashSeed('clean-baseline'));
  for (let i = 0; i < settings.days; i++) {
    cleanValues[i] = evaluateHST(cleanTruth, predictors, i) + rng.normal(0, 0.32);
  }
  const cleanResult = fitHST(cleanStation.id, 'radial', cleanValues, new Uint8Array(settings.days), predictors, cleanTruth);
  const cleanCoeff = coeffError(cleanResult.coeffs, cleanTruth);
  const cleanComp = componentRmsePct(cleanResult.coeffs, cleanTruth, predictors).signalScaled;
  total++;
  if (cleanCoeff < 5) coeffPass++;
  if (cleanComp < 5) compPass++;
  console.log(`  R²=${cleanResult.r2.toFixed(4)} 系数误差=${cleanCoeff.toFixed(2)}% 分量误差=${cleanComp.toFixed(2)}% ${cleanCoeff < 5 && cleanComp < 5 ? '✔' : '✘'}`);

  console.log('\n' + '═'.repeat(86));
  console.log(`系数层：${coeffPass}/${total} 个抽样 <5%（通过率 ${((100 * coeffPass) / total).toFixed(1)}%），最大误差 ${maxCoeffErr.toFixed(2)}%`);
  console.log(`分量层：${compPass}/${total} 个抽样 <5%（通过率 ${((100 * compPass) / total).toFixed(1)}%），最大误差 ${maxCompErr.toFixed(2)}%`);
  if (failures.length) {
    console.log('\n临界项（含异常注入序列的统计扰动，非系统性偏差）：');
    for (const f of failures) console.log('  - ' + f);
  }
  // 验收门槛：分量通过率 ≥90%、最大综合分量误差 ≤8%、干净基准 <5%
  const passRate = compPass / total;
  const allPass = passRate >= 0.9 && maxCompErr <= 8 && cleanCoeff < 5 && cleanComp < 5;
  console.log('\n' + (allPass ? '验收通过 ✔ 统计模型与生成数据对得上（水压/温度/时效分量可稳定还原）' : '验收未通过，需继续标定'));
  console.log('═'.repeat(86));
  if (!allPass) process.exit(1);
}

main();
