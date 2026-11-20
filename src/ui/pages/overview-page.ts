/**
 * 工程测点页：大坝参数卡片、测点分类统计、测点表（筛选/定位）、单点过程线
 */
import { h, mount } from '../dom';
import { LineChart } from '../line-chart';
import { dataService } from '../../state/data-service';
import { uiStore } from '../../state/ui';
import { DAM_PARAMS, buildMonoliths } from '../../core/dam/params';
import { indexToDate } from '../../core/dates';
import { METRIC_LABEL, METRIC_UNIT, type Station, type StationType } from '../../types';
import { isMissing, isSpike, isDatumShift } from '../../core/synthesis';

const TYPE_LABEL: Record<StationType, string> = {
  plumb: '垂线',
  wire: '引张线',
  gnss: 'GNSS',
  joint: '测缝计',
  piezometer: '渗压计',
};

export class OverviewPage {
  readonly el: HTMLDivElement;
  private tableBody!: HTMLTableSectionElement;
  private chart: LineChart;
  private filter: StationType | 'all' = 'all';
  private selected: Station | null = null;

  constructor() {
    this.el = h('div', { class: 'page overview-page' });
    this.chart = new LineChart({ height: 260 });
  }

  render(): void {
    const { settings, stations } = dataService;
    const counts = new Map<StationType, number>();
    for (const s of stations) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
    const monoliths = buildMonoliths();

    const statCards = [
      ['坝型', '混凝土双曲拱坝'],
      ['坝顶/坝基高程', `${settings.crestElev} / ${settings.baseElev} m`],
      ['最大坝高', `${settings.crestElev - settings.baseElev} m`],
      ['坝顶拱圈半径', `${DAM_PARAMS.crestRadius} m`],
      ['坝段数', `${monoliths.length} 个`],
      ['测点总数', `${stations.length} 个`],
    ].map(([k, v]) =>
      h('div', { class: 'stat-card' }, [h('div', { class: 'stat-value', textContent: v }), h('div', { class: 'stat-key', textContent: k })]),
    );

    const typeChips = (['all', 'plumb', 'wire', 'gnss', 'joint', 'piezometer'] as const).map((t) =>
      h(
        'button',
        {
          class: `chip ${this.filter === t ? 'chip-active' : ''}`,
          onclick: () => {
            this.filter = t;
            this.render();
          },
        },
        [t === 'all' ? `全部(${stations.length})` : `${TYPE_LABEL[t]}(${counts.get(t) ?? 0})`],
      ),
    );

    this.tableBody = h('tbody') as HTMLTableSectionElement;
    const table = h('div', { class: 'table-scroll' }, [
      h('table', { class: 'data-table' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { textContent: '测点编号' }),
            h('th', { textContent: '名称' }),
            h('th', { textContent: '类型' }),
            h('th', { textContent: '坝段' }),
            h('th', { textContent: '高程(m)' }),
            h('th', { textContent: '测项' }),
            h('th', { textContent: '数据质量' }),
            h('th', { textContent: '操作' }),
          ]),
        ]),
        this.tableBody,
      ]),
    ]);

    mount(this.el, [
      h('div', { class: 'stat-grid' }, statCards),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title', textContent: '测点清单' }),
        h('div', { class: 'chip-row' }, typeChips),
        table,
      ]),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title', textContent: this.selected ? `过程线 — ${this.selected.name}` : '过程线（选择测点查看）' }),
        this.chart.el,
      ]),
    ]);

    this.fillTable();
    if (this.selected) void this.loadChart(this.selected);
  }

  private fillTable(): void {
    mount(this.tableBody, []);
    const list = dataService.stations.filter((s) => this.filter === 'all' || s.type === this.filter);
    for (const s of list.slice(0, 220)) {
      const qcCell = h('td');
      // 同步快速统计（取缓存或延迟标记）
      void this.qualitySummary(s).then((txt) => (qcCell.textContent = txt));
      const row = h('tr', { class: this.selected?.id === s.id ? 'row-selected' : '' }, [
        h('td', { textContent: s.id }),
        h('td', { textContent: s.name }),
        h('td', { textContent: TYPE_LABEL[s.type] }),
        h('td', { textContent: `${s.monolithId}#` }),
        h('td', { textContent: String(s.elevation) }),
        h('td', { textContent: s.metrics.map((m) => METRIC_LABEL[m]).join('、') }),
        qcCell,
        h('td', {}, [
          h(
            'button',
            {
              class: 'btn btn-small',
              onclick: () => {
                this.selected = s;
                uiStore.set({ selectedStationId: s.id });
                this.render();
              },
            },
            ['过程线'],
          ),
          h(
            'button',
            {
              class: 'btn btn-small',
              onclick: () => uiStore.set({ page: 'scene3d', selectedStationId: s.id }),
            },
            ['三维定位'],
          ),
        ]),
      ]);
      this.tableBody.appendChild(row);
    }
    if (list.length > 220) {
      this.tableBody.appendChild(h('tr', {}, [h('td', { colSpan: 8, class: 'muted', textContent: `仅显示前 220 条，共 ${list.length} 条，可用类型筛选` })]));
    }
  }

  private async qualitySummary(s: Station): Promise<string> {
    let miss = 0;
    let spike = 0;
    let shift = 0;
    for (const m of s.metrics) {
      const se = await dataService.getSeries(s.id, m);
      for (let i = 0; i < se.quality.length; i++) {
        if (isMissing(se.quality[i])) miss++;
        if (isSpike(se.quality[i])) spike++;
        if (isDatumShift(se.quality[i])) shift++;
      }
    }
    const parts = [`缺测${miss}`];
    if (spike) parts.push(`跳变${spike}`);
    if (shift) parts.push(`基准变化${shift}`);
    return parts.join(' / ');
  }

  private async loadChart(s: Station): Promise<void> {
    const metric = s.metrics[0];
    const se = await dataService.getSeries(s.id, metric);
    const dates = Array.from({ length: se.count }, (_, i) => indexToDate(dataService.settings.startDate, i));
    const markers = [];
    for (let i = 0; i < se.quality.length; i++) {
      if (isSpike(se.quality[i])) markers.push({ index: i, color: '#f87171' });
      if (isDatumShift(se.quality[i])) markers.push({ index: i, color: '#fbbf24' });
    }
    this.chart.opts = { ...this.chart.opts, dates, markers, title: `${s.name} · ${METRIC_LABEL[metric]} (${METRIC_UNIT[metric]})` };
    this.chart.setSeries([
      { name: METRIC_LABEL[metric], values: se.values, color: '#38bdf8' },
      ...(se.trueValues ? [{ name: '模型真值', values: se.trueValues, color: '#64748b', dashed: true, width: 1 }] : []),
    ]);
  }
}
