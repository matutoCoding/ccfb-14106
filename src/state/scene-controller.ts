/**
 * 三维场景控制器：渲染资源生命周期 + 每帧"数据场 → GPU"调度
 * 播放循环只更新场值缓冲与实例缓冲，静态几何只上传一次
 */
import { DamRenderer, type PointInstance, type VectorSegment } from '../render/renderer';
import { buildDamFace, buildCrest, buildFoundation, buildGalleries, buildJointLines } from '../core/dam/geometry';
import { DAM_PARAMS } from '../core/dam/params';
import { dataService } from './data-service';
import { uiStore } from './ui';
import { modelManager } from './model-manager';
import type { AlertRecord, MetricKey, Station } from '../types';
import { evaluateFieldInto } from '../core/interpolate';
import { rampColor } from '../render/color-ramp';

interface GpuAssets {
  damVB: GPUBuffer;
  damIB: GPUBuffer;
  damIndexCount: number;
  foundation: { vb: GPUBuffer; ib: GPUBuffer; count: number };
  galleryLines: { vb: GPUBuffer; vertices: number };
  jointLines: { vb: GPUBuffer; vertices: number };
}

export class SceneController {
  renderer = new DamRenderer();
  private assets: GpuAssets | null = null;
  private fieldBuffer: Float32Array = new Float32Array(0);
  private stationValBuffer: Float32Array = new Float32Array(0);
  private jointOffsets = new Float32Array(DAM_PARAMS.monolithCount);
  private pointInstanceBuffer: PointInstance[] = [];
  private vectorBuffer: VectorSegment[] = [];
  private openingValBuffer: Float32Array = new Float32Array(0);
  private alerts: AlertRecord[] = [];
  private alertStationSet = new Set<string>();
  private raf = 0;
  private lastFrame = 0;
  private timeSeconds = 0;
  private waterMesh: { vb: GPUBuffer; ib: GPUBuffer; count: number; yOffset: number } | null = null;
  onPick?: (station: Station) => void;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.renderer.init(canvas);
    const r = this.renderer;
    const face = buildDamFace(1);
    const crest = buildCrest();
    // 坝顶合并进下游面几何（简化：只渲下游面 + 坝顶 + 上游面影子由同一网格承担）
    const damVB = r.uploadMesh(face);
    const damIB = r.uploadIndexBuffer(face);
    r.setFaceVertexCount(face.vertexCount);

    const foundationMesh = buildFoundation();
    const foundation = r.uploadSimpleMesh(foundationMesh);
    const galleries = r.uploadLines(buildGalleries(), [1.0, 0.82, 0.35, 0.9]);
    const jointLines = r.uploadLines(buildJointLines(), [0.12, 0.12, 0.14, 0.85]);

    this.assets = {
      damVB,
      damIB,
      damIndexCount: face.indices.length,
      foundation,
      galleryLines: galleries,
      jointLines,
    };
    this.fieldBuffer = new Float32Array(face.vertexCount);
    this.waterMesh = this.buildWaterPlane();

