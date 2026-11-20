// 坝面着色器：按场值着色 + 顶点着色器按放大倍数推位移 + 横缝开合 + 等值线描边
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  _pad: f32,
};
struct Deform {
  scale: f32,        // 变形放大倍数（0 时回到原始几何）
  valueMin: f32,
  valueMax: f32,
  contourStep: f32, // 等值线间距，<=0 关闭
  time: f32,
  mode: f32,         // 0 实体 1 半透明影子
  flash: f32,        // 预警闪烁强度
  _p2: f32,
  _p3: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> deform: Deform;
@group(0) @binding(2) var rampTex: texture_1d<f32>;
@group(0) @binding(3) var rampSampler: sampler;
@group(1) @binding(0) var<storage, read> fieldValues: array<f32>;
@group(1) @binding(1) var<storage, read> jointOffsets: array<f32>; // 按坝段号的切向平移量(m)

struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) radial: vec3<f32>,
  @location(3) tangential: vec3<f32>,
  @location(4) monolithId: f32,
};
struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) worldPos: vec3<f32>,
  @location(3) fieldV: f32,
};

fn ramp(t: f32) -> vec3<f32> {
  return textureSampleLevel(rampTex, rampSampler, clamp(t, 0.0, 1.0), 0.0).rgb;
}

@vertex
fn vs(vin: VsIn, @builtin(vertex_index) vidx: u32) -> VsOut {
  var out: VsOut;
  let vv = fieldValues[vidx];
  let midx = i32(vin.monolithId);
  // 横缝开合：按坝段整体切向平移（缝两侧反向运动形成缝隙）
  var jointShift = 0.0;
  if (midx >= 0) {
    jointShift = jointOffsets[midx];
  }
  let world = vin.position
    + vin.radial * vv * 0.001 * deform.scale
    + vin.tangential * jointShift * 0.001 * deform.scale;
  out.clip = camera.viewProj * vec4<f32>(world, 1.0);
  out.worldPos = world;
  out.normal = vin.normal;
  out.fieldV = vv;
  let t = (vv - deform.valueMin) / max(1e-6, deform.valueMax - deform.valueMin);
  out.color = ramp(t);
  return out;
}

@fragment
fn fs(vin: VsOut) -> @location(0) vec4<f32> {
  if (deform.mode > 0.5) {
    // 半透明原始轮廓影子（线框感的冷灰色）
    return vec4<f32>(0.55, 0.62, 0.72, 0.16);
  }
  // 等值线：场值对步长取模，用屏幕空间导数 fwidth 做抗锯齿描边
  var base = vin.color;
  if (deform.contourStep > 0.0) {
    let r = vin.fieldV / deform.contourStep;
    let d = abs(fract(r) - 0.5);
    let lineAmt = 1.0 - smoothstep(0.42, 0.42 + fwidth(r) * 1.2 + 0.008, d);
    base = mix(base, vec3<f32>(0.06, 0.07, 0.09), lineAmt * 0.85);
  }
  // 简单漫反射 + 环境光
  let N = normalize(vin.normal);
  let L = normalize(vec3<f32>(-0.45, 0.8, 0.35));
  let diff = clamp(dot(N, L), 0.0, 1.0);
  let lit = base * (0.38 + 0.62 * diff);
  // 预警闪烁叠加红光
  let blink = 0.5 + 0.5 * sin(deform.time * 6.0);
  let finalRgb = mix(lit, vec3<f32>(1.0, 0.12, 0.08), deform.flash * blink * 0.7);
  return vec4<f32>(finalRgb, 1.0);
}
