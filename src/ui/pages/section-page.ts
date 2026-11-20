/**
 * 剖面分析页：选坝段切剖面，渗压计测值插值浸润线，
 * 扬压力分布与设计扬压力图（防渗帷幕折减 + 排水孔骤降）叠加对比
 */
import { h, mount } from '../dom';
import { dataService } from '../../state/data-service';
import { uiStore } from '../../state/ui';
import {
  DAM_PARAMS,
  archSurfacePoint,
  damThickness,
  monolithCenterU,
} from '../../core/dam/params';
import type { Station } from '../../types';

export class SectionPage {
  readonly el: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private monolith = uiStore.get().selectedMonolith;

  constructor() {
    this.el = h('div', { class: 'page section-page' });
  }

  render(): void {
    this.canvas = h('canvas', { class: 'section-canvas' });
    const selector = h(
      'select',
      {
        class: 'select',
        onchange: (e) => {
          this.monolith = Number((e.target as HTMLSelectElement).value);
          uiStore.set({ selectedMonolith: this.monolith });
          this.draw();
        },
      },
      Array.from({ length: DAM_PARAMS.monolithCount }, (_, i) =>
        h('option', { value: String(i + 1), textContent: `${i + 1}# 坝段剖面` }),
      ),
    ) as HTMLSelectElement;
    selector.value = String(this.monolith);

    const exportBtn = h('button', { class: 'btn', onclick: () => this.exportPng() }, ['导出剖面图 PNG']);

    mount(this.el, [
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-title-row' }, [
          h('div', { class: 'panel-title', textContent: '坝段剖面 · 浸润线与扬压力分析' }),
          h('div', { class: 'row-actions' }, [selector, exportBtn]),
        ]),
        h('div', { class: 'section-host' }, [this.canvas]),
        h('div', { class: 'section-legend muted' }, [
          '蓝线：实测渗压水头插值浸润线　红虚线：设计扬压力（帷幕折减+排水孔骤降）　蓝点：剖面内渗压计　阴影：坝体断面',
        ]),
      ]),
      this.buildPiezoTable(),
    ]);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    setTimeout(() => this.draw(), 50);
  }

  /** 取该坝段 ±1 个坝段范围内的渗压计 */
  private piezoStations(): Station[] {
    return dataService.stations
      .filter((s) => s.type === 'piezometer' && Math.abs(s.monolithId - this.monolith) <= 1)
      .sort((a, b) => a.elevation - b.elevation);
  }

  private buildPiezoTable(): HTMLElement {
    const body = h('tbody') as HTMLTableSectionElement;
    const idx = uiStore.get().timeIndex;
    const stations = this.piezoStations();
    for (const s of stations) {
      const se = dataService.peekSeries(s.id, 'head');
      const v = se?.values[idx];
      body.appendChild(
        h('tr', {}, [
          h('td', { textContent: s.id }),
          h('td', { textContent: `${s.elevation}` }),
          h('td', { textContent: `${s.monolithId}#` }),
          h('td', { textContent: v != null && Number.isFinite(v) ? v.toFixed(2) : '缺测' }),
        ]),
      );
    }
    return h('div', { class: 'panel' }, [
      h('div', { class: 'panel-title', textContent: '剖面渗压计当前测值（水头 m）' }),
      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'data-table' }, [
          h('thead', {}, [h('tr', {}, [h('th', { textContent: '编号' }), h('th', { textContent: '高程(m)' }), h('th', { textContent: '坝段' }), h('th', { textContent: '当前水头(m)' })])]),
          body,
        ]),
      ]),
    ]);
  }

  private draw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 900;
    const hgt = 520;
    this.canvas.width = w * dpr;
    this.canvas.height = hgt * dpr;
    this.canvas.style.height = `${hgt}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    const { baseElev, crestElev } = DAM_PARAMS;
    const u = monolithCenterU(this.monolith);
    const layers = 26;
    // 断面轮廓（拱冠梁法近似：取该坝段中线的上/下游面）
    const up: [number, number][] = [];
    const dn: [number, number][] = [];
    for (let i = 0; i <= layers; i++) {
      const elev = baseElev + ((crestElev - baseElev) * i) / layers;
      up.push([archSurfacePoint(elev, u, -1).z, elev]);
      dn.push([archSurfacePoint(elev, u, 1).z, elev]);
    }
    const allZ = [...up.map((p) => p[0]), ...dn.map((p) => p[0])];
    const zMin = Math.min(...allZ) - 30;
    const zMax = Math.max(...allZ) + 30;
    const padL = 56;
    const padB = 44;
    const padT = 24;
    const plotW = w - padL - 30;
    const plotH = hgt - padT - padB;
    const xOf = (z: number) => padL + ((z - zMin) / (zMax - zMin)) * plotW;
    const yOf = (elev: number) => padT + (1 - (elev - baseElev + 12) / (crestElev - baseElev + 24)) * plotH;

    // 网格
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.fillStyle = '#8da0b8';
    ctx.font = '11px sans-serif';
    for (let e = baseElev; e <= crestElev; e += 25) {
      const y = yOf(e);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - 30, y);
      ctx.stroke();
      ctx.fillText(`${e}m`, 8, y + 4);
    }

    // 坝体断面
    ctx.beginPath();
    up.forEach(([z, e], i) => (i === 0 ? ctx.moveTo(xOf(z), yOf(e)) : ctx.lineTo(xOf(z), yOf(e))));
    [...dn].reverse().forEach(([z, e]) => ctx.lineTo(xOf(z), yOf(e)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,134,156,0.28)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(203,213,225,0.7)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 库水位线
    const idx = uiStore.get().timeIndex;
    const level = dataService.getEnv().waterLevel[idx];
    const upZ = up[Math.min(layers, Math.max(0, Math.round(((level - baseElev) / (crestElev - baseElev)) * layers)))][0];
    ctx.strokeStyle = 'rgba(56,189,248,0.8)';
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(xOf(zMin), yOf(level));
    ctx.lineTo(xOf(upZ), yOf(level));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`库水位 ${level.toFixed(1)}m`, padL + 8, yOf(level) - 6);

    // 设计扬压力包络：上游面全水头 → 帷幕后 0.55H → 排水孔后 0.25H → 下游面 0
    const head = Math.max(0, level - baseElev);
    const thickness = damThickness(baseElev + 4);
    const upBase = archSurfacePoint(baseElev + 4, u, -1);
    const dnBase = archSurfacePoint(baseElev + 4, u, 1);
    const designPts: [number, number][] = [
      [upBase.z, level],
      [upBase.z + thickness * 0.18, baseElev + head * 0.55],
      [upBase.z + thickness * 0.34, baseElev + head * 0.25],
      [dnBase.z, baseElev + head * 0.05],
    ];
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    designPts.forEach(([z, e], i) => (i === 0 ? ctx.moveTo(xOf(z), yOf(e)) : ctx.lineTo(xOf(z), yOf(e))));
    ctx.stroke();
    ctx.setLineDash([]);

    // 实测浸润线：渗压计测值按高程插值（IDW 简化为分段线性）
    const stations = this.piezoStations();
    const measured: [number, number][] = [];
    for (const s of stations) {
      const se = dataService.peekSeries(s.id, 'head');
      const v = se?.values[idx];
      if (v != null && Number.isFinite(v)) measured.push([s.position.z, baseElev + v]);
    }
    measured.sort((a, b) => a[1] - b[1]);
    if (measured.length >= 2) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      measured.forEach(([z, e], i) => (i === 0 ? ctx.moveTo(xOf(z), yOf(e)) : ctx.lineTo(xOf(z), yOf(e))));
      ctx.stroke();
    }
    // 渗压计点位
    for (const s of stations) {
      const se = dataService.peekSeries(s.id, 'head');
      const v = se?.values[idx];
      ctx.fillStyle = v != null && Number.isFinite(v) ? '#38bdf8' : '#64748b';
      ctx.beginPath();
      ctx.arc(xOf(s.position.z), yOf(s.elevation), 4, 0, Math.PI * 2);
      ctx.fill();
      if (v != null && Number.isFinite(v)) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '10px sans-serif';
        ctx.fillText(`${(baseElev + v).toFixed(1)}`, xOf(s.position.z) + 6, yOf(s.elevation) - 4);
      }
    }

    // 标题与坐标
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`${this.monolith}# 坝段剖面图（径向位置 z，单位 m）`, padL, 16);
    ctx.fillStyle = '#8da0b8';
    ctx.font = '11px sans-serif';
    for (let i = 0; i <= 6; i++) {
      const z = zMin + ((zMax - zMin) * i) / 6;
      ctx.fillText(z.toFixed(0), padL + (plotW * i) / 6 - 10, hgt - padB + 18);
    }
  }

  private exportPng(): void {
    const a = h('a', { href: this.canvas.toDataURL('image/png'), download: `${this.monolith}号坝段剖面图.png` }) as HTMLAnchorElement;
    a.click();
  }
}
