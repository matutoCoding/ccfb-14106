/**
 * 数据生成 Worker：避免大数据量合成阻塞主线程
 */
import { generateAndStore, type GenProgress } from './generator';

self.onmessage = async (ev: MessageEvent<{ settings: Parameters<typeof generateAndStore>[0] }>) => {
  try {
    const result = await generateAndStore(ev.data.settings, (p: GenProgress) => {
      (self as unknown as Worker).postMessage({ type: 'progress', progress: p });
    });
    (self as unknown as Worker).postMessage({ type: 'done', result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: (err as Error).message });
  }
};