    await dataService.ensureFieldWeights();
    canvas.addEventListener('click', (e) => this.handlePick(e, canvas));
  }

  private buildWaterPlane() {
    const r = this.renderer;
    const nx = 24;
    const nz = 16;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    // 仅上游库区：z 从 -650(上游远方) 到 -20(坝前)，x 限制在河谷宽度内
    for (let iz = 0; iz <= nz; iz++) {
      const z = -650 + (630 * iz) / nz;
      for (let ix = 0; ix <= nx; ix++) {
        const x = -360 + (720 * ix) / nx;
        positions.push(x, 0, z);
        normals.push(0, 1, 0);
      }
    }
    const row = nx + 1;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * row + ix;
        indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    const mesh = {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      vertexCount: positions.length / 3,
      radialDirs: new Float32Array(positions.length),
      tangentialDirs: new Float32Array(positions.length),
      monolithIds: new Float32Array(positions.length / 3),
    };
    const simple = r.uploadSimpleMesh(mesh);
    return { ...simple, yOffset: 0 };
  }

  setAlerts(alerts: AlertRecord[]): void {
    this.alerts = alerts;
  }

  start(): void {
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
      this.lastFrame = t;
      this.timeSeconds += dt;
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** 当前时间点处于告警状态的测点（开放/已确认未处理） */
  private refreshAlertSet(index: number): void {
    this.alertStationSet.clear();
    for (const a of this.alerts) {
      if (Math.abs(a.index - index) <= 3) this.alertStationSet.add(a.stationId);
    }
  }

  private frame(): void {
    if (!this.assets) return;
    const ui = uiStore.get();
    const { settings } = dataService;
    const idx = ui.timeIndex;
    this.refreshAlertSet(idx);

    // 1) 场值：按显示模式取测点值并插值到坝面（复用缓冲，播放零分配）
    const metric = ui.metric;
    if (this.stationValBuffer.length !== dataService.stations.length) {
      this.stationValBuffer = new Float32Array(dataService.stations.length);
    }
    const stationVals = modelManager.valuesAtInto(metric, idx, ui.componentMode, this.stationValBuffer);
    const weights = dataService.fieldWeights?.face[metric];
    let vmin = Infinity;
    let vmax = -Infinity;
    if (weights) {
      evaluateFieldInto(weights, stationVals, this.fieldBuffer);
      for (let i = 0; i < this.fieldBuffer.length; i++) {
        const v = this.fieldBuffer[i];
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
    }
    if (!Number.isFinite(vmin)) {
      vmin = -10;
      vmax = 10;
    }
    if (vmax - vmin < 0.5) {
      vmin -= 1;
      vmax += 1;
    }
    this.renderer.updateField(this.fieldBuffer);

    // 2) 横缝开合 → 坝段切向平移
    this.updateJointOffsets(idx, ui.componentMode);
    this.renderer.updateJointOffsets(this.jointOffsets);

    // 3) 测点小球（仅显示与当前指标相关的测点，复用数组）
    this.buildPointInstances(metric, idx, stationVals);
    this.renderer.setPointInstances(this.pointInstanceBuffer);

    // 4) 位移矢量箭头（径向/切向切换，复用数组）
    if (ui.showVectors) {
      this.buildVectors(idx);
      this.renderer.setVectors(this.vectorBuffer);
    } else this.renderer.setVectors([]);

    // 5) 水面随库水位升降
    const env = dataService.getEnv();
    const level = env.waterLevel[idx];
    const yOffset = level - settings.baseElev;
    const waterMesh = this.waterMesh ? { ...this.waterMesh, yOffset } : undefined;

    const contourStep = ui.showContours ? niceStep((vmax - vmin) / 8) : 0;
    this.renderer.render({
      damVB: this.assets.damVB,
      damIB: this.assets.damIB,
      damIndexCount: this.assets.damIndexCount,
      foundation: this.assets.foundation,
      waterMesh,
      galleryLines: this.assets.galleryLines,
      jointLines: this.assets.jointLines,
      showShadow: ui.showShadow,
      showGalleries: ui.showGalleries,
      showWater: ui.showWater,
      exaggeration: ui.exaggeration,
      valueMin: vmin,
      valueMax: vmax,
      contourStep,
      pointParams: { baseRadius: 3.0, sizeGain: 1.1 },
      timeSeconds: this.timeSeconds,
      anyAlert: this.alertStationSet.size > 0,
    });
  }

  /** 每条横缝取该缝测缝计在当日的开合度，换算为相邻坝段反向切向位移(m) */
  private updateJointOffsets(index: number, mode: string): void {
    const offsets = this.jointOffsets.fill(0);
    const joints = dataService.fieldWeights?.joints;
    if (!joints) return;
    if (this.openingValBuffer.length !== dataService.stations.length) {
      this.openingValBuffer = new Float32Array(dataService.stations.length);
    }
    const vals = modelManager.valuesAtInto('opening', index, mode === 'total' ? 'total' : mode, this.openingValBuffer);
    for (const [jointId, list] of joints) {
      let opening = 0;
      let wsum = 0;
      for (const item of list) {
        const s = dataService.stations[item.stationIndex];
        const v = vals[item.stationIndex];
        if (Number.isFinite(v)) {
          // 越靠坝顶权重越大（缝在顶部更宽）
          const w = 0.4 + s.elevation / DAM_PARAMS.crestElev;
          opening += v * w;
          wsum += w;
        }
      }
      if (wsum === 0) continue;
      opening /= wsum;
      const halfShiftM = (opening * 0.001) / 2; // mm→m，缝两侧各移一半
      const leftMon = jointId - 1;
      const rightMon = jointId;
      if (leftMon >= 0) offsets[leftMon] -= halfShiftM;
      if (rightMon < offsets.length) offsets[rightMon] += halfShiftM;
    }
  }

  /** 填充复用的测点实例数组（播放零分配） */
  private buildPointInstances(metric: MetricKey, index: number, stationVals: Float32Array): void {
    const out = this.pointInstanceBuffer;
    out.length = 0;
    const stations = dataService.stations;
    for (let i = 0; i < stations.length && out.length < 480; i++) {
      const s = stations[i];
      if (!s.metrics.includes(metric)) continue;
      let v = stationVals[i];
      if (!Number.isFinite(v)) {
        const se = dataService.peekSeries(s.id, metric);
        v = se?.values[index] ?? NaN;
      }
      if (!Number.isFinite(v)) continue;
      const alert = this.alertStationSet.has(s.id) ? 1 : 0;
      out.push({
        center: [s.position.x, s.position.y, s.position.z],
        value: v,
        alert,
        radialDir: [s.basis.radial.x, s.basis.radial.y, s.basis.radial.z],
        tangentialDir: [s.basis.tangential.x, s.basis.tangential.y, s.basis.tangential.z],
      });
    }
  }

  /** 位移矢量：在位移类测点位置沿径向/切向画箭头，长度按测值缩放（复用数组） */
  private buildVectors(index: number): void {
    const ui = uiStore.get();
    const useTangential = ui.metric === 'tangential';
    const segs = this.vectorBuffer;
    segs.length = 0;
    const vals = this.stationValBuffer; // frame 中已按当前 metric/mode 填充
    const scale = 6.0; // 视觉放大
    let maxAbs = 1e-6;
    for (const v of vals) if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    for (let i = 0; i < dataService.stations.length && segs.length < 220; i++) {
      const s = dataService.stations[i];
      if (!s.metrics.includes(ui.metric)) continue;
      const v = vals[i];
      if (!Number.isFinite(v) || Math.abs(v) < maxAbs * 0.08) continue;
      const dir = useTangential ? s.basis.tangential : s.basis.radial;
      const len = (v / maxAbs) * 26 * scale * 0.18;
      const [r, g, b] = rampColor((v - -maxAbs) / (2 * maxAbs));
      const color: [number, number, number, number] = [r, g, b, 0.95];
      segs.push({
        from: [s.position.x, s.position.y, s.position.z],
        to: [s.position.x + dir.x * len, s.position.y + dir.y * len, s.position.z + dir.z * len],
        color,
      });
    }
  }

  /** 简单射线求交拾取（取相机方向上最近测点） */
  private handlePick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const cam = this.renderer.camera;
    const eye = cam.eye();
    const vp = cam.viewProj(rect.width / rect.height);
    // 反投影近远点求射线方向
    const inv = invert(vp);
    const nearP = transform(inv, [nx, ny, -1, 1]);
    const farP = transform(inv, [nx, ny, 1, 1]);
    const dirNorm = normalize([farP[0] / farP[3] - nearP[0] / nearP[3], farP[1] / farP[3] - nearP[1] / nearP[3], farP[2] / farP[3] - nearP[2] / nearP[3]]);
    let best: Station | null = null;
    let bestD = 14; // 拾取阈值(模型单位 m)
    for (const s of dataService.stations) {
      const ox = s.position.x - eye[0];
      const oy = s.position.y - eye[1];
      const oz = s.position.z - eye[2];
      const t = ox * dirNorm[0] + oy * dirNorm[1] + oz * dirNorm[2];
      if (t < 0) continue;
      const px = eye[0] + dirNorm[0] * t;
      const py = eye[1] + dirNorm[1] * t;
      const pz = eye[2] + dirNorm[2] * t;
      const d = Math.hypot(px - s.position.x, py - s.position.y, pz - s.position.z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best && this.onPick) this.onPick(best);
  }
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * pow;
}

function invert(m: Float32Array): Float32Array {
  const out = new Float32Array(16);
  const a = m;
  out[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  out[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  out[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  out[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  out[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  out[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  out[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  out[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  out[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  out[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  out[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  out[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  out[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  out[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  out[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  out[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  let det = a[0] * out[0] + a[1] * out[4] + a[2] * out[8] + a[3] * out[12];
  det = det || 1;
  for (let i = 0; i < 16; i++) out[i] /= det;
  return out;
}

function transform(m: Float32Array, v: number[]): number[] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
