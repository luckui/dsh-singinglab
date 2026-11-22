/**
 * 场景里额外会动的东西（scene-*.json 的 fx），叠在会动的插画上：
 *   glow        一团光（台灯、月亮）：慢慢起伏，偶尔轻轻闪一下；放歌时跟着低频亮一点
 *   lighthouse  灯塔：光束绕着转，转到正对我们时灯头亮一下，侧过去时一条长长的光扫过海面
 *   rainfall    窗外的雨丝（只在给的几块玻璃里）
 *   birds       白天偶尔飞过的海鸥
 * 坐标都是插画的比例坐标，按 Placement 换成像素。和插画在同一个会动的容器里。
 */

import React, { useEffect, useRef } from 'react';
import { getEngine } from './engine';
import type { Fx, Placement, SceneSpec } from './scene';

interface Props { spec: SceneSpec; p: Placement; w: number; h: number }

export function FxLayer({ spec, p, w, h }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fx = spec.fx ?? [];

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g || !w || !h || !fx.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const engine = getEngine();
    const W = spec.width * p.scale, H = spec.height * p.scale;
    const px = (x: number) => p.left + x * W;
    const py = (y: number) => p.top + y * H;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // 雨丝
    type Drop = { x: number; y: number; len: number; v: number; a: number };
    const rains = fx.filter((f): f is Extract<Fx, { type: 'rainfall' }> => f.type === 'rainfall').map((f) => {
      const rects = f.rects.map((r) => ({ x: px(r.x), y: py(r.y), w: r.w * W, h: r.h * H }));
      const area = rects.reduce((s, r) => s + r.w * r.h, 0);
      const n = Math.round((area / 9000) * (f.density ?? 1));
      const drops: Drop[] = Array.from({ length: n }, () => newDrop(rects, true));
      return { rects, drops };
    });
    function newDrop(rects: Array<{ x: number; y: number; w: number; h: number }>, anywhere: boolean): Drop {
      const r = rects[Math.floor(Math.random() * rects.length)];
      return { x: r.x + Math.random() * r.w, y: anywhere ? r.y + Math.random() * r.h : r.y - 20, len: 8 + Math.random() * 16, v: 700 + Math.random() * 500, a: 0.12 + Math.random() * 0.22 };
    }
    // 海鸥
    type Bird = { x: number; y: number; v: number; s: number; ph: number; dir: 1 | -1 };
    const flocks = fx.filter((f): f is Extract<Fx, { type: 'birds' }> => f.type === 'birds').map((f) => ({ f, birds: [] as Bird[], next: 3 + Math.random() * 6 }));

    let raf = 0, last = performance.now(), t = 0, energy = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!reduce) t += dt;
      energy += (engine.energy() - energy) * Math.min(1, dt * 6);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      for (const f of fx) {
        if (f.type === 'glow') {
          const flicker = 0.92 + 0.08 * Math.sin(t * 1.7) + 0.04 * Math.sin(t * 7.3) * Math.sin(t * 0.37);
          const a = f.strength * flicker * (1 + energy * 0.35);
          const R = f.r * W;
          const grad = g.createRadialGradient(px(f.x), py(f.y), 0, px(f.x), py(f.y), R);
          grad.addColorStop(0, `rgba(${f.color},${(a * 0.55).toFixed(3)})`);
          grad.addColorStop(0.35, `rgba(${f.color},${(a * 0.22).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${f.color},0)`);
          g.fillStyle = grad;
          g.fillRect(px(f.x) - R, py(f.y) - R, R * 2, R * 2);
        } else if (f.type === 'lighthouse') {
          const th = (t / f.period) * Math.PI * 2;
          const side = Math.sin(th);                 // 光束朝左（-）还是朝右（+），长度跟着 |sin|
          const face = Math.max(0, Math.cos(th));    // 正对我们
          const x0 = px(f.x), y0 = py(f.y);
          const L = f.len * W * Math.abs(side);
          if (L > 2) {
            const spread = H * 0.018;
            const grad = g.createLinearGradient(x0, y0, x0 + side * f.len * W, y0);
            grad.addColorStop(0, 'rgba(255,236,190,0.55)');
            grad.addColorStop(0.5, 'rgba(255,236,190,0.16)');
            grad.addColorStop(1, 'rgba(255,236,190,0)');
            g.fillStyle = grad;
            g.beginPath();
            g.moveTo(x0, y0 - 2);
            g.lineTo(x0 + Math.sign(side) * L, y0 - spread);
            g.lineTo(x0 + Math.sign(side) * L, y0 + spread * 0.6);
            g.lineTo(x0, y0 + 2);
            g.closePath();
            g.fill();
          }
          const fr = H * (0.012 + face * 0.035);
          const flare = g.createRadialGradient(x0, y0, 0, x0, y0, fr);
          flare.addColorStop(0, `rgba(255,244,214,${(0.5 + face * 0.5).toFixed(3)})`);
          flare.addColorStop(1, 'rgba(255,244,214,0)');
          g.fillStyle = flare;
          g.fillRect(x0 - fr, y0 - fr, fr * 2, fr * 2);
        }
      }
      // 雨丝：斜一点往下落
      g.globalCompositeOperation = 'source-over';
      g.lineCap = 'round';
      for (const rain of rains) {
        g.save();
        g.beginPath();
        for (const r of rain.rects) g.rect(r.x, r.y, r.w, r.h);
        g.clip();
        g.lineWidth = 1;
        for (let i = 0; i < rain.drops.length; i++) {
          const d = rain.drops[i];
          d.y += d.v * dt;
          d.x -= d.v * dt * 0.08;
          if (rain.rects.every((r) => d.y > r.y + r.h)) rain.drops[i] = newDrop(rain.rects, false);
          g.strokeStyle = `rgba(200,220,255,${d.a.toFixed(3)})`;
          g.beginPath();
          g.moveTo(d.x, d.y);
          g.lineTo(d.x + d.len * 0.08, d.y - d.len);
          g.stroke();
        }
        g.restore();
      }
      // 海鸥：几只一起从一边慢慢飞到另一边，翅膀一扇一扇
      for (const flock of flocks) {
        const r = flock.f.rect;
        flock.next -= dt;
        if (flock.next <= 0 && !flock.birds.length) {
          const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
          const n = 1 + Math.floor(Math.random() * 3);
          const y = py(r.y + Math.random() * r.h);
          for (let i = 0; i < n; i++) {
            flock.birds.push({ x: dir > 0 ? px(r.x) - 20 - i * 26 : px(r.x + r.w) + 20 + i * 26, y: y + (Math.random() - 0.5) * 30, v: 26 + Math.random() * 14, s: H * (0.007 + Math.random() * 0.004), ph: Math.random() * 6, dir });
          }
          flock.next = flock.f.every * (0.7 + Math.random() * 0.6);
        }
        g.strokeStyle = 'rgba(70,90,120,0.75)';
        g.lineWidth = 1.4;
        for (let i = flock.birds.length - 1; i >= 0; i--) {
          const b = flock.birds[i];
          b.x += b.dir * b.v * dt;
          b.y += Math.sin(t * 0.6 + b.ph) * 4 * dt;
          const flap = Math.sin(t * 6 + b.ph);
          const s = b.s, lift = s * (0.35 + 0.45 * flap);
          g.beginPath();
          g.moveTo(b.x - s, b.y - lift);
          g.quadraticCurveTo(b.x - s * 0.45, b.y - lift * 0.2 - s * 0.25, b.x, b.y);
          g.quadraticCurveTo(b.x + s * 0.45, b.y - lift * 0.2 - s * 0.25, b.x + s, b.y - lift);
          g.stroke();
          if (b.x < px(r.x) - 80 || b.x > px(r.x + r.w) + 80) flock.birds.splice(i, 1);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [spec, p, w, h]);

  if (!fx.length) return null;
  return <canvas className="sl-fx" ref={ref} />;
}
