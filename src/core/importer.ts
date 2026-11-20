/**
 * 自动化监测系统导出格式兼容解析
 * 支持 4 类常见格式：
 *  A) 国标长表 CSV: 日期,测点编号,测值,质量码
 *  B) 南瑞风格宽表 CSV: 首行表头(日期 + 各测点列)
 *  C) 中海达风格 TXT: 固定空白分隔, # 开头注释
 *  D) 通用 JSON: [{date, stationId, metric, value, quality}]
 * 解析只做格式归一化，不做单位换算；输出统一行结构再交给数据管理入库
 */
import type { MetricKey } from '../types';

export interface ImportRow {
  date: string; // YYYY-MM-DD
  stationId: string;
  metric: MetricKey;
  value: number; // NaN 表示缺测
  rawQuality?: string;
}

export interface ParseResult {
  rows: ImportRow[];
  format: 'A-long-csv' | 'B-wide-csv' | 'C-txt' | 'D-json';
  warnings: string[];
}

const METRIC_HINT: Record<string, MetricKey> = {
  radial: 'radial',
  径向: 'radial',
  径向位移: 'radial',
  tangential: 'tangential',
  切向: 'tangential',
  切向位移: 'tangential',
  vertical: 'vertical',
  竖向: 'vertical',
  竖向位移: 'vertical',
  opening: 'opening',
  开合度: 'opening',
  缝宽: 'opening',
  head: 'head',
  渗压: 'head',
  水头: 'head',
};

function detectMetric(token: string): MetricKey | null {
  const t = token.toLowerCase();
  for (const key of Object.keys(METRIC_HINT)) {
    if (t.includes(key.toLowerCase())) return METRIC_HINT[key];
  }
  return null;
}

