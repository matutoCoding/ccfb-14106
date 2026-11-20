/** 日期与时间序列工具：统一用"日下标"索引，避免 Date 对象开销 */

export function dateToIndex(startDate: string, iso: string): number {
  const start = Date.parse(startDate + 'T00:00:00Z');
  const cur = Date.parse(iso + 'T00:00:00Z');
  return Math.round((cur - start) / 86400000);
}

export function indexToDate(startDate: string, index: number): string {
  const start = Date.parse(startDate + 'T00:00:00Z');
  return new Date(start + index * 86400000).toISOString().slice(0, 10);
}

/** 年内天数(1..365) 与年积角，用于温度谐波 */
export function dayOfYear(iso: string): number {
  const t = Date.parse(iso + 'T00:00:00Z');
  const yearStart = Date.parse(iso.slice(0, 4) + '-01-01T00:00:00Z');
  return Math.floor((t - yearStart) / 86400000) + 1;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatDate(iso: string): string {
  return iso;
}

/** 年份(浮点)，用于时效 θ */
export function fractionalYear(startDate: string, index: number): number {
  const iso = indexToDate(startDate, index);
  const y = Number(iso.slice(0, 4));
  return y + (dayOfYear(iso) - 1) / 365.25 - Number(startDate.slice(0, 4));
}
