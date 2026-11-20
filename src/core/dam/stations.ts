/**
 * 测点布置：垂线/引张线/GNSS/测缝计/渗压计，共约 260+ 测点
 * 全部依据双曲拱几何参数定位，落在坝面或廊道内
 */
import type { MetricKey, Station, StationType, Vec3 } from '../../types';
import { Rng, hashSeed } from '../random';
import {
  DAM_PARAMS,
  archSurfacePoint,
  buildMonoliths,
  localBasis,
  monolithIdAtAngle,
  halfAngle,
} from './params';
import { archCenterPoint } from './params';

export interface StationLayoutResult {
  stations: Station[];
}

function makeStation(
  id: string,
  name: string,
  type: StationType,
  elev: number,
  u: number,
  pos: Vec3,
  metrics: MetricKey[],
  monoliths: ReturnType<typeof buildMonoliths>,
  rng: Rng,
  days: number,
  jointId?: number,
): Station {
  const phiDeg = (u * halfAngle(elev) * 180) / Math.PI;
  return {
    id,
    name,
    type,
    monolithId: monolithIdAtAngle(phiDeg, monoliths),
    elevation: elev,
    position: pos,
    basis: localBasis(u, elev),
    metrics,
    // 少量仪器在运行前中段换新（基准变化的来源之一），保证换新后仍有充足观测段
    installIndex: rng.chance(0.1) ? Math.floor(rng.uniform(days * 0.3, days * 0.45)) : 0,
    jointId,
  };
}

export function buildStations(days: number): Station[] {
  const rng = new Rng(hashSeed('dam-station-layout-v1'));
  const monoliths = buildMonoliths();
  const stations: Station[] = [];
  const { baseElev, crestElev } = DAM_PARAMS;

  // 1) 正倒垂线：5 条垂线（拱冠 + 左右 1/4 + 左右岸附近），每条沿高程 6 个测点
  const plumbUs = [0, -0.45, 0.45, -0.78, 0.78];
  const plumbElevs = [1640, 1680, 1720, 1760, 1790, 1820];
  let seq = 1;
  for (const u of plumbUs) {
    const lineNo = seq++;
    for (const elev of plumbElevs) {
      const p = archSurfacePoint(elev, u, -1); // 垂线井靠上游面
      stations.push(
        makeStation(
          `PL-${lineNo}-${elev}`,
          `${lineNo}#垂线 ${elev}m`,
          'plumb',
          elev,
          u,
          p,
          ['radial', 'tangential'],
          monoliths,
          rng,
          days,
        ),
      );
    }
  }

  // 2) 引张线：3 层廊道，每层 11 个测点（与坝段对齐）
  const wireElevs = [1630, 1700, 1770];
  for (const elev of wireElevs) {
    for (let m = 1; m <= 11; m++) {
      const u = -1 + ((m - 0.5) / 11) * 2;
      const p = archCenterPoint(elev, u);
      stations.push(
        makeStation(
          `WL-${elev}-${m}`,
          `${elev}m引张线 ${m}#点`,
          'wire',
          elev,
          u,
          p,
          ['radial', 'tangential'],
          monoliths,
          rng,
          days,
        ),
      );
    }
  }

  // 3) GNSS：坝顶 9 个表面位移测点（径向+切向+竖向）
  for (let m = 1; m <= 9; m++) {
    const u = -0.9 + ((m - 0.5) / 9) * 1.8;
    const p = archSurfacePoint(crestElev, u, 1);
    stations.push(
      makeStation(
        `GN-${m}`,
        `坝顶GNSS ${m}#`,
        'gnss',
        crestElev,
        u,
        p,
        ['radial', 'tangential', 'vertical'],
        monoliths,
        rng,
        days,
      ),
    );
  }

  // 4) 测缝计：横缝上 3 个高程 × 16 条横缝
  const jointElevs = [1660, 1730, 1800];
  for (let j = 1; j <= DAM_PARAMS.monolithCount - 1; j++) {
    const u = -1 + (2 * j) / DAM_PARAMS.monolithCount;
    for (const elev of jointElevs) {
      const p = archSurfacePoint(elev, u, 1);
      const s = makeStation(
        `JM-${j}-${elev}`,
        `${j}#横缝 ${elev}m测缝计`,
        'joint',
        elev,
        u,
        p,
        ['opening'],
        monoliths,
        rng,
        days,
        j,
      );
      stations.push(s);
    }
  }

  // 5) 渗压计：坝基排水廊道 5 个高程 × 13 个坝段
  const piezoElevs = [1590, 1610, 1630, 1660, 1700];
  for (const elev of piezoElevs) {
    for (let m = 1; m <= 13; m++) {
      const u = -0.92 + ((m - 0.5) / 13) * 1.84;
      // 坝基渗压计位于坝体下部靠上游
      const p = archCenterPoint(Math.max(elev, baseElev + 12), u);
      stations.push(
        makeStation(
          `PZ-${elev}-${m}`,
          `${elev}m渗压计 ${m}#`,
          'piezometer',
          elev,
          u,
          p,
          ['head'],
          monoliths,
          rng,
          days,
        ),
      );
    }
  }

  return stations;
}

export function countByType(stations: Station[]): Record<StationType, number> {
  const out: Record<StationType, number> = { plumb: 0, wire: 0, gnss: 0, joint: 0, piezometer: 0 };
  for (const s of stations) out[s.type]++;
  return out;
}
