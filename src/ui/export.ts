/** 报表导出：统计表 CSV、过程线/分布图 PNG（Canvas 直接导出） */
import { h } from './dom';

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['﻿' + content], { type: mime });
  triggerDownload(URL.createObjectURL(blob), filename);
}

export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  triggerDownload(canvas.toDataURL('image/png'), filename);
}

function triggerDownload(url: string, filename: string): void {
  const a = h('a', { href: url, download: filename }) as HTMLAnchorElement;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

/** 统计表导出（月报/年报通用） */
export function exportStatTable(filename: string, title: string, headers: string[], rows: (string | number)[][]): void {
  const head = `# ${title}\n# 导出时间 ${new Date().toISOString().slice(0, 19)}\n`;
  downloadText(filename, head + toCsv(headers, rows));
}
