/**
 * 流动背景：封面取出的几块颜色，在一张很小的画布上慢慢漂，放大后自然是柔和的大色块。
 * 打在小节第一拍上轻轻亮一下；副歌整体更亮、漂得更快；换歌时颜色在一秒多里慢慢过渡过去。
 */

import React, { useEffect, useRef } from 'react';
import { getEngine } from './engine';
import { css, mix, type Palette, type RGB } from './palette';

const W = 120, H = 72;

interface Props { palette: Palette }

export function Backdrop({ palette }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef(palette);
  target.current = palette;

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const engine = getEngine();
    let shown: Palette = target.current;
    let from: Palette = shown;
    let lastShown: Palette = shown;
    let switchAt = 0;
    let last = performance.now();
    let phase = 0;
    let pulse = 0;
    let lastBeat = -1;
    let raf = 0;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // 换歌：从这一帧正在显示的颜色过渡到新色
      if (target.current !== shown) {
        from = lastShown;
        shown = target.current;
        switchAt = now;
      }
      const cur = shownPalette(from, shown, switchAt, now);
      lastShown = cur;
      const song = engine.state.current;
      const t = engine.time;
      const playing = engine.state.playing;
      // 节拍：过了一个小节首拍就亮一下
      if (song && playing) {
        const beats = song.downbeats;
        let i = lastBeat;
        if (i < 0 || i >= beats.length || beats[i] > t || (beats[i + 1] ?? Infinity) <= t) i = upper(beats, t) - 1;
        if (i !== lastBeat && i >= 0 && t - beats[i] < 0.25) pulse = 1;
        lastBeat = i;
      }
      pulse *= Math.exp(-dt * 3.2);
      const chorus = song?.sections.some((s) => s.kind === 'chorus' && t >= s.startSec && t < s.endSec) ?? false;
      const energy = engine.energy();
      const speed = reduce ? 0 : (playing ? (chorus ? 0.16 : 0.1) : 0.035) * (1 + energy * 0.8);
      phase += dt * speed;

      g.globalCompositeOperation = 'source-over';
      g.fillStyle = css(cur.base);
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'lighter';
      const glow = (chorus ? 0.62 : 0.5) + pulse * 0.16 + energy * 0.18;
      cur.blobs.forEach((c, k) => {
        const a = phase * (0.7 + k * 0.23) + k * 1.7;
        const x = W * (0.5 + 0.38 * Math.sin(a) * Math.cos(a * 0.37 + k));
        const y = H * (0.5 + 0.4 * Math.cos(a * 0.83 + k * 2.1));
        const r = W * (0.42 + 0.08 * Math.sin(a * 1.3 + k) + pulse * 0.05 + energy * 0.06);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, css(c, glow));
        grad.addColorStop(1, css(c, 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="sl-backdrop" aria-hidden>
      <canvas ref={ref} width={W} height={H} />
      <div className="sl-grain" />
    </div>
  );
}

const FADE_MS = 1400;
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

function shownPalette(from: Palette, to: Palette, at: number, now: number): Palette {
  const t = at ? Math.min(1, (now - at) / FADE_MS) : 1;
  return t >= 1 ? to : lerpPalette(from, to, ease(t));
}

function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  return {
    base: mix(a.base, b.base, t),
    accent: mix(a.accent, b.accent, t),
    blobs: b.blobs.map((c, i) => mix((a.blobs[i] ?? c) as RGB, c, t)),
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
