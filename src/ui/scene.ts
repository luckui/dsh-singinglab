/**
 * 场景：一张插画铺满播放页，上面叠几层会动的东西（窗玻璃上的歌词、光束里的微尘、海面的闪光、窗台唱片机上转的唱片）。
 * 插画的哪块是玻璃、哪块是海，写在 assets/scene.json 里，坐标都是占整张图的比例（0..1），
 * 这样插画换了只改 json，不改代码。
 */

export interface Rect { x: number; y: number; w: number; h: number }

export interface SceneSpec {
  /** 插画文件名（assets 目录下） */
  image: string;
  /** 模糊小图，给歌库页当背景（可选，不给就用大图加模糊） */
  blurred?: string;
  width: number;
  height: number;
  /** 画面放不下时，尽量保住哪一点（比例坐标） */
  focus: [number, number];
  /** 裁的时候尽量整块留在画面里的区域（人和窗玻璃），放不下才只看 focus */
  keep?: Rect;
  /** 歌词映在这块玻璃上 */
  glass: Rect;
  /** 阳光光束（微尘在里面飘） */
  beam?: Rect & { angle: number };
  /** 海面（闪光） */
  sea?: Rect;
  /** 窗台唱片机上的唱片：中心、半径（占图宽的比例）、透视压扁（纵向缩放） */
  turntable?: { cx: number; cy: number; r: number; squash: number };
  /** 播放卡片放哪边 */
  card: 'left' | 'right';
}

export interface Placement {
  /** 图在容器里的缩放和偏移（像素） */
  scale: number;
  left: number;
  top: number;
}

/** 像 object-fit: cover 一样铺满，但裁的时候围着 focus 点 */
export function place(spec: SceneSpec, cw: number, ch: number): Placement {
  const scale = Math.max(cw / spec.width, ch / spec.height);
  const w = spec.width * scale, h = spec.height * scale;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let left = cw / 2 - spec.focus[0] * w;
  let top = ch / 2 - spec.focus[1] * h;
  const k = spec.keep;
  if (k) {
    // keep 放得下就把它整块挪进画面；放不下就让它居中
    const kx = k.x * w, kw = k.w * w, ky = k.y * h, kh = k.h * h;
    left = kw <= cw ? clamp(left, cw - kx - kw, -kx) : cw / 2 - (kx + kw / 2);
    top = kh <= ch ? clamp(top, ch - ky - kh, -ky) : ch / 2 - (ky + kh / 2);
  }
  return { scale, left: clamp(left, cw - w, 0), top: clamp(top, ch - h, 0) };
}

/** 图上的比例矩形 → 容器里的像素矩形 */
export function toPx(r: Rect, spec: SceneSpec, p: Placement) {
  return {
    left: p.left + r.x * spec.width * p.scale,
    top: p.top + r.y * spec.height * p.scale,
    width: r.w * spec.width * p.scale,
    height: r.h * spec.height * p.scale,
  };
}

/** 第一个大于 t 的位置 */
export function upper(xs: number[], t: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
