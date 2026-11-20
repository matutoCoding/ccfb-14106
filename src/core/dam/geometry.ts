/**
 * 拱坝几何网格构建：上/下游坝面、坝顶、横缝分块、廊道、坝基河谷
 * 输出可直接上传 GPU 的交错顶点数据
 */
import type { Vec3 } from '../../types';
import {
  ARCH_SEGMENTS,
  DAM_PARAMS,
  ELEV_LAYERS,
  archCenterPoint,
  archSurfacePoint,
  buildMonoliths,
  halfAngle,
} from './params';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** 每顶点径向/切向单位向量（坝面局部基） */
  radialDirs: Float32Array;
  tangentialDirs: Float32Array;
  /** 每顶点所属坝段号(0-based)，用于横缝开合刚体平移 */
  monolithIds: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
}

export interface LineData {
  positions: Float32Array;
  vertexCount: number;
}

function emptyMeta(n: number): {
  normals: Float32Array;
  radialDirs: Float32Array;
  tangentialDirs: Float32Array;
  monolithIds: Float32Array;
} {
  return {
    normals: new Float32Array(n * 3),
    radialDirs: new Float32Array(n * 3),
    tangentialDirs: new Float32Array(n * 3),
    monolithIds: new Float32Array(n),
  };
}

/**
 * 分坝段构建坝面网格：横缝处顶点断开（每坝段独立网格拼接），
 * 顶点着色器按坝段整体切向平移体现缝宽变化
 * @param side -1 上游面 +1 下游面
 */
export function buildDamFace(side: -1 | 1): MeshData {
  const monoliths = buildMonoliths();
  const segPer = ARCH_SEGMENTS / monoliths.length; // 每坝段弧向段数(28/17 不整除 → 用累计取整)
  const rows = ELEV_LAYERS + 1;

  const positions: number[] = [];
  const meta = emptyMeta(0);
  const normals: number[] = [];
  const radialDirs: number[] = [];
  const tangentialDirs: number[] = [];
  const monolithIds: number[] = [];
  const indices: number[] = [];
  let baseVertex = 0;

  for (let mi = 0; mi < monoliths.length; mi++) {
    const u0 = -1 + (2 * mi) / monoliths.length;
    const u1 = -1 + (2 * (mi + 1)) / monoliths.length;
    const nSeg = Math.max(2, Math.round(segPer));
    for (let r = 0; r < rows; r++) {
      const elev = DAM_PARAMS.baseElev + r * DAM_PARAMS.layerStep;
      for (let s = 0; s <= nSeg; s++) {
        const u = u0 + ((u1 - u0) * s) / nSeg;
        const p = archSurfacePoint(elev, u, side);
        positions.push(p.x, p.y, p.z);
        const phi = u * halfAngle(elev);
        const nx = -Math.sin(phi);
        const nz = Math.cos(phi);
        radialDirs.push(nx, 0, nz);
        tangentialDirs.push(Math.cos(phi), 0, Math.sin(phi));
        // 法线：上游面朝 -径向，下游面朝 +径向
        normals.push(side * nx, 0, side * nz);
        monolithIds.push(mi);
      }
    }
    const rowLen = nSeg + 1;
    for (let r = 0; r < rows - 1; r++) {
      for (let s = 0; s < nSeg; s++) {
        const a = baseVertex + r * rowLen + s;
        const b = a + 1;
        const c = a + rowLen;
        const d = c + 1;
        if (side === 1) {
          indices.push(a, c, b, b, c, d);
        } else {
          indices.push(a, b, c, b, d, c);
        }
      }
    }
    baseVertex += rows * rowLen;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    radialDirs: new Float32Array(radialDirs),
    tangentialDirs: new Float32Array(tangentialDirs),
    monolithIds: new Float32Array(monolithIds),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
  };
}

