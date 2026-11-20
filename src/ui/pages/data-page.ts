/**
 * 数据管理页：多格式导入、质检事件台账、基准变化人工确认接边、缺测插补
 */
import { h, mount } from '../dom';
import { dataService } from '../../state/data-service';
import { parseImport, buildSampleFile, type ParseResult } from '../../core/importer';
import { runQualityCheck, spliceDatumShift, fillMissing } from '../../core/quality';
import { loadEvents, updateEvent, saveSeries, loadSeries } from '../../db/idb';
import { dateToIndex, indexToDate } from '../../core/dates';
import type { DataEvent, MetricKey } from '../../types';

export class DataPage {
  readonly el: HTMLDivElement;
  private listEl!: HTMLTableSectionElement;
  private events: DataEvent[] = [];
  private logEl!: HTMLDivElement;

  constructor() {
    this.el = h('div', { class: 'page data-page' });
  }

  render(): void {
    const formats: { id: ParseResult['format']; name: string; desc: string }[] = [
      { id: 'A-long-csv', name: '长表 CSV', desc: '日期,测点,测值,质量码,测项' },
      { id: 'B-wide-csv', name: '宽表 CSV', desc: '日期 + 多测点列' },
      { id: 'C-txt', name: '空白分隔 TXT', desc: '自动化系统导出' },
      { id: 'D-json', name: 'JSON', desc: '结构化记录数组' },
    ];
    const fileInput = h('input', { type: 'file', accept: '.csv,.txt,.json', style: 'display:none' }) as HTMLInputElement;
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) void this.importFile(f);
    });

    this.listEl = h('tbody') as HTMLTableSectionElement;
    this.logEl = h('div', { class: 'import-log' });

    mount(this.el, [
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title', textContent: '数据导入（兼容多厂家自动化系统导出格式）' }),
        h('div', { class: 'format-grid' }, [
          ...formats.map((f) =>
            h('div', { class: 'format-card' }, [
              h('div', { class: 'format-name', textContent: f.name }),
              h('div', { class: 'format-desc muted', textContent: f.desc }),
              h('div', { class: 'format-actions' }, [
                h(
                  'button',
                  { class: 'btn btn-small', onclick: () => this.downloadSample(f.id) },
                  ['下载样例'],
                ),
              ]),
            ]),
          ),
          h('div', { class: 'format-card import-card' }, [
            h('div', { class: 'format-name', textContent: '上传数据文件' }),
            h('div', { class: 'format-desc muted', textContent: '自动识别格式并执行质检' }),
            h('div', { class: 'format-actions' }, [
              h('button', { class: 'btn btn-primary btn-small', onclick: () => fileInput.click() }, ['选择文件']),
              fileInput,
            ]),
          ]),
        ]),
        this.logEl,
      ]),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title-row' }, [
          h('div', { class: 'panel-title', textContent: '质检事件台账（缺测 / 跳变 / 基准变化）' }),
          h('button', { class: 'btn btn-small', onclick: () => void this.refresh() }, ['刷新']),
        ]),
        h('div', { class: 'table-scroll tall' }, [
          h('table', { class: 'data-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { textContent: '日期' }),
                h('th', { textContent: '测点' }),
                h('th', { textContent: '测项' }),
                h('th', { textContent: '类型' }),
                h('th', { textContent: '说明' }),
                h('th', { textContent: '状态' }),
                h('th', { textContent: '操作' }),
              ]),
            ]),
            this.listEl,
          ]),
        ]),
      ]),
    ]);
    void this.refresh();
  }

  private downloadSample(format: ParseResult['format']): void {
    const ext = format === 'D-json' ? 'json' : format === 'C-txt' ? 'txt' : 'csv';
    const blob = new Blob([buildSampleFile(format)], { type: 'text/plain;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `导入样例.${ext}` }) as HTMLAnchorElement;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private async importFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = parseImport(text, file.name);
      // 按测点/测项归并写入序列（仅对系统中已存在的测点生效，其余告警）
      const grouped = new Map<string, { metric: MetricKey; rows: typeof parsed.rows }>();
      let skipped = 0;
      for (const row of parsed.rows) {
        const station = dataService.stations.find((s) => s.id === row.stationId);
        if (!station || !station.metrics.includes(row.metric)) {
          skipped++;
          continue;
        }
        const key = `${row.stationId}|${row.metric}`;
        const g = grouped.get(key) ?? { metric: row.metric, rows: [] };
        g.rows.push(row);
        grouped.set(key, g);
      }
      let eventCount = 0;
      for (const [key, g] of grouped) {
        const [stationId, metric] = key.split('|');
        const rec = await loadSeries(key);
        if (!rec) continue;
        const values = new Float32Array(rec.values);
        for (const row of g.rows) {
          const idx = dateToIndex(rec.startDate, row.date);
          if (idx >= 0 && idx < values.length) values[idx] = row.value;
        }
        const qc = runQualityCheck(stationId, g.metric, values, rec.startDate, new Uint8Array(rec.quality));
        await saveSeries({ ...rec, values: values.buffer as ArrayBuffer, quality: qc.quality.buffer as ArrayBuffer });
        for (const e of qc.events) await updateEvent(e);
        eventCount += qc.events.length;
      }
      this.log(`解析格式：${parsed.format}，记录 ${parsed.rows.length} 条，匹配入库 ${grouped.size} 个序列，识别事件 ${eventCount} 个${skipped ? `，未知测点跳过 ${skipped} 条` : ''}`, 'ok');
      if (parsed.warnings.length) this.log(parsed.warnings.join('；'), 'warn');
      await this.refresh();
    } catch (err) {
      this.log(`导入失败：${(err as Error).message}`, 'err');
    }
  }

  private async refresh(): Promise<void> {
    this.events = (await loadEvents()).sort((a, b) => b.index - a.index);
    mount(this.listEl, []);
    const kindLabel: Record<DataEvent['kind'], string> = {
      missing: '缺测',
      spike: '跳变',
      'datum-shift': '基准变化',
    };
    for (const e of this.events.slice(0, 300)) {
      const actions = h('td');
      if (e.kind === 'datum-shift' && e.status === 'pending') {
        actions.appendChild(
          h('button', { class: 'btn btn-small btn-primary', onclick: () => void this.confirmShift(e) }, ['确认接边']),
        );
        actions.appendChild(
          h('button', { class: 'btn btn-small', onclick: () => void this.ignoreEvent(e) }, ['忽略']),
        );
      } else if (e.kind === 'spike' && e.status === 'pending') {
        actions.appendChild(
          h('button', { class: 'btn btn-small', onclick: () => void this.interpolateOne(e) }, ['邻值替换']),
        );
        actions.appendChild(
          h('button', { class: 'btn btn-small', onclick: () => void this.ignoreEvent(e) }, ['忽略']),
        );
      } else if (e.kind === 'missing' && e.status === 'pending') {
        actions.appendChild(
          h('button', { class: 'btn btn-small', onclick: () => void this.fillOne(e) }, ['线性插补']),
        );
      } else {
        actions.appendChild(h('span', { class: `status-tag status-${e.status}`, textContent: e.status === 'confirmed' ? '已处理' : '已忽略' }));
      }
      this.listEl.appendChild(
        h('tr', { class: e.status === 'pending' ? '' : 'row-dim' }, [
          h('td', { textContent: e.date }),
          h('td', { textContent: e.stationId }),
          h('td', { textContent: e.metric }),
          h('td', {}, [h('span', { class: `kind-tag kind-${e.kind}`, textContent: kindLabel[e.kind] })]),
          h('td', { textContent: e.detail }),
          h('td', { textContent: e.status === 'pending' ? '待处理' : e.status === 'confirmed' ? '已确认' : '已忽略' }),
          actions,
        ]),
      );
    }
    if (this.events.length > 300) {
      this.listEl.appendChild(h('tr', {}, [h('td', { colSpan: 7, class: 'muted', textContent: `仅显示最近 300 条，共 ${this.events.length} 条事件` })]));
    }
  }

  /** 人工确认基准变化：整段平移接边并留痕 */
  private async confirmShift(e: DataEvent): Promise<void> {
    const key = `${e.stationId}|${e.metric}`;
    const rec = (await loadSeries(key))!;
    const values = new Float32Array(rec.values);
    const quality = new Uint8Array(rec.quality);
    const offset = e.offset ?? 0;
    const fixed = spliceDatumShift(values, quality, e.index, offset);
    await saveSeries({ ...rec, values: fixed.values.buffer as ArrayBuffer, quality: fixed.quality.buffer as ArrayBuffer });
    await updateEvent({ ...e, status: 'confirmed', handledAt: indexToDate(dataService.settings.startDate, dataService.settings.days - 1), handledBy: '值班工程师' });
    this.log(`基准变化已确认接边：${e.stationId} ${e.date}，平移修正 ${offset.toFixed(2)}`, 'ok');
    await this.refresh();
  }

  private async ignoreEvent(e: DataEvent): Promise<void> {
    await updateEvent({ ...e, status: 'ignored', handledBy: '值班工程师' });
    await this.refresh();
  }

  private async interpolateOne(e: DataEvent): Promise<void> {
    const key = `${e.stationId}|${e.metric}`;
    const rec = (await loadSeries(key))!;
    const values = new Float32Array(rec.values);
    const lo = values[e.index - 1];
    const hi = values[e.index + 1];
    if (Number.isFinite(lo) && Number.isFinite(hi)) values[e.index] = (lo + hi) / 2;
    const quality = new Uint8Array(rec.quality);
    quality[e.index] = quality[e.index] & ~2 | 16;
    await saveSeries({ ...rec, values: values.buffer as ArrayBuffer, quality: quality.buffer as ArrayBuffer });
    await updateEvent({ ...e, status: 'confirmed', handledBy: '值班工程师' });
    await this.refresh();
  }

  private async fillOne(e: DataEvent): Promise<void> {
    const key = `${e.stationId}|${e.metric}`;
    const rec = (await loadSeries(key))!;
    const values = fillMissing(new Float32Array(rec.values), new Uint8Array(rec.quality));
    const quality = new Uint8Array(rec.quality);
    quality[e.index] |= 16;
    await saveSeries({ ...rec, values: values.buffer as ArrayBuffer, quality: quality.buffer as ArrayBuffer });
    await updateEvent({ ...e, status: 'confirmed', handledBy: '值班工程师' });
    this.log(`已对 ${e.stationId} 自 ${e.date} 起的缺测段做线性插补`, 'ok');
    await this.refresh();
  }

  private log(msg: string, level: 'ok' | 'warn' | 'err'): void {
    this.logEl.appendChild(h('div', { class: `log-line log-${level}`, textContent: `[${new Date().toLocaleTimeString()}] ${msg}` }));
  }
}
