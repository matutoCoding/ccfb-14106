/**
 * WebGPU 渲染器
 * 管线：坝面(变形/等值线/影子)、地基、水面、廊道/横缝线、测点球(实例化)、位移矢量
 * 时间轴播放时每帧只更新少量 storage/uniform 缓冲，不重建资源
 */
import type { MeshData, LineData } from '../core/dam/geometry';
import { OrbitCamera } from './camera';
import { buildRampTexture } from './color-ramp';
import damWgsl from './shaders/dam.wgsl?raw';
import basicWgsl from './shaders/basic.wgsl?raw';
import lineWgsl from './shaders/line.wgsl?raw';
import pointWgsl from './shaders/point.wgsl?raw';

export interface PointInstance {
  center: [number, number, number];
  value: number;
  alert: number; // 0..1
  radialDir: [number, number, number];
  tangentialDir: [number, number, number];
}

export interface VectorSegment {
  from: [number, number, number];
  to: [number, number, number];
  color: [number, number, number, number];
}

const CAMERA_SIZE = 80;
const DEFORM_SIZE = 48; // WGSL Deform 结构 9×f32=36，uniform 对齐到 16 的倍数
const BASIC_PARAM_SIZE = 32;
const POINT_PARAM_SIZE = 32;
const MAX_INSTANCES = 512;
const MAX_LINES = 12000;

