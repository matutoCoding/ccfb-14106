/**
 * 预警引擎：按"测值/速率/模型残差"三类规则扫描全序列，生成预警记录
 */
import type { AlertRecord, AlertRule, MetricKey } from '../types';
import { dataService } from './data-service';
import { modelManager } from './model-manager';
import { isMissing } from '../core/synthesis';
import { saveAlerts } from '../db/idb';

function isoAt(startDate: string, index: number): string {
  const start = Date.parse(startDate + 'T00:00:00Z');
  return new Date(start + index * 86400000).toISOString().slice(0, 10);
}

export const DEFAULT_RULES: AlertRule[] = [
  { id: 'rule-value-radial', type: 'value', metric: 'radial', stationType: 'all', level: 'alarm', threshold: 28, enabled: true },
  { id: 'rule-value-radial-watch', type: 'value', metric: 'radial', stationType: 'all', level: 'warning', threshold: 20, enabled: true },
  { id: 'rule-rate-radial', type: 'rate', metric: 'radial', stationType: 'all', level: 'warning', threshold: 1.2, enabled: true },
  { id: 'rule-residual', type: 'residual', metric: 'radial', stationType: 'all', level: 'warning', threshold: 3, enabled: true },
  { id: 'rule-value-opening', type: 'value', metric: 'opening', stationType: 'joint', level: 'warning', threshold: 5, enabled: true },
  { id: 'rule-value-head', type: 'value', metric: 'head', stationType: 'piezometer', level: 'warning', threshold: 90, enabled: true },
];

export async function scanAlerts(rules: AlertRule[]): Promise<AlertRecord[]> {
  const { stations, settings } = dataService;
  const records: AlertRecord[] = [];
  const enabled = rules.filter((r) => r.enabled);

  for (const station of stations) {
    for (const metric of station.metrics) {
      const active = enabled.filter(
        (r) => r.metric === metric && (r.stationType === 'all' || r.stationType === station.type),
      );
      if (active.length === 0) continue;
      const series = await dataService.getSeries(station.id, metric);
      const result = modelManager.getResult(station.id, metric);
      const comp = modelManager.getComponents(station.id, metric);
      const n = series.count;

      for (let i = 2; i < n; i++) {
        if (isMissing(series.quality[i])) continue;
        const v = series.values[i];
        if (!Number.isFinite(v)) continue;
        const rate = (v - series.values[i - 2]) / 2;
        const resid = comp?.residual[i];
        const residStd = result?.residualStd ?? 1;

        for (const rule of active) {
          let hit = false;
          let shown = 0;
          if (rule.type === 'value') {
            hit = Math.abs(v) >= rule.threshold;
            shown = v;
          } else if (rule.type === 'rate') {
            hit = Number.isFinite(rate) && Math.abs(rate) >= rule.threshold;
            shown = rate;
          } else if (rule.type === 'residual') {
            const limit = rule.threshold * residStd;
            hit = Number.isFinite(resid) && Math.abs(resid as number) >= limit;
            shown = resid as number;
          }
          if (hit) {
            records.push({
              id: `${rule.id}-${station.id}-${i}`,
              stationId: station.id,
              metric: metric as MetricKey,
              index: i,
              date: isoAt(settings.startDate, i),
              ruleId: rule.id,
              ruleType: rule.type,
              level: rule.level,
              value: shown,
              threshold: rule.type === 'residual' ? rule.threshold * residStd : rule.threshold,
              status: 'open',
              message: alertMessage(rule, shown),
              createdAt: isoAt(settings.startDate, i),
            });
          }
        }
      }
    }
  }
  // 同一测点同日只保留最高级别一条，控制记录总量
  const dedup = new Map<string, AlertRecord>();
  const rank = { watch: 0, warning: 1, alarm: 2 };
  for (const r of records) {
    const k = `${r.stationId}|${r.metric}|${r.index}`;
    const ex = dedup.get(k);
    if (!ex || rank[r.level] > rank[ex.level]) dedup.set(k, r);
  }
  const final = [...dedup.values()].sort((a, b) => b.index - a.index);
  await saveAlerts(final);
  return final;
}

function alertMessage(rule: AlertRule, value: number): string {
  const unit = rule.metric === 'head' ? 'm' : 'mm';
  const typeName = rule.type === 'value' ? '测值' : rule.type === 'rate' ? '变化速率' : '模型残差';
  return `${typeName}超限：当前 ${value.toFixed(2)} ${rule.type === 'rate' ? unit + '/d' : unit}，阈值 ${rule.threshold}${rule.type === 'residual' ? 'σ' : ''}`;
}
