/**
 * Canvas 自绘过程线图：支持多条序列、分量分色、3σ 异常点标注、游标联动
 */
import { h } from './dom';
import { FIELD_RAMP } from '../render/color-ramp';

export interface LineSeries {
  name: string;
  values: ArrayLike<number>;
  color: string;
  width?: number;
  dashed?: boolean;
}

export interface MarkerPoint {
  index: number;
  color: string;
  label?: string;
}

export interface LineChartOptions {
  title?: string;
  height?: number;
  yLabel?: string;
  dates?: string[];
  markers?: MarkerPoint[];
  onCursor?: (index: number) => void;
  band?: { from: number; to: number; color: string }[];
}

const SERIES_COLORS = ['#38bdf8', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#f87171'];

export class LineChart {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private series: LineSeries[] = [];
  opts: LineChartOptions;
  private cursor = -1;
  private count = 0;

  constructor(opts: LineChartOptions = {}) {
    this.opts = opts;
    this.el = h('div', { class: 'chart-wrap' });
    this.canvas = h('canvas', { class: 'chart-canvas' });
    this.canvas.style.height = `${opts.height ?? 240}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.el.appendChild(this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons === 1) this.onPointer(e);
    });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  private onPointer(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - 46;
    const idx = Math.round((x / Math.max(1, rect.width - 64)) * (this.count - 1));
    this.cursor = Math.max(0, Math.min(this.count - 1, idx));
    this.opts.onCursor?.(this.cursor);
    this.draw();
  }

  setCursor(index: number): void {
    this.cursor = index;
    this.draw();
  }

  setSeries(series: LineSeries[]): void {
    this.series = series.map((s, i) => ({ ...s, color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }));
    this.count = Math.max(0, ...series.map((s) => s.values.length));
    this.draw();
  }

  setMarkers(markers: MarkerPoint[]): void {
    this.opts = { ...this.opts, markers };
    this.draw();
  }

  legend(): HTMLElement {
    const wrap = h('div', { class: 'chart-legend' });
    for (const s of this.series) {
      wrap.appendChild(
        h('span', { class: 'legend-item' }, [
          h('i', { style: `background:${s.color}` }),
          `${s.name}`,
        ]),
      );
    }
    return wrap;
  }

  private draw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.el.clientWidth || 600;
    const hgt = this.opts.height ?? 240;
    this.canvas.width = w * dpr;
    this.canvas.height = hgt * dpr;
    this.canvas.style.width = `${w}px`;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (this.count === 0) {
      ctx.fillStyle = '#7c8aa0';
      ctx.font = '13px sans-serif';
      ctx.fillText('暂无数据', w / 2 - 30, hgt / 2);
      return;
    }

    const padL = 46;
    const padR = 18;
    const padT = this.opts.title ? 26 : 10;
    const padB = 26;
    const plotW = w - padL - padR;
    const plotH = hgt - padT - padB;

    let yMin = Infinity;
    let yMax = -Infinity;
    for (const s of this.series) {
      for (let i = 0; i < s.values.length; i++) {
        const v = s.values[i];
        if (Number.isFinite(v)) {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (!Number.isFinite(yMin)) {
      yMin = -1;
      yMax = 1;
    }
    if (yMax - yMin < 1e-6) {
      yMin -= 1;
      yMax += 1;
    }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad;
    yMax += pad;

    // 背景带
    for (const b of this.opts.band ?? []) {
      const x0 = padL + (b.from / (this.count - 1)) * plotW;
      const x1 = padL + (b.to / (this.count - 1)) * plotW;
      ctx.fillStyle = b.color;
      ctx.fillRect(x0, padT, x1 - x0, plotH);
    }

    // 网格与坐标
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.fillStyle = '#8da0b8';
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = padT + (plotH * g) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      const val = yMax - ((yMax - yMin) * g) / 4;
      ctx.fillText(val.toFixed(1), 6, y + 4);
    }
    const tickCount = 6;
    for (let g = 0; g <= tickCount; g++) {
      const idx = Math.round(((this.count - 1) * g) / tickCount);
      const x = padL + (plotW * g) / tickCount;
      const date = this.opts.dates?.[idx] ?? `${idx}`;
      ctx.fillText(date.slice(0, 7), x - 22, hgt - 8);
    }

    const xOf = (i: number) => padL + (i / (this.count - 1)) * plotW;
    const yOf = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // 序列
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.4;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < s.values.length; i++) {
        const v = s.values[i];
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        const x = xOf(i);
        const y = yOf(v);
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 异常/事件标记
    for (const m of this.opts.markers ?? []) {
      if (m.index < 0 || m.index >= this.count) continue;
      const x = xOf(m.index);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(x, padT + 4, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 游标
    if (this.cursor >= 0) {
      const x = xOf(this.cursor);
      ctx.strokeStyle = 'rgba(226,232,240,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = '#e2e8f0';
      const date = this.opts.dates?.[this.cursor] ?? '';
      ctx.fillText(date, Math.min(x + 6, w - 90), padT + 12);
      let li = 0;
      for (const s of this.series) {
        const v = s.values[this.cursor];
        if (Number.isFinite(v)) {
          ctx.fillStyle = s.color;
          ctx.fillText(`${s.name}: ${v.toFixed(2)}`, Math.min(x + 6, w - 130), padT + 26 + li * 14);
          li++;
        }
      }
    }

    if (this.opts.title) {
      ctx.fillStyle = '#cbd5e1';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(this.opts.title, padL, 16);
    }
    if (this.opts.yLabel) {
      ctx.save();
      ctx.fillStyle = '#8da0b8';
      ctx.font = '11px sans-serif';
      ctx.translate(12, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(this.opts.yLabel, -20, 0);
      ctx.restore();
    }
  }
}

export { SERIES_COLORS, FIELD_RAMP };
