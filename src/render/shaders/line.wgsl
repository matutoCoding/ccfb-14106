// 线段着色器（廊道、横缝、矢量箭头的杆部）
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> camera: Camera;
struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};
struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex
fn vs(in: VsIn) -> VsOut {
  var out: VsOut;
  out.clip = camera.viewProj * vec4<f32>(in.position, 1.0);
  out.color = in.color;
  return out;
}
@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return in.color;
}
