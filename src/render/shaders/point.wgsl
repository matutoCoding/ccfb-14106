// 测点小球：实例化渲染，球半径随测值大小变化，颜色按场值色带，预警实例闪烁
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  _pad: f32,
};
struct Params {
  valueMin: f32,
  valueMax: f32,
  baseRadius: f32,
  sizeGain: f32,
  time: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var rampTex: texture_1d<f32>;
@group(0) @binding(3) var rampSampler: sampler;

struct VsIn {
  @location(0) localPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) center: vec3<f32>,
  @location(3) valueAndAlert: vec4<f32>, // x=测值, y=预警等级0..1
  @location(4) dirs: vec4<f32>,
  @location(5) dir2: vec4<f32>,
};
struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) alert: f32,
};

@vertex
fn vs(vin: VsIn) -> VsOut {
  var out: VsOut;
  let vv = vin.valueAndAlert.x;
  let alert = vin.valueAndAlert.y;
  let mag = clamp(abs(vv) / max(1e-6, params.valueMax - params.valueMin), 0.0, 1.0);
  let r = params.baseRadius * (1.0 + params.sizeGain * mag);
  let world = vin.center + vin.localPos * r;
  out.clip = camera.viewProj * vec4<f32>(world, 1.0);
  out.normal = vin.normal;
  out.alert = alert;
  let t = (vv - params.valueMin) / max(1e-6, params.valueMax - params.valueMin);
  out.color = textureSampleLevel(rampTex, rampSampler, clamp(t, 0.0, 1.0), 0.0).rgb;
  return out;
}

@fragment
fn fs(vin: VsOut) -> @location(0) vec4<f32> {
  let N = normalize(vin.normal);
  let L = normalize(vec3<f32>(-0.45, 0.8, 0.35));
  let diff = clamp(dot(N, L), 0.0, 1.0);
  var rgb = vin.color * (0.4 + 0.6 * diff);
  let blink = 0.5 + 0.5 * sin(params.time * 7.0);
  rgb = mix(rgb, vec3<f32>(1.0, 0.15, 0.05), vin.alert * blink * 0.85);
  return vec4<f32>(rgb, 1.0);
}