export class DamRenderer {
  device!: GPUDevice;
  context!: GPUCanvasContext;
  format!: GPUTextureFormat;
  camera = new OrbitCamera();
  private pipelines: Record<string, GPURenderPipeline> = {};
  private cameraBuffer!: GPUBuffer;
  private deformBuffer!: GPUBuffer;
  private basicParamBuffer!: GPUBuffer;
  private pointParamBuffer!: GPUBuffer;
  private rampTex!: GPUTexture;
  private sampler!: GPUSampler;
  private fieldBuffer!: GPUBuffer;
  private jointBuffer!: GPUBuffer;
  private depthTex!: GPUTexture;
  private canvas!: HTMLCanvasElement;
  private faceVertexCount = 0;
  private pointInstances: PointInstance[] = [];
  private vectorSegs: VectorSegment[] = [];
  private pointCapacity = 0;
  private pointVertexCount = 0;
  private pointVB!: GPUBuffer;
  private pointIB!: GPUBuffer;
  private lineVB!: GPUBuffer;
  private lineVertexCount = 0;
  private lineCapacity = MAX_LINES;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    if (!navigator.gpu) throw new Error('当前浏览器不支持 WebGPU，请使用 Chrome/Edge 113+ 或 Safari 18+');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未找到可用 GPU 适配器');
    this.device = await adapter.requestDevice();
    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    this.cameraBuffer = this.makeBuffer(CAMERA_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.deformBuffer = this.makeBuffer(DEFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.basicParamBuffer = this.makeBuffer(BASIC_PARAM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.pointParamBuffer = this.makeBuffer(POINT_PARAM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.rampTex = buildRampTexture(this.device);
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.fieldBuffer = this.makeBuffer(40000 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.jointBuffer = this.makeBuffer(64 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.lineVB = this.makeBuffer(this.lineCapacity * 7 * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);

    this.buildPipelines();
    this.buildPointGeometry();
    this.attachControls(canvas);
  }

  /** 页面切换后 canvas 元素重建：仅重新获取并配置上下文，复用全部 GPU 资源与管线 */
  reattachCanvas(canvas: HTMLCanvasElement): void {
    if (canvas === this.canvas) return;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    this.depthTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: [Math.max(1, canvas.width), Math.max(1, canvas.height)],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.attachControls(canvas);
  }

  private makeBuffer(size: number, usage: number): GPUBuffer {
    return this.device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage });
  }

  private buildPipelines(): void {
    const cameraBG: GPUBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    // 坝面管线
    const damModule = this.device.createShaderModule({ code: damWgsl });
    const rampLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '1d' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const fieldLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const damLayout = this.device.createPipelineLayout({ bindGroupLayouts: [rampLayout, fieldLayout] });
    const damVertex: GPUVertexBufferLayout[] = [
      {
        arrayStride: 16 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x3' },
          { shaderLocation: 3, offset: 36, format: 'float32x3' },
          { shaderLocation: 4, offset: 48, format: 'float32' },
        ],
      },
    ];
    const damDesc: GPURenderPipelineDescriptor = {
      layout: damLayout,
      vertex: { module: damModule, entryPoint: 'vs', buffers: damVertex },
      fragment: { module: damModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    };
    this.pipelines.dam = this.device.createRenderPipeline(damDesc);
    this.pipelines.shadow = this.device.createRenderPipeline({
      ...damDesc,
      fragment: {
        module: damModule,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
      },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' },
    });

    // 基础面（地基/水面）
    const basicModule = this.device.createShaderModule({ code: basicWgsl });
    const basicLayout = this.device.createPipelineLayout({ bindGroupLayouts: [cameraBG] });
    const basicVertex: GPUVertexBufferLayout[] = [
      {
        arrayStride: 6 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      },
    ];
    this.pipelines.basic = this.device.createRenderPipeline({
      layout: basicLayout,
      vertex: { module: basicModule, entryPoint: 'vs', buffers: basicVertex },
      fragment: { module: basicModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });
    this.pipelines.water = this.device.createRenderPipeline({
      layout: basicLayout,
      vertex: { module: basicModule, entryPoint: 'vs', buffers: basicVertex },
      fragment: {
        module: basicModule,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' },
    });

    // 线段
    const lineModule = this.device.createShaderModule({ code: lineWgsl });
    this.pipelines.line = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [
          this.device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
          }),
        ],
      }),
      vertex: {
        module: lineModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 7 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module: lineModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    // 测点小球（实例化）
    const pointModule = this.device.createShaderModule({ code: pointWgsl });
    this.pipelines.point = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [
          this.device.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
              { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
              { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '1d' } },
              { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
            ],
          }),
        ],
      }),
      vertex: {
        module: pointModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 6 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
          {
            stepMode: 'instance',
            arrayStride: 15 * 4,
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'float32x3' },
              { shaderLocation: 3, offset: 12, format: 'float32x4' },
              { shaderLocation: 4, offset: 28, format: 'float32x4' },
              { shaderLocation: 5, offset: 44, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module: pointModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });
  }

  /** 低分辨率球体（经纬网格），实例化复用 */
  private buildPointGeometry(): void {
    const lat = 8;
    const lon = 10;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= lat; i++) {
      const theta = (Math.PI * i) / lat;
      for (let j = 0; j <= lon; j++) {
        const phi = (2 * Math.PI * j) / lon;
        const nx = Math.sin(theta) * Math.cos(phi);
        const ny = Math.cos(theta);
        const nz = Math.sin(theta) * Math.sin(phi);
        verts.push(nx, ny, nz, nx, ny, nz);
      }
    }
    const row = lon + 1;
    for (let i = 0; i < lat; i++) {
      for (let j = 0; j < lon; j++) {
        const a = i * row + j;
        idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    this.pointVertexCount = idx.length;
    this.pointVB = this.makeBuffer(verts.length * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(this.pointVB, 0, new Float32Array(verts));
    this.pointIB = this.makeBuffer(idx.length * 4, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(this.pointIB, 0, new Uint32Array(idx));
  }

  /** 上传静态网格 */
  uploadMesh(mesh: MeshData): GPUBuffer {
    const interleaved = new Float32Array(mesh.vertexCount * 16);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const o = i * 16;
      interleaved.set(mesh.positions.subarray(i * 3, i * 3 + 3), o);
      interleaved.set(mesh.normals.subarray(i * 3, i * 3 + 3), o + 3);
      interleaved.set(mesh.radialDirs.subarray(i * 3, i * 3 + 3), o + 6);
      interleaved.set(mesh.tangentialDirs.subarray(i * 3, i * 3 + 3), o + 9);
      interleaved[o + 12] = mesh.monolithIds[i];
    }
    const vb = this.makeBuffer(interleaved.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(vb, 0, interleaved);
    return vb;
  }

  uploadIndexBuffer(mesh: MeshData): GPUBuffer {
    const ib = this.makeBuffer(mesh.indices.byteLength, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(ib, 0, mesh.indices);
    return ib;
  }

  /** 简单面网格（地基/水面，仅位置+法线） */
  uploadSimpleMesh(mesh: MeshData): { vb: GPUBuffer; ib: GPUBuffer; count: number } {
    const interleaved = new Float32Array(mesh.vertexCount * 6);
    for (let i = 0; i < mesh.vertexCount; i++) {
      interleaved.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * 6);
      interleaved.set(mesh.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    }
    const vb = this.makeBuffer(interleaved.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(vb, 0, interleaved);
    const ib = this.makeBuffer(mesh.indices.byteLength, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(ib, 0, mesh.indices);
    return { vb, ib, count: mesh.indices.length };
  }

  uploadLines(lines: LineData[], color: [number, number, number, number]): { vb: GPUBuffer; vertices: number } {
    const data: number[] = [];
    let count = 0;
    for (const line of lines) {
      for (let i = 0; i < line.vertexCount - 1; i++) {
        const a = i * 3;
        const b = (i + 1) * 3;
        data.push(line.positions[a], line.positions[a + 1], line.positions[a + 2], ...color);
        data.push(line.positions[b], line.positions[b + 1], line.positions[b + 2], ...color);
        count += 2;
      }
    }
    const vb = this.makeBuffer(data.length * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(vb, 0, new Float32Array(data));
    return { vb, vertices: count };
  }

  setFaceVertexCount(n: number): void {
    this.faceVertexCount = n;
  }

  updateField(values: Float32Array): void {
    const need = values.byteLength;
    if (need > this.fieldBuffer.size) {
      this.fieldBuffer.destroy();
      this.fieldBuffer = this.makeBuffer(need, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    }
    this.device.queue.writeBuffer(this.fieldBuffer, 0, values);
  }

  updateJointOffsets(offsets: Float32Array): void {
    this.device.queue.writeBuffer(this.jointBuffer, 0, offsets);
  }

  setPointInstances(instances: PointInstance[]): void {
    this.pointInstances = instances;
  }

  setVectors(segs: VectorSegment[]): void {
    this.vectorSegs = segs;
  }

  private ensurePointCapacity(n: number): void {
    if (n <= this.pointCapacity) return;
    this.pointCapacity = Math.max(n, 64);
    this.pointInstanceBuffer?.destroy();
    this.pointInstanceBuffer = this.makeBuffer(this.pointCapacity * 15 * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
  }
  private pointInstanceBuffer!: GPUBuffer;

  private writePointInstances(): void {
    const n = this.pointInstances.length;
    if (n === 0) return;
    this.ensurePointCapacity(n);
    const data = new Float32Array(n * 15);
    for (let i = 0; i < n; i++) {
      const p = this.pointInstances[i];
      const o = i * 15;
      data.set(p.center, o);
      data[o + 3] = p.value;
      data[o + 4] = p.alert;
      data[o + 5] = 0;
      data[o + 6] = 0;
      data.set(p.radialDir, o + 7);
      data.set(p.tangentialDir, o + 11);
      data[o + 14] = 0;
    }
    this.device.queue.writeBuffer(this.pointInstanceBuffer, 0, data);
  }

  private writeDynamicLines(): void {
    // 矢量箭头：杆 + 箭头三角（用两条短线近似箭头翼）
    const segs: number[] = [];
    for (const s of this.vectorSegs) {
      segs.push(...s.from, ...s.color, ...s.to, ...s.color);
      const dx = s.to[0] - s.from[0];
      const dy = s.to[1] - s.from[1];
      const dz = s.to[2] - s.from[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const uz = dz / len;
      // 垂直参考向量
      const ax = Math.abs(uy) > 0.9 ? 1 : 0;
      const ay = Math.abs(uy) > 0.9 ? 0 : 1;
      const wing = Math.min(6, len * 0.25);
      const w1x = s.to[0] - ux * wing + (ay * 0.6 - ax * 0.0) * wing * 0.7;
      const w1y = s.to[1] - uy * wing + (ax * 0.6) * wing * 0.7;
      const w1z = s.to[2] - uz * wing;
      segs.push(s.to[0], s.to[1], s.to[2], ...s.color, w1x, w1y, w1z, ...s.color);
    }
    this.lineVertexCount = segs.length / 7;
    if (this.lineVertexCount > this.lineCapacity) {
      this.lineCapacity = Math.ceil(this.lineVertexCount / 512) * 512;
      this.lineVB.destroy();
      this.lineVB = this.makeBuffer(this.lineCapacity * 7 * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    }
    if (segs.length) this.device.queue.writeBuffer(this.lineVB, 0, new Float32Array(segs));
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.depthTex?.destroy();
      this.depthTex = this.device.createTexture({
        size: [w, h],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
  }

  render(opts: {
    damVB: GPUBuffer;
    damIB: GPUBuffer;
    damIndexCount: number;
    foundation?: { vb: GPUBuffer; ib: GPUBuffer; count: number };
    waterMesh?: { vb: GPUBuffer; ib: GPUBuffer; count: number; yOffset: number };
    galleryLines?: { vb: GPUBuffer; vertices: number };
    jointLines?: { vb: GPUBuffer; vertices: number };
    showShadow: boolean;
    showGalleries: boolean;
    showWater: boolean;
    exaggeration: number;
    valueMin: number;
    valueMax: number;
    contourStep: number;
    pointParams: { baseRadius: number; sizeGain: number };
    timeSeconds: number;
    anyAlert: boolean;
  }): void {
    this.resize();
    const aspect = this.canvas.width / this.canvas.height;
    const viewProj = this.camera.viewProj(aspect);
    const eye = this.camera.eye();
    const camData = new Float32Array(20);
    camData.set(viewProj, 0);
    camData[16] = eye[0];
    camData[17] = eye[1];
    camData[18] = eye[2];
    this.device.queue.writeBuffer(this.cameraBuffer, 0, camData);

    const deform = new Float32Array(DEFORM_SIZE / 4);
    deform[0] = opts.exaggeration;
    deform[1] = opts.valueMin;
    deform[2] = opts.valueMax;
    deform[3] = opts.contourStep;
    deform[4] = opts.timeSeconds;
    this.device.queue.writeBuffer(this.deformBuffer, 0, deform);

    this.writePointInstances();
    this.writeDynamicLines();

    const rampBG = this.device.createBindGroup({
      layout: this.pipelines.dam.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.deformBuffer } },
        { binding: 2, resource: this.rampTex.createView({ dimension: '1d' }) },
        { binding: 3, resource: this.sampler },
      ],
    });
    const fieldBG = this.device.createBindGroup({
      layout: this.pipelines.dam.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: this.fieldBuffer } },
        { binding: 1, resource: { buffer: this.jointBuffer } },
      ],
    });
    const basicBG = this.device.createBindGroup({
      layout: this.pipelines.basic.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }, { binding: 1, resource: { buffer: this.basicParamBuffer } }],
    });
    const lineBG = this.device.createBindGroup({
      layout: this.pipelines.line.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });
    const pointBG = this.device.createBindGroup({
      layout: this.pipelines.point.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.pointParamBuffer } },
        { binding: 2, resource: this.rampTex.createView({ dimension: '1d' }) },
        { binding: 3, resource: this.sampler },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.07, g: 0.09, b: 0.12, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // 地基
    if (opts.foundation) {
      this.setBasicParams([0.32, 0.3, 0.26, 1], 0);
      pass.setPipeline(this.pipelines.basic);
      pass.setBindGroup(0, basicBG);
      pass.setVertexBuffer(0, opts.foundation.vb);
      pass.setIndexBuffer(opts.foundation.ib, 'uint32');
      pass.drawIndexed(opts.foundation.count);
    }

    // 水面
    if (opts.showWater && opts.waterMesh) {
      this.setBasicParams([0.16, 0.38, 0.62, 0.42], opts.waterMesh.yOffset);
      pass.setPipeline(this.pipelines.water);
      pass.setBindGroup(0, basicBG);
      pass.setVertexBuffer(0, opts.waterMesh.vb);
      pass.setIndexBuffer(opts.waterMesh.ib, 'uint32');
      pass.drawIndexed(opts.waterMesh.count);
    }

    // 半透明原始轮廓影子（scale=0 由 deform.mode=1 控制，这里重画同网格）
    if (opts.showShadow) {
      const shadowDeform = new Float32Array(DEFORM_SIZE / 4);
      shadowDeform.set(deform);
      shadowDeform[0] = 0;
      shadowDeform[5] = 1; // mode
      this.device.queue.writeBuffer(this.deformBuffer, 0, shadowDeform);
      pass.setPipeline(this.pipelines.shadow);
      pass.setBindGroup(0, rampBG);
      pass.setBindGroup(1, fieldBG);
      pass.setVertexBuffer(0, opts.damVB);
      pass.setIndexBuffer(opts.damIB, 'uint32');
      pass.drawIndexed(opts.damIndexCount);
      this.device.queue.writeBuffer(this.deformBuffer, 0, deform);
    }

    // 坝体
    pass.setPipeline(this.pipelines.dam);
    pass.setBindGroup(0, rampBG);
    pass.setBindGroup(1, fieldBG);
    pass.setVertexBuffer(0, opts.damVB);
    pass.setIndexBuffer(opts.damIB, 'uint32');
    pass.drawIndexed(opts.damIndexCount);

    // 廊道与横缝线
    if (opts.showGalleries && opts.galleryLines) {
      pass.setPipeline(this.pipelines.line);
      pass.setBindGroup(0, lineBG);
      pass.setVertexBuffer(0, opts.galleryLines.vb);
      pass.draw(opts.galleryLines.vertices);
    }
    if (opts.jointLines) {
      pass.setPipeline(this.pipelines.line);
      pass.setBindGroup(0, lineBG);
      pass.setVertexBuffer(0, opts.jointLines.vb);
      pass.draw(opts.jointLines.vertices);
    }
    // 动态矢量
    if (this.lineVertexCount > 0) {
      pass.setPipeline(this.pipelines.line);
      pass.setBindGroup(0, lineBG);
      pass.setVertexBuffer(0, this.lineVB);
      pass.draw(this.lineVertexCount);
    }

    // 测点小球
    if (this.pointInstances.length > 0) {
      const pp = new Float32Array(POINT_PARAM_SIZE / 4);
      pp[0] = opts.valueMin;
      pp[1] = opts.valueMax;
      pp[2] = opts.pointParams.baseRadius;
      pp[3] = opts.pointParams.sizeGain;
      pp[4] = opts.timeSeconds;
      this.device.queue.writeBuffer(this.pointParamBuffer, 0, pp);
      pass.setPipeline(this.pipelines.point);
      pass.setBindGroup(0, pointBG);
      pass.setVertexBuffer(0, this.pointVB);
      pass.setVertexBuffer(1, this.pointInstanceBuffer);
      pass.setIndexBuffer(this.pointIB, 'uint32');
      pass.drawIndexed(this.pointVertexCount, this.pointInstances.length);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private setBasicParams(color: [number, number, number, number], yOffset: number): void {
    const p = new Float32Array(BASIC_PARAM_SIZE / 4);
    p.set(color, 0);
    p[4] = yOffset;
    this.device.queue.writeBuffer(this.basicParamBuffer, 0, p);
  }

  private attachControls(canvas: HTMLCanvasElement): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let mode: 'rotate' | 'pan' = 'rotate';
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (mode === 'rotate') this.camera.rotate(dx, dy);
      else this.camera.pan(dx, dy);
    });
    canvas.addEventListener('pointerup', () => (dragging = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.zoom(e.deltaY);
      },
      { passive: false },
    );
  }
}
