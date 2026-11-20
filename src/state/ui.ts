/**
 * 全局 UI 状态：当前页面、时间轴、播放、变形显示模式、放大倍数
 */
import { Store } from './store';
import type { MetricKey } from '../types';

export type PageId =
  | 'overview'
  | 'data'
  | 'model'
  | 'scene3d'
  | 'section'
  | 'alert';

export type ComponentMode = 'total' | 'hydro' | 'thermal' | 'aging' | 'residual';

export interface UiState {
  page: PageId;
  timeIndex: number;
  playing: boolean;
  playFps: number;
  exaggeration: number; // 变形放大倍数
  metric: MetricKey;
  componentMode: ComponentMode;
  showContours: boolean;
  showVectors: boolean;
  showShadow: boolean;
  showGalleries: boolean;
  showWater: boolean;
  showAlerts: boolean;
  selectedStationId: string | null;
  selectedMonolith: number; // 剖面页坝段
}

export const uiStore = new Store<UiState>({
  page: 'overview',
  timeIndex: 0,
  playing: false,
  playFps: 30,
  exaggeration: 60,
  metric: 'radial',
  componentMode: 'total',
  showContours: true,
  showVectors: true,
  showShadow: true,
  showGalleries: true,
  showWater: true,
  showAlerts: true,
  selectedStationId: null,
  selectedMonolith: 9,
});

export const COMPONENT_LABEL: Record<ComponentMode, string> = {
  total: '总位移(实测)',
  hydro: '水压分量',
  thermal: '温度分量',
  aging: '时效分量',
  residual: '残差',
};
