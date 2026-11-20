/** 场值色带图例（与 WebGPU 1D ramp 同源） */
import { h } from './dom';
import { FIELD_RAMP } from '../render/color-ramp';

export function colorLegend(min: number, max: number, unit: string, title: string): HTMLElement {
  const stops = FIELD_RAMP.map((s) => `rgb(${s.rgb.join(',')}) ${s.t * 100}%`).join(',');
  const wrap = h('div', { class: 'legend-panel' }, [
    h('div', { class: 'legend-title', textContent: title }),
    h('div', { class: 'legend-bar', style: `background: linear-gradient(90deg, ${stops})` }),
    h('div', { class: 'legend-scale' }, [
      h('span', { textContent: `${min.toFixed(2)} ${unit}` }),
      h('span', { textContent: `${max.toFixed(2)} ${unit}` }),
    ]),
  ]);
  return wrap;
}
