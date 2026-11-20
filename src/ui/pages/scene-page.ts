/**
 * 三维变形页：WebGPU 画布 + 显示控制面板 + 时间轴联动
 */
import { h, mount } from '../dom';
import { uiStore, COMPONENT_LABEL, type ComponentMode } from '../../state/ui';
import { SceneController } from '../../state/scene-controller';
import { colorLegend } from '../legend';
import { METRIC_LABEL, METRIC_UNIT, type MetricKey, type Station } from '../../types';
import { dataService } from '../../state/data-service';
import { modelManager } from '../../state/model-manager';

let sharedController: SceneController | null = null;

export class ScenePage {
  readonly el: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private legendHost!: HTMLDivElement;
  private legendTimer = 0;
  private started = false;

  constructor() {
    this.el = h('div', { class: 'page scene-page' });
  }

  render(): void {
    this.canvas = h('canvas', { class: 'gpu-canvas' });
    this.legendHost = h('div', { class: 'legend-host' });

    const metricOptions: MetricKey[] = ['radial', 'tangential', 'vertical', 'opening'];
    const modes: ComponentMode[] = ['total', 'hydro', 'thermal', 'aging', 'residual'];

    const controlPanel = h('div', { class: 'control-panel' }, [
      h('div', { class: 'panel-title', textContent: '显示控制' }),
      this.metricGroup(metricOptions),
      h('div', { class: 'ctrl-label', textContent: '分量锁定' }),
      h(
        'div',
        { class: 'btn-row' },
        modes.map((m) =>
          h(
            'button',
            {
              class: `btn btn-small ${uiStore.get().componentMode === m ? 'btn-primary' : ''}`,
              dataset: { mode: m },
              onclick: () => uiStore.set({ componentMode: m }),
            },
            [COMPONENT_LABEL[m]],
          ),
        ),
      ),
      this.sliderRow('变形放大倍数', 'exaggeration', 0, 300, 1, (v) => `${v}×`),
      this.toggleRow('位移等值线', 'showContours'),
      this.toggleRow('矢量箭头', 'showVectors'),
      this.toggleRow('原始轮廓影子', 'showShadow'),
      this.toggleRow('廊道系统', 'showGalleries'),
      this.toggleRow('库水面', 'showWater'),
      this.toggleRow('预警闪烁', 'showAlerts'),
      h('div', { class: 'ctrl-hint muted', textContent: '左键旋转 · Shift/右键平移 · 滚轮缩放 · 点击测点查看' }),
    ]);

    mount(this.el, [
      h('div', { class: 'scene-layout' }, [
        h('div', { class: 'canvas-host' }, [this.canvas, this.legendHost]),
        controlPanel,
      ]),
    ]);

    uiStore.subscribe((s) => {
      controlPanel.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
        b.classList.toggle('btn-primary', b.dataset.mode === s.componentMode);
      });
    });

    void this.boot();
  }

  private metricGroup(metrics: MetricKey[]): HTMLElement {
    return h(
      'div',
      { class: 'btn-row' },
      metrics.map((m) =>
        h(
          'button',
          {
            class: `btn btn-small ${uiStore.get().metric === m ? 'btn-primary' : ''}`,
            onclick: () => uiStore.set({ metric: m }),
          },
          [METRIC_LABEL[m]],
        ),
      ),
    );
  }

  private sliderRow(labelText: string, key: 'exaggeration', min: number, max: number, step: number, fmt: (v: number) => string): HTMLElement {
    const valueLabel = h('span', { class: 'slider-value', textContent: fmt(uiStore.get()[key]) });
    const slider = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), class: 'ctrl-slider' }) as HTMLInputElement;
    slider.value = String(uiStore.get()[key]);
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      uiStore.set({ [key]: v } as never);
      valueLabel.textContent = fmt(v);
    });
    return h('div', { class: 'ctrl-block' }, [h('div', { class: 'ctrl-label' }, [labelText, valueLabel]), slider]);
  }

  private toggleRow(labelText: string, key: 'showContours' | 'showVectors' | 'showShadow' | 'showGalleries' | 'showWater' | 'showAlerts'): HTMLElement {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = uiStore.get()[key] as boolean;
    input.addEventListener('change', () => uiStore.set({ [key]: input.checked } as never));
    return h('label', { class: 'toggle-row' }, [input, labelText]);
  }

  private async boot(): Promise<void> {
    if (!sharedController) {
      sharedController = new SceneController();
      try {
        await sharedController.init(this.canvas);
        await dataService.preloadDisplacement();
        sharedController.onPick = (station: Station) => {
          uiStore.set({ selectedStationId: station.id, page: 'overview' });
        };
      } catch (err) {
        mount(this.el, [
          h('div', { class: 'gpu-error' }, [
            h('h3', { textContent: 'WebGPU 初始化失败' }),
            h('p', { textContent: (err as Error).message }),
            h('p', { class: 'muted', textContent: '请使用 Chrome/Edge 113+ 或 Safari 18+，并确认硬件加速已开启。' }),
          ]),
        ]);
        return;
      }
    } else {
      // 页面重进：canvas 已重建，重绑上下文但复用 GPU 资源，避免泄漏
      sharedController.renderer.reattachCanvas(this.canvas);
    }
    if (!this.started) {
      sharedController.start();
      this.started = true;
      this.startLegendUpdate();
    }
  }

  private startLegendUpdate(): void {
    const update = () => {
      if (!this.el.isConnected) {
        this.legendTimer = window.setTimeout(update, 800);
        return;
      }
      const s = uiStore.get();
      const vals = modelManager.valuesAt(s.metric, s.timeIndex, s.componentMode);
      const finite: number[] = [];
      for (const v of vals) if (Number.isFinite(v)) finite.push(v);
      if (finite.length) {
        const min = Math.min(...finite);
        const max = Math.max(...finite);
        mount(this.legendHost, [colorLegend(min, max, METRIC_UNIT[s.metric], `${METRIC_LABEL[s.metric]} · ${COMPONENT_LABEL[s.componentMode]}`)]);
      }
      this.legendTimer = window.setTimeout(update, 700);
    };
    this.legendTimer = window.setTimeout(update, 300);
  }

  /** 离开页面时清理定时器，避免泄漏 */
  dispose(): void {
    if (this.legendTimer) {
      clearTimeout(this.legendTimer);
      this.legendTimer = 0;
    }
  }
}
