/**
 * 轻量线性代数：矩阵求解、最小二乘（Cholesky 分解法解正规方程）
 * 全部纯函数、零依赖，可在 Node 与浏览器中运行
 */

/** 解 L L^T x = b，A 为对称正定矩阵（行列主序 n*n） */
export function choleskySolve(a: Float64Array, n: number, b: Float64Array): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (sum <= 1e-12) throw new Error('矩阵非正定，Cholesky 分解失败');
        L[i * n + i] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  // 前向代入 Ly = b
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  // 回代 L^T x = y
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

/**
 * 多元线性最小二乘 y = X β
 * @param x  m 行 p 列（行主序）
 * @param y  长度 m
 * @returns  β（长度 p）
 */
export function leastSquares(x: Float64Array, m: number, p: number, y: Float64Array): Float64Array {
  const ata = new Float64Array(p * p);
  const aty = new Float64Array(p);
  for (let i = 0; i < m; i++) {
    const row = i * p;
    for (let a = 0; a < p; a++) {
      const xa = x[row + a];
      aty[a] += xa * y[i];
      for (let b = 0; b < p; b++) ata[a * p + b] += xa * x[row + b];
    }
  }
  // 岭回归微扰动，提升共线性下的数值稳定性（h..h^4 高度相关）
  for (let a = 1; a < p; a++) ata[a * p + a] += 1e-8 * ata[a * p + a];
  return choleskySolve(ata, p, aty);
}

export function mean(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s / v.length;
}

export function std(v: ArrayLike<number>): number {
  const mu = mean(v);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const d = v[i] - mu;
    s += d * d;
  }
  return Math.sqrt(s / (v.length - 1));
}

/** 向量点积 */
export function dot3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function normalize3(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