function toNumber(token: string): number {
  const t = token.trim();
  if (t === '' || t === '--' || t === 'NaN' || t === 'null' || t === '/') return NaN;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

function normalizeDate(token: string): string {
  const t = token.trim().replace(/[/.]/g, '-');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return t;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function splitLine(line: string): string[] {
  return line.split(/,|\t/).map((s) => s.trim());
}

export function parseImport(text: string, fileName = ''): ParseResult {
  const warnings: string[] = [];
  const head = text.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    return parseJson(text, warnings);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (lines.length === 0) throw new Error('文件内容为空');

  const firstCells = splitLine(lines[0]);
  // 宽表：首行含多个测点样式表头
  if (firstCells.length >= 3 && /日期|date|time/i.test(firstCells[0]) && firstCells.length > 3) {
    return parseWideCsv(lines, warnings);
  }
  // 空白分隔 TXT
  if (!text.includes(',') && /\s{2,}|\t/.test(lines[0])) {
    return parseTxt(lines, warnings, fileName);
  }
  return parseLongCsv(lines, warnings);
}

/** A) 长表 CSV */
function parseLongCsv(lines: string[], warnings: string[]): ParseResult {
  const rows: ImportRow[] = [];
  const header = splitLine(lines[0]).map((s) => s.toLowerCase());
  const hasHeader = header.some((h) => h.includes('date') || h.includes('日期'));
  const body = hasHeader ? lines.slice(1) : lines;
  for (const line of body) {
    const c = splitLine(line);
    if (c.length < 3) {
      warnings.push(`跳过无法解析的行: ${line.slice(0, 40)}`);
      continue;
    }
    const stationId = c[1];
    const metricToken = c.length >= 5 ? c[4] ?? stationId : stationId;
    const metric = detectMetric(metricToken) ?? inferMetricFromStation(stationId);
    if (!metric) {
      warnings.push(`未知测值类型，跳过: ${stationId}`);
      continue;
    }
    rows.push({
      date: normalizeDate(c[0]),
      stationId,
      metric,
      value: toNumber(c[2]),
      rawQuality: c[3],
    });
  }
  return { rows, format: 'A-long-csv', warnings };
}

/** B) 宽表 CSV：日期, PL-1-1640[径向], PL-1-1640[切向], ... */
function parseWideCsv(lines: string[], warnings: string[]): ParseResult {
  const header = splitLine(lines[0]);
  const cols: { stationId: string; metric: MetricKey }[] = [];
  for (let c = 1; c < header.length; c++) {
    const h = header[c];
    const m = h.match(/^([^\[\](]+)[\[(]([^\])]+)[\])]?$/);
    const stationId = (m ? m[1] : h).trim();
    const metric = (m ? detectMetric(m[2]) : inferMetricFromStation(h)) ?? inferMetricFromStation(stationId);
    if (!metric) {
      warnings.push(`列 ${h} 无法识别测值类型`);
      continue;
    }
    cols.push({ stationId, metric });
  }
  const rows: ImportRow[] = [];
  for (const line of lines.slice(1)) {
    const c = splitLine(line);
    const date = normalizeDate(c[0]);
    for (let j = 0; j < cols.length; j++) {
      rows.push({ date, stationId: cols[j].stationId, metric: cols[j].metric, value: toNumber(c[j + 1] ?? '') });
    }
  }
  return { rows, format: 'B-wide-csv', warnings };
}

/** C) 空白分隔 TXT（注释行已过滤） */
function parseTxt(lines: string[], warnings: string[], fileName: string): ParseResult {
  const rows: ImportRow[] = [];
  for (const line of lines) {
    const c = line.trim().split(/\s+/);
    if (c.length < 3) continue;
    const date = normalizeDate(c[0]);
    const stationId = c[1];
    const metric = inferMetricFromStation(`${fileName} ${stationId}`);
    if (!metric) {
      warnings.push(`TXT 行测点类型未知: ${line.slice(0, 40)}`);
      continue;
    }
    rows.push({ date, stationId, metric, value: toNumber(c[2]), rawQuality: c[3] });
  }
  return { rows, format: 'C-txt', warnings };
}

/** D) JSON */
function parseJson(text: string, warnings: string[]): ParseResult {
  const data = JSON.parse(text);
  const arr: any[] = Array.isArray(data) ? data : data.rows ?? [];
  const rows: ImportRow[] = [];
  for (const item of arr) {
    const metric = detectMetric(String(item.metric ?? '')) ?? inferMetricFromStation(String(item.stationId ?? ''));
    if (!metric) {
      warnings.push(`JSON 记录测点类型未知: ${JSON.stringify(item).slice(0, 60)}`);
      continue;
    }
    rows.push({
      date: normalizeDate(String(item.date)),
      stationId: String(item.stationId),
      metric,
      value: typeof item.value === 'number' ? item.value : toNumber(String(item.value ?? '')),
      rawQuality: item.quality != null ? String(item.quality) : undefined,
    });
  }
  return { rows, format: 'D-json', warnings };
}

/** 由测点编号前缀推断默认测值指标 */
export function inferMetricFromStation(stationId: string): MetricKey | null {
  const id = stationId.toUpperCase();
  if (id.startsWith('PZ')) return 'head';
  if (id.startsWith('JM')) return 'opening';
  if (id.includes('竖向') || id.includes('VERT')) return 'vertical';
  if (id.includes('切向') || id.includes('TANG')) return 'tangential';
  if (id.startsWith('PL') || id.startsWith('WL') || id.startsWith('GN')) return 'radial';
  return null;
}

/** 生成一份示例导入文件内容（供"下载样例"按钮使用） */
export function buildSampleFile(format: ParseResult['format']): string {
  if (format === 'A-long-csv') {
    return ['日期,测点编号,测值,质量码,测项', '2024-01-01,PL-1-1680,12.35,G,径向', '2024-01-02,PL-1-1680,12.41,G,径向', '2024-01-03,JM-3-1730,1.82,G,开合度'].join('\n');
  }
  if (format === 'B-wide-csv') {
    return ['日期,PL-1-1680[径向],PL-1-1680[切向],JM-3-1730[开合度]', '2024-01-01,12.35,-0.82,1.82', '2024-01-02,12.41,-0.79,1.85'].join('\n');
  }
  if (format === 'C-txt') {
    return '# 自动化系统导出\n2024-01-01  PL-1-1680  12.35  G\n2024-01-02  PL-1-1680  12.41  G';
  }
  return JSON.stringify(
    [
      { date: '2024-01-01', stationId: 'PL-1-1680', metric: 'radial', value: 12.35, quality: 'G' },
      { date: '2024-01-02', stationId: 'PL-1-1680', metric: 'radial', value: 12.41, quality: 'G' },
    ],
    null,
    2,
  );
}
