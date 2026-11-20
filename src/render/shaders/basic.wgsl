// 基础无光照着色器：地基、廊道线、横缝线、水面
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  _pad: f32,
};
struct Params {
  color: vec4<f32>,
  yOffset: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> params: Params;

struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};
struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) worldPos: vec3<f32>,
};

@vertex
fn vs(in: VsIn) -> VsOut {
  var out: VsOut;
  let p = vec3<f32>(in.position.x, in.position.y + params.yOffset, in.position.z);
  out.clip = camera.viewProj * vec4<f32>(p, 1.0);
  out.normal = in.normal;
  out.worldPos = p;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let N = normalize(in.normal);
  let L = normalize(vec3<f32>(-0.45, 0.8, 0.35));
  let diff = clamp(dot(N, L), 0.0, 1.0);
  return vec4<f32>(params.color.rgb * (0.45 + 0.55 * diff), params.color.a);
}
