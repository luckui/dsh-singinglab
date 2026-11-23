/**
 * 一首歌她要唱的音高：修音页（网页）和大肥鱼的修音工具（宿主端）共用这一份算法，两边看到的音符、改动结果才一样。
 *
 *   测到的 raw / 自动修过的 plan（10 ms 一帧的 Hz，0 = 不唱）+ 一条条改动 ops → compose() → 她要唱的音高线
 *   音高线 → notesOf() → 一个个音符（连着唱、音高差不到 0.8 个半音的一串帧；剪刀、合并再改一改）
 */

import type { EditOp } from './editor';

export const FPS = 100;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const hzOf = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const noteName = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

/**
 * 她（大肥鱼默认声音 plain200）唱每个音有多沙：沙帧（Praat HNR < 10 dB）占比，从 F#2（MIDI 42）起每个半音一格。
 * 11-18 实测（prepare.py 的 HOARSE 表）：A#3–E5 干净，往下越低越沙，F5 往上崩。换声音模型要重测。
 */
const HOARSE_FROM = 42;
const HOARSE = [.68, .73, .68, .74, .57, .56, .39, .34, .24, .19, .24, .14, .16, .14, .14, .17, .10, .08, .07, .08, .05, .05,
  .05, .05, .04, .04, .04, .05, .03, .03, .04, .03, .04, .07, .06, .28, .56, .83, .97, .98, 1.0, .99, 1.0, 1.0];
/** 她唱这个音（已经移过调的 MIDI）有多沙：0–1 */
export const hoarseAt = (m: number) => HOARSE[Math.min(HOARSE.length - 1, Math.max(0, Math.round(m) - HOARSE_FROM))];
/** 她唱着不哑的音域（沙得不到 10%）：A#3–E5 */
export const HER_LOW = 58, HER_HIGH = 76;

export interface Range { a: number; b: number }
export interface Note { a: number; b: number; midi: number }

/** 剪刀和合并：只改「哪些帧算一个音」，不改音高 */
export type Mark = { kind: 'cut'; a: number } | { kind: 'join'; a: number; b: number };

export const marksOf = (ops: EditOp[]): Mark[] => ops.flatMap((o): Mark[] => (o.kind === 'cut' ? [{ kind: 'cut', a: o.a }] : o.kind === 'join' ? [{ kind: 'join', a: o.a, b: o.b }] : []));

export const medianMidi = (f: Float32Array, a: number, b: number) => {
  const ms: number[] = [];
  for (let i = a; i < b; i++) if (f[i] > 0) ms.push(midiOf(f[i]));
  ms.sort((x, y) => x - y);
  return ms.length ? ms[ms.length >> 1] : 0;
};

/** 先自动切（autoNotes），再按顺序做剪刀和合并。offset：f 是从整首第几帧开始的一段 */
export function notesOf(f: Float32Array, marks: Mark[] = [], offset = 0): Note[] {
  let out = autoNotes(f);
  for (const m of marks) {
    if (m.kind === 'cut') {
      const c = m.a - offset;
      out = out.flatMap((n) => (c - n.a >= 2 && n.b - c >= 2
        ? [{ a: n.a, b: c, midi: medianMidi(f, n.a, c) }, { a: c, b: n.b, midi: medianMidi(f, c, n.b) }]
        : [n]));
    } else {
      const a = m.a - offset, b = m.b - offset;
      const hit = out.filter((n) => n.a < b && n.b > a);
      if (hit.length < 2) continue;
      const lo = Math.min(...hit.map((n) => n.a)), hi = Math.max(...hit.map((n) => n.b));
      out = [...out.filter((n) => !hit.includes(n)), { a: lo, b: hi, midi: medianMidi(f, lo, hi) }].sort((x, y) => x.a - y.a);
    }
  }
  return out;
}

/** 连着唱、音高差不到 0.8 个半音的一串帧算一个音 */
export function autoNotes(f: Float32Array): Note[] {
  const out: Note[] = [];
  let a = -1;
  const push = (b: number) => {
    if (a >= 0 && b - a >= 4) {
      const ms = Array.from(f.subarray(a, b)).map(midiOf).sort((x, y) => x - y);
      out.push({ a, b, midi: ms[ms.length >> 1] });
    }
  };
  for (let i = 0; i <= f.length; i++) {
    const v = i < f.length && f[i] > 0;
    if (!v) { push(i); a = -1; continue; }
    if (a < 0) { a = i; continue; }
    if (Math.abs(midiOf(f[i]) - midiOf(f[i - 1])) > 0.8) { push(i); a = i; }
  }
  return out;
}

/** 测到的 / 自动修过的 + 一条条改动 → 她要唱的音高 */
export function compose(raw: Float32Array, plan: Float32Array | null, ops: EditOp[]): Float32Array {
  const f = Float32Array.from(plan ?? raw);
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind === 'cut' || op.kind === 'join') continue;
    const a = Math.max(0, op.a), b = Math.min(f.length, op.b);
    if (op.kind === 'snap' || op.kind === 'tune') {
      const center = op.kind === 'snap' ? 1 : op.center, flatten = op.kind === 'snap' ? 0 : op.flatten;
      for (const n of notesOf(f.subarray(a, b), marksOf(ops.slice(0, k)), a)) { // 按剪过、并过的音来对准
        const target = n.midi + (Math.round(n.midi) - n.midi) * center;
        for (let i = a + n.a; i < a + n.b; i++) if (f[i] > 0) f[i] = hzOf(target + (midiOf(f[i]) - n.midi) * (1 - flatten));
      }
      continue;
    }
    for (let i = a; i < b; i++) {
      if (op.kind === 'source') f[i] = op.source === 'raw' ? raw[i] : (plan ?? raw)[i];
      else if (op.kind === 'draw') { const hz = op.hz[i - op.a]; if (f[i] > 0 && hz > 0) f[i] = hz; }
      else if (f[i] > 0) f[i] *= 2 ** (op.semitones / 12);
    }
  }
  return f;
}
