/**
 * 确定性伪随机数与高斯噪声（mulberry32），保证生成数据可复现、回归可核验
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0,1) 均匀分布 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 标准正态分布（Box-Muller） */
  gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 均值 mu、标准差 sigma 的正态样本 */
  normal(mu: number, sigma: number): number {
    return mu + sigma * this.gaussian();
  }

  /** [min,max) 均匀 */
  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** 以概率 p 返回 true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 生成子随机源（按名字稳定派生） */
  branch(tag: string): Rng {
    let h = 2166136261;
    for (let i = 0; i < tag.length; i++) {
      h = Math.imul(h ^ tag.charCodeAt(i), 16777619);
    }
    return new Rng((this.state ^ h) >>> 0);
  }
}

/** 字符串稳定哈希 → 32 位种子 */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}
