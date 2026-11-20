/** 入口：初始化引导（首次进入生成数据集）→ 数据服务 → 外壳 */
import './styles.css';
import { h, mount } from './ui/dom';
import { AppShell } from './ui/app-shell';
import { isInitialized, loadSettings, loadStations } from './db/idb';
import { DEFAULT_SETTINGS, generateAndStore } from './db/generator';
import { dataService } from './state/data-service';
import { modelManager } from './state/model-manager';
import { loadRules, saveRules } from './db/idb';
import { DEFAULT_RULES } from './state/alerts';

const app = document.getElementById('app')!;

async function bootstrap(): Promise<void> {
  const ready = await isInitialized();
  if (!ready) {
    await showInitScreen();
  }
  const settings = (await loadSettings()) ?? DEFAULT_SETTINGS;
  const stations = await loadStations();
  await dataService.init(settings, stations);
  await modelManager.restore();
  const rules = await loadRules();
  if (rules.length === 0) await saveRules(DEFAULT_RULES);

  const shell = new AppShell();
  shell.render();
  mount(app, [shell.el]);
}

function showInitScreen(): Promise<void> {
  return new Promise((resolve) => {
    const bar = h('div', { class: 'progress-bar' }, [h('div', { class: 'progress-fill' })]);
    const phase = h('div', { class: 'init-phase', textContent: '准备生成工程数据…' });
    const detail = h('div', { class: 'init-detail muted', textContent: '双曲拱坝几何 · 260+ 测点 · 15 年日测序列（库水位/气温规律 + 观测噪声 + 缺测/跳变/基准变化）' });
    mount(app, [h('div', { class: 'init-screen' }, [h('h2', { textContent: '拱坝变形三维分析系统' }), phase, bar, detail])]);

    const worker = new Worker(new URL('./db/generator.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = async (ev: MessageEvent) => {
      if (ev.data.type === 'progress') {
        const p = ev.data.progress;
        const pct = p.phase === '生成监测序列' ? Math.round((p.done / p.total) * 100) : 10;
        (bar.firstChild as HTMLElement).style.width = `${Math.max(8, pct)}%`;
        phase.textContent = `${p.phase} ${p.phase === '生成监测序列' ? `${p.done}/${p.total}` : ''}`;
      } else if (ev.data.type === 'done') {
        worker.terminate();
        (bar.firstChild as HTMLElement).style.width = '100%';
        phase.textContent = `数据就绪：${ev.data.result.stationCount} 个测点、${ev.data.result.seriesCount} 条测值序列`;
        setTimeout(resolve, 600);
      } else if (ev.data.type === 'error') {
        worker.terminate();
        // Worker 异常时回退主线程生成
        phase.textContent = 'Worker 失败，改用主线程生成…';
        await generateAndStore(DEFAULT_SETTINGS, (p) => {
          const pct = p.phase === '生成监测序列' ? Math.round((p.done / p.total) * 100) : 10;
          (bar.firstChild as HTMLElement).style.width = `${Math.max(8, pct)}%`;
          phase.textContent = `${p.phase} ${p.done ?? ''}/${p.total ?? ''}`;
        });
        resolve();
      }
    };
    worker.postMessage({ settings: DEFAULT_SETTINGS });
  });
}

bootstrap().catch((err) => {
  console.error(err);
  mount(app, [h('div', { class: 'gpu-error' }, [h('h3', { textContent: '系统启动失败' }), h('p', { textContent: String(err) })])]);
});
