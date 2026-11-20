/**
 * 异常预警页：测值/速率/模型残差三类阈值规则、扫描、记录确认处理留痕
 */
import { h, mount } from '../dom';
import { loadRules, saveRules, loadAlerts, updateAlertRecord } from '../../db/idb';
import { scanAlerts, DEFAULT_RULES } from '../../state/alerts';
import type { AlertRecord, AlertRule, AlertRuleType } from '../../types';
import { METRIC_LABEL, METRIC_UNIT } from '../../types';

const TYPE_NAME: Record<AlertRuleType, string> = {
  value: '测值阈值',
  rate: '变化速率',
  residual: '模型残差',
};
const LEVEL_NAME = { watch: '关注', warning: '预警', alarm: '报警' } as const;

export class AlertPage {
  readonly el: HTMLDivElement;
  private rules: AlertRule[] = [];
  private alerts: AlertRecord[] = [];
  private listBody!: HTMLTableSectionElement;
  private statusEl!: HTMLDivElement;

  constructor() {
    this.el = h('div', { class: 'page alert-page' });
  }

  async render(): Promise<void> {
    this.rules = (await loadRules()) ?? [];
    if (this.rules.length === 0) {
      this.rules = DEFAULT_RULES.map((r) => ({ ...r }));
      await saveRules(this.rules);
    }
    this.alerts = await loadAlerts();
    this.listBody = h('tbody') as HTMLTableSectionElement;
    this.statusEl = h('div', { class: 'batch-progress' });

    const ruleBody = h('tbody') as HTMLTableSectionElement;
    this.fillRuleRows(ruleBody);

    mount(this.el, [
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title-row' }, [
          h('div', { class: 'panel-title', textContent: '预警阈值规则（测值 / 速率 / 残差三类）' }),
          h('div', { class: 'row-actions' }, [
            h('button', { class: 'btn btn-primary', onclick: () => void this.runScan() }, ['全序列扫描预警']),
            h('button', { class: 'btn', onclick: () => void this.saveRuleEdits(ruleBody) }, ['保存规则修改']),
          ]),
        ]),
        h('div', { class: 'table-scroll' }, [
          h('table', { class: 'data-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { textContent: '类型' }),
                h('th', { textContent: '测项' }),
                h('th', { textContent: '级别' }),
                h('th', { textContent: '阈值' }),
                h('th', { textContent: '启用' }),
              ]),
            ]),
            ruleBody,
          ]),
        ]),
        this.statusEl,
      ]),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title-row' }, [
          h('div', { class: 'panel-title', textContent: `预警记录（${this.alerts.length} 条，超阈值测点在三维中闪烁）` }),
          h('div', { class: 'row-actions' }, [
            h('button', { class: 'btn btn-small', onclick: () => void this.filterList('open') }, ['待处理']),
            h('button', { class: 'btn btn-small', onclick: () => void this.filterList('all') }, ['全部']),
          ]),
        ]),
        h('div', { class: 'table-scroll tall' }, [
          h('table', { class: 'data-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { textContent: '日期' }),
                h('th', { textContent: '测点' }),
                h('th', { textContent: '测项' }),
                h('th', { textContent: '规则' }),
                h('th', { textContent: '级别' }),
                h('th', { textContent: '实测/阈值' }),
                h('th', { textContent: '说明' }),
                h('th', { textContent: '状态/处理' }),
              ]),
            ]),
            this.listBody,
          ]),
        ]),
      ]),
    ]);
    void this.filterList('open');
  }

  private fillRuleRows(body: HTMLTableSectionElement): void {
    mount(body, []);
    for (const rule of this.rules) {
      const thresholdInput = h('input', { type: 'number', step: '0.1', value: String(rule.threshold), class: 'input-mini', dataset: { rule: rule.id } }) as HTMLInputElement;
      const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
      enabled.checked = rule.enabled;
      enabled.dataset.ruleEnable = rule.id;
      body.appendChild(
        h('tr', {}, [
          h('td', { textContent: TYPE_NAME[rule.type] }),
          h('td', { textContent: METRIC_LABEL[rule.metric] }),
          h('td', {}, [h('span', { class: `level-tag level-${rule.level}`, textContent: LEVEL_NAME[rule.level] })]),
          h('td', {}, [thresholdInput, h('span', { class: 'muted', textContent: rule.type === 'rate' ? ' mm/d' : rule.type === 'residual' ? ' σ' : ` ${METRIC_UNIT[rule.metric]}` })]),
          h('td', {}, [enabled]),
        ]),
      );
    }
  }

  private async saveRuleEdits(body: HTMLTableSectionElement): Promise<void> {
    body.querySelectorAll<HTMLInputElement>('input[data-rule]').forEach((input) => {
      const rule = this.rules.find((r) => r.id === input.dataset.rule);
      if (rule) rule.threshold = Number(input.value);
    });
    body.querySelectorAll<HTMLInputElement>('input[data-rule-enable]').forEach((input) => {
      const rule = this.rules.find((r) => r.id === input.dataset.ruleEnable);
      if (rule) rule.enabled = input.checked;
    });
    await saveRules(this.rules);
    this.statusEl.textContent = '规则已保存，下次扫描生效。';
    this.statusEl.className = 'batch-progress summary-ok';
  }

  private async runScan(): Promise<void> {
    this.statusEl.className = 'batch-progress';
    this.statusEl.textContent = '正在扫描全序列…';
    await new Promise((r) => setTimeout(r, 30));
    this.alerts = await scanAlerts(this.rules);
    this.statusEl.textContent = `扫描完成，共生成 ${this.alerts.length} 条预警记录（开放 ${this.alerts.filter((a) => a.status === 'open').length} 条）。`;
    this.statusEl.className = 'batch-progress summary-ok';
    void this.filterList('open');
  }

  private async filterList(mode: 'open' | 'all'): Promise<void> {
    this.alerts = await loadAlerts();
    const list = mode === 'open' ? this.alerts.filter((a) => a.status !== 'handled') : this.alerts;
    mount(this.listBody, []);
    for (const a of list.slice(0, 400)) {
      const actionCell = h('td');
      if (a.status === 'open') {
        actionCell.appendChild(
          h('button', { class: 'btn btn-small btn-primary', onclick: () => void this.handle(a, 'confirmed') }, ['确认']),
        );
        actionCell.appendChild(
          h('button', { class: 'btn btn-small', onclick: () => void this.handle(a, 'handled') }, ['处理闭环']),
        );
      } else {
        actionCell.appendChild(h('span', { class: 'status-tag status-confirmed', textContent: a.status === 'confirmed' ? '已确认' : '已闭环' }));
        if (a.handleNote) actionCell.appendChild(h('div', { class: 'muted small', textContent: a.handleNote }));
      }
      this.listBody.appendChild(
        h('tr', { class: a.status === 'open' ? '' : 'row-dim' }, [
          h('td', { textContent: a.date }),
          h('td', { textContent: a.stationId }),
          h('td', { textContent: METRIC_LABEL[a.metric] }),
          h('td', { textContent: TYPE_NAME[a.ruleType] }),
          h('td', {}, [h('span', { class: `level-tag level-${a.level}`, textContent: LEVEL_NAME[a.level] })]),
          h('td', { textContent: `${a.value.toFixed(2)} / ${a.threshold.toFixed(2)}` }),
          h('td', { class: 'small', textContent: a.message }),
          actionCell,
        ]),
      );
    }
    if (list.length > 400) this.listBody.appendChild(h('tr', {}, [h('td', { colSpan: 8, class: 'muted', textContent: `仅显示前 400 条，共 ${list.length} 条` })]));
  }

  private async handle(a: AlertRecord, status: AlertRecord['status']): Promise<void> {
    const note = status === 'handled' ? window.prompt('请输入处理措施（留痕）', '现场核查，仪器工作正常，加强观测') ?? '' : '值班工程师确认';
    const updated: AlertRecord = {
      ...a,
      status,
      handledAt: new Date().toISOString().slice(0, 10),
      handledBy: '值班工程师',
      handleNote: note,
    };
    await updateAlertRecord(updated);
    this.alerts = this.alerts.map((x) => (x.id === a.id ? updated : x));
    void this.filterList('open');
  }
}
