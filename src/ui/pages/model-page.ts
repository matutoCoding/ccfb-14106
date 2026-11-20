/**
 * 统计模型页：HST 单点/批量回归、真值系数核对(<5%)、分量过程线、3σ 残差点
 */
import { h, mount } from '../dom';
import { LineChart } from '../line-chart';
import { dataService } from '../../state/data-service';
import { modelManager } from '../../state/model-manager';
import { HST_PREDICTOR_NAMES, METRIC_LABEL, METRIC_UNIT, type HSTCoeffs, type MetricKey, type Station } from '../../types';

const COEFF_KEYS: (keyof HSTCoeffs)[] = ['c0', 'h1', 'h2', 'h3', 'h4', 't1', 't2', 't3', 't4', 'a1', 'a2'];

export class ModelPage {
  readonly el: HTMLDivElement;
  private station: Station | null = null;
  private metric: MetricKey = 'radial';
  private chart = new LineChart({ height: 250 });
  private residualChart = new LineChart({ height: 180 });
  private coeffBody!: HTMLTableSectionElement;
  private summaryEl!: HTMLDivElement;
  private batchEl!: HTMLDivElement;

  constructor() {
    this.el = h('div', { class: 'page model-page' });
  }

  render(): void {
    const options = dataService.stations
      .filter((s) => s.type !== 'piezometer' || true)
      .map((s) => h('option', { value: s.id, textContent: `${s.id} ${s.name}` }));
    const select = h('select', { class: 'select', onchange: (e) => this.selectStation((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
    select.append(...options);
    if (this.station) select.value = this.station.id;
    else this.station = dataService.stations[0];
    this.metric = (this.station?.metrics[0] ?? 'radial') as MetricKey;

    const metricSelect = h(
      'select',
      {
        class: 'select',
        onchange: (e) => {
          this.metric = (e.target as HTMLSelectElement).value as MetricKey;
          this.render();
        },
      },
      (this.station?.metrics ?? ['radial']).map((m) => h('option', { value: m, textContent: METRIC_LABEL[m] })),
    ) as HTMLSelectElement;
    metricSelect.value = this.metric;

    this.coeffBody = h('tbody') as HTMLTableSectionElement;
    this.summaryEl = h('div', { class: 'model-summary' });
    this.batchEl = h('div', { class: 'batch-progress' });

    mount(this.el, [
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title-row' }, [
          h('div', { class: 'panel-title', textContent: '水压-温度-时效(HST)统计模型' }),
          h('div', { class: 'row-actions' }, [
            select,
            metricSelect,
            h('button', { class: 'btn btn-primary', onclick: () => void this.fitOne() }, ['回归拟合']),
            h('button', { class: 'btn', onclick: () => void this.fitAll() }, ['批量拟合全部测点']),
          ]),
        ]),
        this.summaryEl,
        this.batchEl,
      ]),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title', textContent: '回归系数与真值核对' }),
        h('div', { class: 'table-scroll' }, [
          h('table', { class: 'data-table coeff-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { textContent: '自变量' }),
                h('th', { textContent: '回归系数' }),
                h('th', { textContent: '生成真值' }),
                h('th', { textContent: '相对误差' }),
              ]),
            ]),
            this.coeffBody,
          ]),
        ]),
      ]),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title', textContent: '分量过程线（水压 / 温度 / 时效 / 拟合）' }),
        this.chart.el,
      ]),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title', textContent: '残差过程线（红线标记 >3σ 异常点）' }),
        this.residualChart.el,
      ]),
    ]);
    if (this.station) void this.loadExisting();
  }

  private selectStation(id: string): void {
    this.station = dataService.stations.find((s) => s.id === id) ?? null;
    this.render();
  }

  private async fitOne(): Promise<void> {
    if (!this.station) return;
    const result = await modelManager.fitStation(this.station, this.metric);
    this.summaryEl.textContent = `拟合完成：样本 ${result.sampleCount} 点，R²=${result.r2.toFixed(4)}，RMSE=${result.rmse.toFixed(3)} ${METRIC_UNIT[this.metric]}，残差标准差=${result.residualStd.toFixed(3)}，3σ 异常点 ${result.outlierIndices.length} 个`;
    this.summaryEl.className = `model-summary ${(result.coeffRelErrorPct ?? 99) < 5 ? 'summary-ok' : 'summary-warn'}`;
    this.fillCoeffTable(result.coeffs, this.station.trueCoeffs);
    this.drawComponents();
  }

  private async fitAll(): Promise<void> {
    mount(this.batchEl, [h('span', { textContent: '批量回归进行中…' })]);
    const results = await modelManager.fitAll((done, total) => {
      this.batchEl.textContent = `进度 ${done}/${total}（${((100 * done) / total).toFixed(0)}%）`;
    });
    const errs = results.filter((r) => r.coeffRelErrorPct != null).map((r) => r.coeffRelErrorPct!);
    const maxErr = errs.length ? Math.max(...errs) : NaN;
    const meanErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
    const pass = maxErr < 5;
    this.batchEl.innerHTML = '';
    this.batchEl.appendChild(
      h('div', { class: pass ? 'summary-ok' : 'summary-warn' }, [
        `全部 ${results.length} 个序列拟合完成。真值系数核对：平均相对误差 ${meanErr.toFixed(2)}%，最大 ${maxErr.toFixed(2)}%，`,
        pass ? '满足 <5% 精度要求 ✔' : '存在超过 5% 的序列，请检查数据质量',
      ]),
    );
  }

  private async loadExisting(): Promise<void> {
    const result = modelManager.getResult(this.station!.id, this.metric);
    if (result) {
      this.summaryEl.textContent = `已拟合：R²=${result.r2.toFixed(4)}，RMSE=${result.rmse.toFixed(3)}，3σ 异常点 ${result.outlierIndices.length} 个，系数平均误差 ${result.coeffRelErrorPct?.toFixed(2) ?? '-'}%`;
      this.summaryEl.className = `model-summary ${(result.coeffRelErrorPct ?? 99) < 5 ? 'summary-ok' : ''}`;
      this.fillCoeffTable(result.coeffs, this.station!.trueCoeffs);
      this.drawComponents();
    } else {
      this.summaryEl.textContent = '该测点尚未拟合，点击"回归拟合"。';
      this.fillCoeffTable(null, this.station!.trueCoeffs);
    }
  }

  private fillCoeffTable(est: HSTCoeffs | null, truth: HSTCoeffs | undefined): void {
    mount(this.coeffBody, []);
    COEFF_KEYS.forEach((key, i) => {
      const tv = truth?.[key];
      const ev = est?.[key];
      let errText = '-';
      let cls = '';
      if (tv != null && ev != null) {
        const denom = Math.max(Math.abs(tv), 0.15);
        const err = (Math.abs(ev - tv) / denom) * 100;
        errText = `${err.toFixed(2)}%`;
        cls = err < 5 ? 'cell-ok' : 'cell-warn';
      }
      this.coeffBody.appendChild(
        h('tr', {}, [
          h('td', { textContent: HST_PREDICTOR_NAMES[i] }),
          h('td', { textContent: ev != null ? ev.toFixed(4) : '-' }),
          h('td', { class: 'muted', textContent: tv != null ? tv.toFixed(4) : '-' }),
          h('td', { class: cls, textContent: errText }),
        ]),
      );
    });
  }

  private drawComponents(): void {
    if (!this.station) return;
    const comp = modelManager.getComponents(this.station.id, this.metric);
    const se = dataService.peekSeries(this.station.id, this.metric);
    if (!comp || !se) return;
    const dates = Array.from({ length: se.count }, (_, i) => {
      const d = new Date(Date.parse(dataService.settings.startDate + 'T00:00:00Z') + i * 86400000);
      return d.toISOString().slice(0, 10);
    });
    this.chart.opts = { ...this.chart.opts, dates, title: `${this.station.name} · ${METRIC_LABEL[this.metric]} 分量分解 (${METRIC_UNIT[this.metric]})` };
    this.chart.setSeries([
      { name: '实测', values: se.values, color: '#94a3b8', width: 1 },
      { name: '拟合值', values: comp.fitted, color: '#38bdf8' },
      { name: '水压分量', values: comp.hydro, color: '#fbbf24' },
      { name: '温度分量', values: comp.thermal, color: '#34d399' },
      { name: '时效分量', values: comp.aging, color: '#f472b6' },
    ]);
    const result = modelManager.getResult(this.station.id, this.metric);
    const markers = (result?.outlierIndices ?? []).map((i) => ({ index: i, color: '#ef4444' }));
    this.residualChart.opts = { ...this.residualChart.opts, dates, markers, title: '残差与 3σ 异常点' };
    this.residualChart.setSeries([
      { name: '残差', values: comp.residual, color: '#a78bfa' },
      { name: '+3σ', values: new Float32Array(se.count).fill(result?.residualStd ? result.residualStd * 3 : 0), color: '#ef4444', dashed: true, width: 1 },
      { name: '-3σ', values: new Float32Array(se.count).fill(result?.residualStd ? -result.residualStd * 3 : 0), color: '#ef4444', dashed: true, width: 1 },
    ]);
  }
}
