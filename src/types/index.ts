/**
 * 领域类型定义
 * 坐标系: x — 左岸→右岸(沿坝轴线切向), y — 竖直向上(高程), z — 指向下游(径向)
 * 位移分量: radial 径向(下游为正), tangential 切向(右岸为正), vertical 竖向(向上为正)
 */

export type StationType = 'plumb' | 'wire' | 'gnss' | 'joint' | 'piezometer';
export type MetricKind = 'displacement' | 'joint-opening' | 'seepage-head';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 坝段（横缝之间的块体） */
export interface Monolith {
  id: number;
  /** 沿拱圈的角度范围(度), 左岸为负 */
  angleMin: number;
  angleMax: number;
  name: string;
}

/** 工程测点 */
export interface Station {
  id: string;
  name: string;
  type: StationType;
  /** 所属坝段号 */
  monolithId: number;
  /** 安装高程 m */
  elevation: number;
  /** 模型空间坐标(上游/下游面或廊道内) */
  position: Vec3;
  /** 径向/切向局部方向(单位向量), 用于矢量箭头与位移投影 */
  basis: { radial: Vec3; tangential: Vec3; vertical: Vec3 };
  metrics: MetricKey[];
  /** 仪器安装日期索引(序列内下标), 模拟"仪器换新" */
  installIndex: number;
  /** 生成数据时使用的真实 HST 系数(回归核验基准) */
  trueCoeffs?: HSTCoeffs;
  /** 横缝测点专用: 缝所在的横缝编号 */
  jointId?: number;
}

export type MetricKey =
  | 'radial'
  | 'tangential'
  | 'vertical'
  | 'opening'
  | 'head';

export const METRIC_LABEL: Record<MetricKey, string> = {
  radial: '径向位移',
  tangential: '切向位移',
  vertical: '竖向位移',
  opening: '缝开合度',
  head: '渗压水头',
};

export const METRIC_UNIT: Record<MetricKey, string> = {
  radial: 'mm',
  tangential: 'mm',
  vertical: 'mm',
  opening: 'mm',
  head: 'm',
};

/** HST（水压-温度-时效）模型系数，单位与测值一致(mm) */
export interface HSTCoeffs {
  /** 常数项 */
  c0: number;
  /** 水压分量 h..h^4 */
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  /** 温度分量(年周期/半年周期谐波) */
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  /** 时效分量 θ 与 ln(1+θ), θ 以年为单位 */
  a1: number;
  a2: number;
}

export const HST_PREDICTOR_NAMES = [
  '常数项',
  'H',
  'H²',
  'H³',
  'H⁴',
  'sin年',
  'cos年',
  'sin半年',
  'cos半年',
  'θ',
  'ln(1+θ)',
] as const;

/** 数据质量位标记 */
export const enum Quality {
  Good = 0,
  Missing = 1 << 0,
  Spike = 1 << 1,
  DatumShift = 1 << 2,
  Adjusted = 1 << 3, // 基准变化已人工/自动接边
  Interpolated = 1 << 4,
}

export interface SeriesMeta {
  stationId: string;
  metric: MetricKey;
  /** 序列起点日期 */
  startDate: string;
  /** 日序列长度 */
  count: number;
}

/** 导入/质检事件 */
export interface DataEvent {
  id: string;
  stationId: string;
  metric: MetricKey;
  index: number;
  date: string;
  kind: 'missing' | 'spike' | 'datum-shift';
  detail: string;
  /** 跳变/基准变化估计的偏移量 */
  offset?: number;
  status: 'pending' | 'confirmed' | 'ignored';
  handledAt?: string;
  handledBy?: string;
}

/** HST 回归结果 */
export interface HSTResult {
  stationId: string;
  metric: MetricKey;
  coeffs: HSTCoeffs;
  /** 拟合优度与残差统计 */
  r2: number;
  rmse: number;
  residualStd: number;
  sampleCount: number;
  /** 残差 > 3σ 的序列下标 */
  outlierIndices: number[];
  /** 与生成数据真值的系数相对误差(%)，有真值时填写 */
  coeffRelErrorPct?: number;
}

export type AlertLevel = 'watch' | 'warning' | 'alarm';
export type AlertRuleType = 'value' | 'rate' | 'residual';

export interface AlertRule {
  id: string;
  type: AlertRuleType;
  metric: MetricKey;
  stationType: StationType | 'all';
  level: AlertLevel;
  /** 阈值(测值单位 mm/m；速率为 mm/d) */
  threshold: number;
  enabled: boolean;
}

export interface AlertRecord {
  id: string;
  stationId: string;
  metric: MetricKey;
  index: number;
  date: string;
  ruleId: string;
  ruleType: AlertRuleType;
  level: AlertLevel;
  value: number;
  threshold: number;
  status: 'open' | 'confirmed' | 'handled';
  message: string;
  createdAt: string;
  handledAt?: string;
  handledBy?: string;
  handleNote?: string;
}

export interface AppSettings {
  damName: string;
  startDate: string;
  days: number;
  /** 坝顶/坝基高程等 */
  crestElev: number;
  baseElev: number;
  normalPoolLevel: number;
  deadPoolLevel: number;
}
