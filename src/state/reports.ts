/**
 * 月报/年报导出：变形统计 CSV + 变形分布图 PNG（离屏 Canvas 绘制等值线云图）
 */
import { dataService } from './data-service';
import { modelManager } from './model-manager';
import { exportStatTable } from '../ui/export';
import { indexToDate } from '../core/dates';
import { buildDamFace } from '../core/dam/geometry';
import { buildIdwWeights, evaluateField, meshTargets } from '../core/interpolate';
import { rampColor } from '../render/color-ramp';
import type { MetricKey } from '../types';

export interface ReportPeriod {
  label: string;
  startIndex: number;
  endIndex: number;
}

export function monthPeriods(year: number, settings: { startDate: string; days: number }): ReportPeriod[] {
  const out: ReportPeriod[] = [];
  for (let m = 0; m < 12; m++) {
    const start = `${year}-${String(m + 1).padStart(2, '0')}-01`;
    const next = new Date(Date.UTC(year, m + 1, 1)).toISOString().slice(0, 10);
    const si = clampIndex(dateIdx(settings.startDate, start), settings.days);
    const ei = clampIndex(dateIdx(settings.startDate, next) - 1, settings.days);
    if (si >= 0 && ei > si) out.push({ label: `${year}年${m + 1}月`, startIndex: si, endIndex: ei });
  }
  return out;
}

export function yearPeriod(year: number, settings: { startDate: string; days: number }): ReportPeriod {
  const si = clampIndex(dateIdx(settings.startDate, `${year}-01-01`), settings.days);
  const ei = clampIndex(dateIdx(settings.startDate, `${year + 1}-01-01`) - 1, settings.days);
  return { label: `${year}年度`, startIndex: si, endIndex: ei };
}

function dateIdx(start: string, iso: string): number {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
}
function clampIndex(i: number, days: number): number {
  return i >= 0 && i < days ? i : -1;
}

/** 时段统计表：每测点期初/期末值、变幅、均值、最大最小及日期 */
export async function exportStatReport(period: ReportPeriod, metric: MetricKey): Promise<void> {
  const rows: (string | number)[][] = [];
  for (const s of dataService.stations) {
    if (!s.metrics.includes(metric)) continue;
    const se = await dataService.getSeries(s.id, metric);
    let min = Infinity;
    let max = -Infinity;
    let minDate = '';
    let maxDate = '';
    let sum = 0;
    let cnt = 0;
    for (let i = period.startIndex; i <= period.endIndex; i++) {
      const v = se.values[i];
      if (!Number.isFinite(v)) continue;
      sum += v;
      cnt++;
      if (v < min) {
        min = v;
        minDate = indexToDate(dataService.settings.startDate, i);
      }
      if (v > max) {
        max = v;
        maxDate = indexToDate(dataService.settings.startDate, i);
      }
    }
    if (cnt === 0) continue;
    rows.push([
      s.id,
      s.name,
      `${s.monolithId}#`,
      s.elevation,
      se.values[period.startIndex]?.toFixed(2) ?? '',
      se.values[period.endIndex]?.toFixed(2) ?? '',
      (max - min).toFixed(2),
      (sum / cnt).toFixed(2),
      min.toFixed(2),
      minDate,
      max.toFixed(2),
      maxDate,
    ]);
  }
  exportStatTable(
    `变形统计表_${period.label}.csv`,
    `${dataService.settings.damName} ${period.label} 变形统计表`,
    ['测点编号', '名称', '坝段', '高程', '期初值', '期末值', '时段变幅', '均值', '最小值', '最小值日期', '最大值', '最大值日期'],
    rows,
  );
}

/**
 * 变形分布图 PNG：把期末测值插值到坝面网格，离屏 Canvas 绘制云图+等值线+测点
 */
export async function exportDistributionMap(period: ReportPeriod, metric: MetricKey): Promise<void> {
  const stations = dataService.stations;
  const eligible: number[] = [];
  const vals: number[] = [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    if (!s.metrics.includes(metric)) continue;
    const se = dataService.peekSeries(s.id, metric) ?? (await dataService.getSeries(s.id, metric));
    const v = se.values[period.endIndex];
    if (Number.isFinite(v)) {
      eligible.push(i);
      vals.push(v);
    }
  }
  const face = buildDamFace(1);
  const targets = meshTargets(face.positions);
  const w = buildIdwWeights(targets, stations, eligible);
  const field = evaluateField(w, vals);

  const W = 1400;
  const H = 800;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0d1420';
  ctx.fillRect(0, 0, W, H);

  // 坐标范围
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < face.vertexCount; i++) {
    const x = face.positions[i * 3];
    const y = face.positions[i * 3 + 1];
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
  const pad = 70;
  const sx = (W - pad * 2) / (xMax - xMin);
  const sy = (H - pad * 2) / (yMax - yMin);
  const px = (x: number) => pad + (x - xMin) * sx;
  const py = (y: number) => H - pad - (y - yMin) * sy;

  let fMin = Infinity;
  let fMax = -Infinity;
  for (const v of field) {
    fMin = Math.min(fMin, v);
    fMax = Math.max(fMax, v);
  }

  // 三角面填色
  for (let ti = 0; ti < face.indices.length; ti += 3) {
    const a = face.indices[ti];
    const b = face.indices[ti + 1];
    const c = face.indices[ti + 2];
    const vAvg = (field[a] + field[b] + field[c]) / 3;
    const t = (vAvg - fMin) / Math.max(1e-6, fMax - fMin);
    const [r, g, b2] = rampColor(t);
    ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b2 * 255)})`;
    ctx.beginPath();
    ctx.moveTo(px(face.positions[a * 3]), py(face.positions[a * 3 + 1]));
    ctx.lineTo(px(face.positions[b * 3]), py(face.positions[b * 3 + 1]));
    ctx.lineTo(px(face.positions[c * 3]), py(face.positions[c * 3 + 1]));
    ctx.closePath();
    ctx.fill();
  }

  // 测点
  for (const si of eligible) {
    const s = stations[si];
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.arc(px(s.position.x), py(s.position.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 色带
  const legW = 26;
  const legH = 320;
  const lx = W - 70;
  const ly = 90;
  for (let i = 0; i < legH; i++) {
    const [r, g, b] = rampColor(1 - i / legH);
    ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    ctx.fillRect(lx, ly + i, legW, 1);
  }
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '13px sans-serif';
  ctx.fillText(fMax.toFixed(2), lx + legW + 8, ly + 12);
  ctx.fillText(fMin.toFixed(2), lx + legW + 8, ly + legH);

  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(`${dataService.settings.damName} ${period.label} 变形分布图（${metric}，期末）`, pad, 40);
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `变形分布图_${period.label}.png`;
  a.click();
}

/** 报告中心可用年份 */
export function reportYears(): number[] {
  const startYear = Number(dataService.settings.startDate.slice(0, 4));
  const endYear = Number(indexToDate(dataService.settings.startDate, dataService.settings.days - 1).slice(0, 4));
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  return years;
}

void modelManager;
