/** 色带：蓝(小/负) → 青 → 绿 → 黄 → 红(大/正)，等值线与点着色共用 */
export interface ColorStop {
  t: number;
  rgb: [number, number, number];
}

export const FIELD_RAMP: ColorStop[] = [
  { t: 0.0, rgb: [42, 88, 186] },
  { t: 0.25, rgb: [48, 176, 214] },
  { t: 0.5, rgb: [96, 196, 120] },
  { t: 0.75, rgb: [236, 200, 64] },
  { t: 1.0, rgb: [214, 62, 52] },
];

export function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < FIELD_RAMP.length - 1; i++) {
    const a = FIELD_RAMP[i];
    const b = FIELD_RAMP[i + 1];
    if (x >= a.t && x <= b.t) {
      const k = (x - a.t) / (b.t - a.t);
      return [
        (a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k) / 255,
        (a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k) / 255,
        (a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k) / 255,
      ];
    }
  }
  const last = FIELD_RAMP[FIELD_RAMP.length - 1].rgb;
  return [last[0] / 255, last[1] / 255, last[2] / 255];
}

/** 1D 色带纹理（256 纹素 RGBA8） */
export function buildRampTexture(device: GPUDevice): GPUTexture {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = rampColor(i / 255);
    data[i * 4] = Math.round(r * 255);
    data[i * 4 + 1] = Math.round(g * 255);
    data[i * 4 + 2] = Math.round(b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = device.createTexture({
    size: [256],
    dimension: '1d',
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: 1024, rowsPerImage: 1 }, [256]);
  return tex;
}
