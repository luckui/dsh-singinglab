/** 从封面取色：几块主色给流动背景，一个亮色给进度条和高亮。全在浏览器里算，封面是同源的。 */

export type RGB = [number, number, number];

export interface Palette {
  /** 背景底色（深） */
  base: RGB;
  /** 流动色块，4 个 */
  blobs: RGB[];
  /** 强调色（亮、饱和） */
  accent: RGB;
}

export const DEFAULT_PALETTE: Palette = {
  base: [14, 22, 44],
  blobs: [[52, 120, 220], [255, 140, 170], [80, 200, 210], [140, 110, 240]],
  accent: [120, 200, 255],
};

function toHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function toRgb(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** 把一个颜色挪到指定的饱和度、亮度范围里 */
function shape(c: RGB, sMin: number, lMin: number, lMax: number): RGB {
  const [h, s, l] = toHsl(c);
  return toRgb(h, Math.max(s, sMin), Math.min(lMax, Math.max(lMin, l)));
}

export function extractPalette(img: HTMLImageElement): Palette {
  const w = 48, h = 30;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return DEFAULT_PALETTE;
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  // 按色相分 18 桶，桶的分量 = 像素数 × (0.25 + 饱和度)；太黑太白的像素只算进底色
  const buckets = Array.from({ length: 18 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  let dr = 0, dg = 0, db = 0, dn = 0;
  for (let i = 0; i < data.length; i += 4) {
    const c: RGB = [data[i], data[i + 1], data[i + 2]];
    const [hh, s, l] = toHsl(c);
    dr += c[0]; dg += c[1]; db += c[2]; dn++;
    if (l < 0.12 || l > 0.92 || s < 0.12) continue;
    const k = Math.floor(hh * 18) % 18;
    const wgt = 0.25 + s;
    const bk = buckets[k];
    bk.weight += wgt; bk.r += c[0] * wgt; bk.g += c[1] * wgt; bk.b += c[2] * wgt;
  }
  const avg: RGB = dn ? [dr / dn, dg / dn, db / dn] : DEFAULT_PALETTE.base;
  const ranked = buckets
    .map((b, k) => ({ k, weight: b.weight, c: b.weight ? [b.r / b.weight, b.g / b.weight, b.b / b.weight] as RGB : null }))
    .filter((b) => b.c)
    .sort((a, b) => b.weight - a.weight);
  // 挑色相相互隔开的几块
  const picked: RGB[] = [];
  const used: number[] = [];
  for (const b of ranked) {
    if (used.some((k) => Math.min(Math.abs(k - b.k), 18 - Math.abs(k - b.k)) < 2)) continue;
    used.push(b.k);
    picked.push(b.c!);
    if (picked.length === 4) break;
  }
  if (!picked.length) {
    // 几乎是黑白封面：用均色的冷暖做一组柔和的色
    const [hh] = toHsl(avg);
    for (let i = 0; i < 4; i++) picked.push(toRgb((hh + i * 0.08) % 1, 0.35, 0.5));
  }
  while (picked.length < 4) picked.push(picked[picked.length % Math.max(1, picked.length)]);
  const blobs = picked.map((c) => shape(c, 0.45, 0.38, 0.62));
  const [bh, bs] = toHsl(picked[0]);
  const base = toRgb(bh, Math.min(0.55, Math.max(0.25, bs * 0.7)), 0.1);
  const accent = shape(picked[0], 0.6, 0.66, 0.76);
  return { base, blobs, accent };
}

export const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
