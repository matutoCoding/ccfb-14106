/** 列主序 4x4 矩阵与轨道相机（零依赖，配合 WebGPU 缓冲布局） */
export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

export function mat4LookAt(eye: [number, number, number], target: [number, number, number], up: [number, number, number]): Mat4 {
  const zx = eye[0] - target[0];
  const zy = eye[1] - target[1];
  const zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  const fz0 = zx / len;
  const fz1 = zy / len;
  const fz2 = zz / len;
  // x = up × z
  const xx = up[1] * fz2 - up[2] * fz1;
  const xy = up[2] * fz0 - up[0] * fz2;
  const xz = up[0] * fz1 - up[1] * fz0;
  len = Math.hypot(xx, xy, xz) || 1;
  const fx0 = xx / len;
  const fx1 = xy / len;
  const fx2 = xz / len;
  // y = z × x
  const fy0 = fz1 * fx2 - fz2 * fx1;
  const fy1 = fz2 * fx0 - fz0 * fx2;
  const fy2 = fz0 * fx1 - fz1 * fx0;
  const m = new Float32Array(16);
  m[0] = fx0; m[1] = fy0; m[2] = fz0; m[3] = 0;
  m[4] = fx1; m[5] = fy1; m[6] = fz1; m[7] = 0;
  m[8] = fx2; m[9] = fy2; m[10] = fz2; m[11] = 0;
  m[12] = -(fx0 * eye[0] + fx1 * eye[1] + fx2 * eye[2]);
  m[13] = -(fy0 * eye[0] + fy1 * eye[1] + fy2 * eye[2]);
  m[14] = -(fz0 * eye[0] + fz1 * eye[1] + fz2 * eye[2]);
  m[15] = 1;
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** 轨道相机：球坐标绕目标点旋转 */
export class OrbitCamera {
  target: [number, number, number] = [0, 110, 20];
  distance = 1050;
  azimuth = 0.62; // 绕 y，从下游偏右岸观察拱坝曲面
  elevation = 0.5; // 俯仰
  fovy = (50 * Math.PI) / 180;
  near = 1;
  far = 6000;

  eye(): [number, number, number] {
    const ce = Math.cos(this.elevation);
    return [
      this.target[0] + this.distance * ce * Math.sin(this.azimuth),
      this.target[1] + this.distance * Math.sin(this.elevation),
      this.target[2] + this.distance * ce * Math.cos(this.azimuth),
    ];
  }

  viewProj(aspect: number): Mat4 {
    const view = mat4LookAt(this.eye(), this.target, [0, 1, 0]);
    const proj = mat4Perspective(this.fovy, aspect, this.near, this.far);
    return mat4Multiply(proj, view);
  }

  rotate(dx: number, dy: number): void {
    this.azimuth -= dx * 0.005;
    this.elevation = Math.max(-1.35, Math.min(1.45, this.elevation + dy * 0.005));
  }

  pan(dx: number, dy: number): void {
    const scale = this.distance * 0.0016;
    this.target[0] -= dx * scale * Math.cos(this.azimuth);
    this.target[2] += dx * scale * Math.sin(this.azimuth);
    this.target[1] += dy * scale;
  }

  zoom(delta: number): void {
    this.distance = Math.max(120, Math.min(3200, this.distance * (1 + delta * 0.0012)));
  }
}