/** 坝顶盖面（连接上下游面顶拱） */
export function buildCrest(): MeshData {
  const monoliths = buildMonoliths();
  const elev = DAM_PARAMS.crestElev;
  const positions: number[] = [];
  const normals: number[] = [];
  const radialDirs: number[] = [];
  const tangentialDirs: number[] = [];
  const monolithIds: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (let mi = 0; mi < monoliths.length; mi++) {
    const u0 = -1 + (2 * mi) / monoliths.length;
    const u1 = -1 + (2 * (mi + 1)) / monoliths.length;
    const nSeg = 2;
    for (let s = 0; s <= nSeg; s++) {
      const u = u0 + ((u1 - u0) * s) / nSeg;
      const up = archSurfacePoint(elev, u, -1);
      const dn = archSurfacePoint(elev, u, 1);
      positions.push(up.x, up.y, up.z, dn.x, dn.y, dn.z);
      const phi = u * halfAngle(elev);
      radialDirs.push(-Math.sin(phi), 0, Math.cos(phi), -Math.sin(phi), 0, Math.cos(phi));
      tangentialDirs.push(Math.cos(phi), 0, Math.sin(phi), Math.cos(phi), 0, Math.sin(phi));
      normals.push(0, 1, 0, 0, 1, 0);
      monolithIds.push(mi, mi);
    }
    for (let s = 0; s < nSeg; s++) {
      const a = base + s * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    base += (nSeg + 1) * 2;
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    radialDirs: new Float32Array(radialDirs),
    tangentialDirs: new Float32Array(tangentialDirs),
    monolithIds: new Float32Array(monolithIds),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
  };
}

/** 廊道：三层水平灌浆/排水廊道 + 一条竖向交通井，沿拱圈中面 */
export function buildGalleries(): LineData[] {
  const galleryElevs = [1630, 1700, 1770];
  const lines: LineData[] = [];
  for (const elev of galleryElevs) {
    const pts: number[] = [];
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const u = -0.92 + (1.84 * i) / n;
      const p = archCenterPoint(elev, u);
      pts.push(p.x, p.y, p.z);
    }
    lines.push({ positions: new Float32Array(pts), vertexCount: n + 1 });
  }
  // 竖向交通井
  const shaft: number[] = [];
  for (let r = 0; r <= ELEV_LAYERS; r++) {
    const elev = DAM_PARAMS.baseElev + r * DAM_PARAMS.layerStep;
    if (elev < galleryElevs[0] - 5 || elev > galleryElevs[2] + 5) continue;
    const p = archCenterPoint(elev, -0.25);
    shaft.push(p.x, p.y, p.z);
  }
  lines.push({ positions: new Float32Array(shaft), vertexCount: shaft.length / 3 });
  return lines;
}

/**
 * 坝基河谷地形网格（含两岸山体）
 */
export function buildFoundation(): MeshData {
  const nx = 48;
  const nz = 32;
  const xRange = 750;
  const zMin = -220;
  const zMax = 650;
  const positions: number[] = [];
  const normals: number[] = [];
  const radialDirs: number[] = [];
  const tangentialDirs: number[] = [];
  const monolithIds: number[] = [];
  const indices: number[] = [];

  for (let iz = 0; iz <= nz; iz++) {
    const z = zMin + ((zMax - zMin) * iz) / nz;
    for (let ix = 0; ix <= nx; ix++) {
      const x = -xRange + (2 * xRange * ix) / nx;
      // V 型河谷：河槽在 x≈0，两岸抬升；向下游略微抬高
      const y = -32 + 0.00052 * x * x + 0.06 * Math.max(0, z) - 0.04 * Math.max(0, -z);
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      radialDirs.push(0, 0, 1);
      tangentialDirs.push(1, 0, 0);
      monolithIds.push(-1);
    }
  }
  const rowLen = nx + 1;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * rowLen + ix;
      const b = a + 1;
      const c = a + rowLen;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    radialDirs: new Float32Array(radialDirs),
    tangentialDirs: new Float32Array(tangentialDirs),
    monolithIds: new Float32Array(monolithIds),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
  };
}

/** 横缝位置线（坝段之间），用于场景中绘制缝标识 */
export function buildJointLines(): LineData[] {
  const n = DAM_PARAMS.monolithCount;
  const result: LineData[] = [];
  for (let j = 1; j < n; j++) {
    const u = -1 + (2 * j) / n;
    const pts: number[] = [];
    for (let r = 0; r <= ELEV_LAYERS; r++) {
      const elev = DAM_PARAMS.baseElev + r * DAM_PARAMS.layerStep;
      const p = archSurfacePoint(elev, u, 1);
      pts.push(p.x, p.y, p.z);
    }
    result.push({ positions: new Float32Array(pts), vertexCount: ELEV_LAYERS + 1 });
  }
  return result;
}

/** 两点距离（模型坐标） */
export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
