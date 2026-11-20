/** 全局时间轴：拖拽滑块、播放/暂停、倍速、当前库水位与气温读数 */
import { h } from './dom';
import { uiStore } from '../state/ui';
import { dataService } from '../state/data-service';
import { indexToDate } from '../core/dates';

export class Timeline {
  readonly el: HTMLDivElement;
  private slider!: HTMLInputElement;
  private dateLabel!: HTMLSpanElement;
  private envLabel!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  private timer: number | null = null;

  constructor() {
    const { settings } = dataService;
    this.el = h('div', { class: 'timeline' });
    this.playBtn = h('button', {
      class: 'btn btn-primary',
      textContent: '▶ 播放',
      onclick: () => this.togglePlay(),
    });
    this.slider = h('input', {
      type: 'range',
      min: '0',
      max: String(settings.days - 1),
      value: '0',
      class: 'time-slider',
    }) as HTMLInputElement;
    this.slider.addEventListener('input', () => {
      uiStore.set({ timeIndex: Number(this.slider.value), playing: false });
      this.stopTimer();
      this.playBtn.textContent = '▶ 播放';
    });
    this.dateLabel = h('span', { class: 'time-date' });
    this.envLabel = h('span', { class: 'time-env' });

    const speed = h('select', { class: 'select speed-select' }, [
      h('option', { value: '15', textContent: '慢速' }),
      h('option', { value: '30', textContent: '正常' }),
      h('option', { value: '90', textContent: '快速' }),
    ]) as HTMLSelectElement;
    speed.value = '30';
    speed.addEventListener('change', () => uiStore.set({ playFps: Number(speed.value) }));

    const rewind = h('button', {
      class: 'btn',
      textContent: '⏮ 回到蓄水开始',
      onclick: () => uiStore.set({ timeIndex: 0 }),
    });

    this.el.append(
      this.playBtn,
      rewind,
      this.slider,
      h('div', { class: 'time-info' }, [this.dateLabel, this.envLabel]),
      speed,
    );

    uiStore.subscribe((s) => {
      if (Number(this.slider.value) !== s.timeIndex) this.slider.value = String(s.timeIndex);
      this.updateLabels(s.timeIndex);
    });
    this.updateLabels(0);
  }

  private togglePlay(): void {
    const s = uiStore.get();
    if (s.playing) {
      uiStore.set({ playing: false });
      this.stopTimer();
      this.playBtn.textContent = '▶ 播放';
    } else {
      uiStore.set({ playing: true });
      this.playBtn.textContent = '⏸ 暂停';
      this.startTimer();
    }
  }

  private startTimer(): void {
    this.stopTimer();
    const tick = () => {
      const s = uiStore.get();
      if (!s.playing) return;
      const next = s.timeIndex + 1;
      if (next >= dataService.settings.days) {
        uiStore.set({ timeIndex: 0, playing: false });
        this.stopTimer();
        this.playBtn.textContent = '▶ 播放';
        return;
      }
      uiStore.set({ timeIndex: next });
      this.timer = window.setTimeout(tick, 1000 / s.playFps);
    };
    this.timer = window.setTimeout(tick, 1000 / uiStore.get().playFps);
  }

  private stopTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private updateLabels(index: number): void {
    const env = dataService.getEnv();
    this.dateLabel.textContent = indexToDate(dataService.settings.startDate, index);
    this.envLabel.textContent = `库水位 ${env.waterLevel[index].toFixed(2)} m　气温 ${env.airTemp[index].toFixed(1)} ℃　水头 ${env.head[index].toFixed(1)} m`;
  }
}
