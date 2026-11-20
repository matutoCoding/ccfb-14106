/**
 * 核心管线冒烟测试（Node，无浏览器/IDB 依赖）
 * 覆盖：数据生成 → 质检识别 → 基准接边 → HST 回归 → IDW 插值 → 播放性能
 * 运行：npx tsx scripts/smoke-core.ts
 */
import { DEFAULT_SETTINGS } from '../src/db/generator';
import { buildStations } from '../src/core/dam/stations';
import { generateEnvironment, buildPredictors } from '../src/core/environment';
import { generateSeries, isMissing, isSpike, isDatumShift, isAdjusted } from '../src/core/synthesis';
import { runQualityCheck, spliceDatumShift, fillMissing } from '../src/core/quality';
import { fitHST } from '../src/core/hst';
import { buildIdwWeights, evaluateField, evaluateFieldInto, meshTargets } from '../src/core/interpolate';
import { buildDamFace } from '../src/core/dam/geometry';
import { hashSeed } from '../src/core/random';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✔ ${name} ${detail}`);
  else {
    console.error(`  ✘ ${name} ${detail}`);
    failures++;
  }
}

function main(): void {
  const settings = DEFAULT_SETTINGS;
  const stations = buildStations(settings.days);
  const env = generateEnvironment(settings, hashSeed('env-drivers-v1'));
  const predictors = buildPredictors(env, settings);

  console.log('【1 数据生成】');
  check('测点数量', stations.length > 150, `共 ${stations.length} 个`);
  const s0 = stations[0];
  const gen = generateSeries(s0, s0.metrics[0], env, predictors, settings.startDate);
  check('日序列长度=15年', gen.values.length === settings.days, `${gen.values.length}`);
  const missingCount = [...gen.quality].filter((q) => isMissing(q)).length;
  check('注入了缺测', missingCount > 0, `${missingCount} 点`);
  const spikeCount = [...gen.quality].filter((q) => isSpike(q)).length;
  check('注入了跳变', spikeCount >= 2, `${spikeCount} 点`);
  check('生成了质检事件', gen.events.length >= 4, `${gen.events.length} 条`);

  console.log('【2 质检自动识别】');
  // 构造一条干净序列再人为加 spike/shift，检验识别率
  const values = Float32Array.from(gen.values);
  const qc = runQualityCheck(s0.id, s0.metrics[0], values, settings.startDate, new Uint8Array(settings.days));
  const spikeEvents = qc.events.filter((e) => e.kind === 'spike');
  const shiftEvents = qc.events.filter((e) => e.kind === 'datum-shift');
  check('识别出跳变事件', spikeEvents.length >= 1, `${spikeEvents.length} 条`);
  check('识别出缺测事件', qc.events.some((e) => e.kind === 'missing'));
  check('基准变化检测不崩溃', Array.isArray(shiftEvents));

  console.log('【3 基准变化人工接边】');
  if (shiftEvents.length) {
    const e = shiftEvents[0];
    const before = values[e.index - 1];
    const after = values[e.index + 1];
    const fixed = spliceDatumShift(values, qc.quality, e.index, e.offset ?? 0);
    check('接边后标记 Adjusted', isAdjusted(fixed.quality[e.index]));
    check('接边消除突变', Math.abs(fixed.values[e.index + 1] - fixed.values[e.index - 1]) < Math.abs(after - before) + 1);
  } else {
    // 手工制造一个基准突变再验证
    const v2 = Float32Array.from(values);
    const q2 = new Uint8Array(settings.days);
    const idx = 2000;
    for (let i = idx; i < v2.length; i++) v2[i] += 6;
    const qc2 = runQualityCheck(s0.id, s0.metrics[0], v2, settings.startDate, q2);
    const shift = qc2.events.find((x) => x.kind === 'datum-shift');
    check('人工突变被识别', !!shift, shift ? `@${shift.index}` : '未识别');
    if (shift) {
      const fixed = spliceDatumShift(v2, qc2.quality, shift.index, shift.offset ?? 0);
      check('接边后回归基准', Math.abs(fixed.values[idx + 5] - values[idx + 5]) < 1.0);
    }
  }

  console.log('【4 缺测插补】');
  const filled = fillMissing(gen.values, gen.quality);
  check('插补后无 NaN', [...filled].every(Number.isFinite));

  console.log('【5 HST 回归】');
  const result = fitHST(s0.id, s0.metrics[0], gen.values, gen.quality, predictors, gen.trueCoeffs);
  check('R² > 0.95', result.r2 > 0.95, `R²=${result.r2.toFixed(4)}`);
  check('3σ 异常点可输出', Array.isArray(result.outlierIndices));
  check('系数误差 <10%', (result.coeffRelErrorPct ?? 99) < 10, `${result.coeffRelErrorPct?.toFixed(2)}%`);

  console.log('【6 IDW 空间插值】');
  const face = buildDamFace(1);
  const targets = meshTargets(face.positions);
  const eligible = stations.map((_, i) => i).filter((i) => stations[i].metrics.includes(s0.metrics[0]));
  const weights = buildIdwWeights(targets, stations, eligible);
  check('每个坝面顶点都有近邻', weights.targetCount === face.vertexCount);
  const stationVals = new Float32Array(stations.length).fill(NaN);
  eligible.forEach((i) => (stationVals[i] = gen.values[1000] + (i % 5)));
  const field = evaluateField(weights, stationVals);
  check('插值场长度=顶点数', field.length === face.vertexCount);
  check('插值结果有限', [...field].every(Number.isFinite));
  // 常数场插值应还原常数
  const constVals = new Float32Array(stations.length).fill(NaN);
  eligible.forEach((i) => (constVals[i] = 7.5));
  const constField = evaluateField(weights, constVals);
  check('常数场还原(误差<0.01)', Math.max(...[...constField].map((v) => Math.abs(v - 7.5))) < 0.01);

  console.log('【7 播放性能（关键验收项）】');
  const out = new Float32Array(face.vertexCount);
  const t0 = performanceNow();
  const FRAMES = 3650; // 模拟 10 年逐日播放
  for (let f = 0; f < FRAMES; f++) {
    const dayVals = new Float32Array(stations.length).fill(NaN);
    eligible.forEach((i, k) => (dayVals[i] = Math.sin((f + k) * 0.05) * 10));
    evaluateFieldInto(weights, dayVals, out);
  }
  const ms = performanceNow() - t0;
  check('10年逐日插值总耗时 < 500ms', ms < 500, `${ms.toFixed(1)}ms，单帧 ${(ms / FRAMES).toFixed(3)}ms`);
  check('单帧耗时 < 0.2ms（60fps 无压力）', ms / FRAMES < 0.2);

  console.log('【8 环境量物理规律】');
  check('库水位在合理区间', env.waterLevel.every((v) => v > settings.deadPoolLevel - 5 && v < settings.normalPoolLevel + 5));
  check('气温有年周期(冬冷夏热)', (() => {
    const summer = env.airTemp.slice(180, 200).reduce((a, b) => a + b, 0) / 20;
    const winter = env.airTemp.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    return summer > winter;
  })(), `夏${' '}均温 > 冬均温`);
  check('蓄水后水头显著抬升', env.head[2000] > env.head[100] * 2);

  console.log('\n' + '═'.repeat(60));
  if (failures === 0) {
    console.log('冒烟测试全部通过 ✔');
    process.exit(0);
  } else {
    console.error(`${failures} 项失败 ✘`);
    process.exit(1);
  }
}

function performanceNow(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

main();
