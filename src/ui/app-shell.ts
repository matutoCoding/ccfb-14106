/** 应用外壳：侧边导航 + 页面容器 + 全局时间轴 + 初始化引导 */
import { h, mount } from './dom';
import { uiStore, type PageId } from '../state/ui';
import { Timeline } from './timeline';
import { OverviewPage } from './pages/overview-page';
import { DataPage } from './pages/data-page';
import { ModelPage } from './pages/model-page';
import { ScenePage } from './pages/scene-page';
import { SectionPage } from './pages/section-page';
import { AlertPage } from './pages/alert-page';
import { reportYears, monthPeriods, yearPeriod, exportStatReport, exportDistributionMap } from '../state/reports';
import { METRIC_LABEL, METRIC_UNIT, type MetricKey } from '../types';
import { dataService } from '../state/data-service';

const NAV: { id: PageId; name: string; icon: string }[] = [
  { id: 'overview', name: '工程测点', icon: '🏗' },
  { id: 'data', name: '数据管理', icon: '🗂' },
  { id: 'model', name: '统计模型', icon: '∑' },
  { id: 'scene3d', name: '三维变形', icon: '🧊' },
  { id: 'section', name: '剖面分析', icon: '📐' },
  { id: 'alert', name: '异常预警', icon: '🚨' },
];

export class AppShell {
  readonly el: HTMLDivElement;
  private pageHost!: HTMLDivElement;
  private timeline = new Timeline();
  private pages: Partial<Record<PageId, { render(): void; el: HTMLElement; dispose?(): void }>> = {};

  constructor() {
    this.el = h('div', { class: 'app-shell' });
  }

  render(): void {
    const nav = h('nav', { class: 'side-nav' }, [
      h('div', { class: 'brand' }, [h('div', { class: 'brand-title', textContent: '拱坝安全监测' }), h('div', { class: 'brand-sub', textContent: '三维变形分析系统' })]),
      ...NAV.map((n) => {
        const btn = h('button', { class: `nav-item ${uiStore.get().page === n.id ? 'nav-active' : ''}`, dataset: { page: n.id }, onclick: () => this.goto(n.id) }, [
          h('span', { class: 'nav-icon', textContent: n.icon }),
          h('span', { textContent: n.name }),
        ]);
        return btn;
      }),
      this.reportMenu(),
    ]);

    this.pageHost = h('div', { class: 'page-host' });
    mount(this.el, [nav, h('div', { class: 'main-area' }, [this.pageHost, this.timeline.el])]);

    uiStore.subscribe((s) => {
      nav.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((b) => b.classList.toggle('nav-active', b.dataset.page === s.page));
    });
    this.goto(uiStore.get().page);
  }

  private reportMenu(): HTMLElement {
    const years = reportYears();
    const metricSel = h(
      'select',
      { class: 'select select-mini' },
      (['radial', 'tangential', 'opening'] as MetricKey[]).map((m) => h('option', { value: m, textContent: METRIC_LABEL[m] })),
    ) as HTMLSelectElement;
    const yearSel = h('select', { class: 'select select-mini' }, years.map((y) => h('option', { value: String(y), textContent: `${y} 年` }))) as HTMLSelectElement;
    yearSel.value = String(years[years.length - 1]);

    const doExport = async (kind: 'month-stat' | 'year-stat' | 'year-map') => {
      const year = Number(yearSel.value);
      const metric = metricSel.value as MetricKey;
      if (kind === 'month-stat') {
        for (const p of monthPeriods(year, dataService.settings)) await exportStatReport(p, metric);
      } else if (kind === 'year-stat') {
        await exportStatReport(yearPeriod(year, dataService.settings), metric);
      } else {
        await exportDistributionMap(yearPeriod(year, dataService.settings), metric);
      }
    };

    return h('div', { class: 'report-menu' }, [
      h('div', { class: 'nav-section-title', textContent: '月报年报导出' }),
      yearSel,
      metricSel,
      h('button', { class: 'btn btn-small', onclick: () => void doExport('month-stat') }, ['月统计表(12期)']),
      h('button', { class: 'btn btn-small', onclick: () => void doExport('year-stat') }, ['年度统计表']),
      h('button', { class: 'btn btn-small', onclick: () => void doExport('year-map') }, ['变形分布图PNG']),
      h('div', { class: 'nav-hint muted', textContent: `单位: ${METRIC_UNIT[metricSel.value as MetricKey]}` }),
    ]);
  }

  private goto(page: PageId): void {
    uiStore.set({ page });
    // 离开其他页面时清理其持有的定时器等资源
    for (const [id, inst] of Object.entries(this.pages)) {
      if (id !== page) inst.dispose?.();
    }
    let instance = this.pages[page];
    if (!instance) {
      instance = this.createPage(page);
      this.pages[page] = instance;
    }
    mount(this.pageHost, []);
    this.pageHost.appendChild(instance.el);
    instance.render();
    this.pageHost.scrollTop = 0;
  }

  private createPage(page: PageId): { render(): void; el: HTMLElement } {
    switch (page) {
      case 'overview':
        return new OverviewPage();
      case 'data':
        return new DataPage();
      case 'model':
        return new ModelPage();
      case 'scene3d':
        return new ScenePage();
      case 'section':
        return new SectionPage();
      case 'alert':
        return new AlertPage();
    }
  }
}
