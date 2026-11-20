/**
 * 双曲拱坝参数化模型
 * 高程: 坝基 1580m ~ 坝顶 1830m, 共 26 个高程层(10m 一层)
 * 水平拱圈: 圆心沿径向随高程变化(拱冠悬臂梁弯曲) + 半径/半中心角随高程变化
 * 坐标: x 左岸→右岸, y 竖直, z 指向下游
 */
import type { Monolith, Vec3 } from '../../types';

export interface DamParams {
  baseElev: number;
  crestElev: number;
  layerStep: number;
  /** 坝顶拱圈半径 m */
  crestRadius: number;
  /** 坝基拱圈半径 m */
  baseRadius: number;
  /** 坝顶半中心角(度) */
  crestHalfAngleDeg: number;
  /** 坝基半中心角(度) */
  baseHalfAngleDeg: number;
  /** 坝顶厚度 m */
  crestThickness: number;
  /** 坝基厚度 m */
  baseThickness: number;
  /** 拱冠悬臂梁上游面在坝顶处相对坝基的径向偏移(正值向上游) m */
  crownOverhang: number;
  monolithCount: number;
}

export const DAM_PARAMS: DamParams = {
  baseElev: 1580,
  crestElev: 1830,
  layerStep: 10,
  crestRadius: 420,
  baseRadius: 260,
  crestHalfAngleDeg: 70,
  baseHalfAngleDeg: 42,
  crestThickness: 8,
  baseThickness: 38,
  crownOverhang: 26,
  monolithCount: 17,
};

/** 拱圈沿弧向离散段数 */
export const ARCH_SEGMENTS = 28;
/** 高程层数 */
export const ELEV_LAYERS = Math.round(
  (DAM_PARAMS.crestElev - DAM_PARAMS.baseElev) / DAM_PARAMS.layerStep,
);

/** 相对高程 0(坝基) ~ 1(坝顶) */
export function elevT(elev: number): number {
  return (elev - DAM_PARAMS.baseElev) / (DAM_PARAMS.crestElev - DAM_PARAMS.baseElev);
}

/** 拱圈半径随高程变化 */
export function archRadius(elev: number): number {
  const t = elevT(elev);
  return DAM_PARAMS.baseRadius + (DAM_PARAMS.crestRadius - DAM_PARAMS.baseRadius) * (0.25 * t + 0.75 * t * t);
}

/** 半中心角(弧度)随高程变化 */
export function halfAngle(elev: number): number {
  const t = elevT(elev);
  const deg =
    DAM_PARAMS.baseHalfAngleDeg +
    (DAM_PARAMS.crestHalfAngleDeg - DAM_PARAMS.baseHalfAngleDeg) * (0.4 * t + 0.6 * t * t);
  return (deg * Math.PI) / 180;
}

/** 坝体厚度随高程变化(线性 + 轻微下凹) */
export function damThickness(elev: number): number {
  const t = elevT(elev);
  return DAM_PARAMS.baseThickness + (DAM_PARAMS.crestThickness - DAM_PARAMS.baseThickness) * (1.15 * t - 0.15 * t * t);
}

/**
 * 拱冠处圆心的径向坐标: 坝顶圆心向上游移动, 形成拱冠悬臂梁弯曲
 * z 向下游为正, 上游偏移为负
 */
export function crownCenterZ(elev: number): number {
  const t = elevT(elev);
  return -DAM_PARAMS.crownOverhang * (1.6 * t - 0.6 * t * t);
}

/** 拱冠上游面点坐标 */
export function crownUpstreamPoint(elev: number): Vec3 {
  const r = archRadius(elev);
  return { x: 0, y: elev - DAM_PARAMS.baseElev, z: crownCenterZ(elev) - r };
}

/**
 * 给定高程与弧向参数 u∈[-1,1]（-1 左岸, +1 右岸），返回拱圈中心线点
 */
export function archCenterPoint(elev: number, u: number): Vec3 {
  const r = archRadius(elev);
  const phi = u * halfAngle(elev);
  return {
    x: r * Math.sin(phi),
    y: elev - DAM_PARAMS.baseElev,
    z: crownCenterZ(elev) - r * Math.cos(phi) + r,
  };
}

/**
 * 坝面点：side=-1 上游面, side=+1 下游面
 */
export function archSurfacePoint(elev: number, u: number, side: -1 | 1): Vec3 {
  const c = archCenterPoint(elev, u);
  const phi = u * halfAngle(elev);
  // 厚度方向沿拱圈水平法向（径向）
  const nx = -Math.sin(phi);
  const nz = Math.cos(phi);
  const half = damThickness(elev) / 2;
  return {
    x: c.x + side * half * nx,
    y: c.y,
    z: c.z + side * half * nz,
  };
}

/** 测点局部坐标基（径向/切向/竖直单位向量） */
export function localBasis(u: number, elev: number): { radial: Vec3; tangential: Vec3; vertical: Vec3 } {
  const phi = u * halfAngle(elev);
  return {
    radial: { x: -Math.sin(phi), y: 0, z: Math.cos(phi) },
    tangential: { x: Math.cos(phi), y: 0, z: Math.sin(phi) },
    vertical: { x: 0, y: 1, z: 0 },
  };
}

/** 17 个坝段, 按半中心角均分 */
export function buildMonoliths(): Monolith[] {
  const list: Monolith[] = [];
  const n = DAM_PARAMS.monolithCount;
  const crestHalfDeg = DAM_PARAMS.crestHalfAngleDeg;
  for (let i = 0; i < n; i++) {
    const a0 = -crestHalfDeg + (2 * crestHalfDeg * i) / n;
    const a1 = -crestHalfDeg + (2 * crestHalfDeg * (i + 1)) / n;
    list.push({
      id: i + 1,
      angleMin: a0,
      angleMax: a1,
      name: `${i + 1}#坝段`,
    });
  }
  return list;
}

/** 由弧向角度(度)查坝段号 */
export function monolithIdAtAngle(angleDeg: number, monoliths: Monolith[]): number {
  for (const m of monoliths) {
    if (angleDeg >= m.angleMin && angleDeg < m.angleMax) return m.id;
  }
  return angleDeg < 0 ? monoliths[0].id : monoliths[monoliths.length - 1].id;
}

/** 坝段编号 → 该坝段中线的弧向参数 u */
export function monolithCenterU(monolithId: number): number {
  const n = DAM_PARAMS.monolithCount;
  return -1 + ((monolithId - 0.5) / n) * 2;
}
