/**
 * 播放页的场景：插画铺满，整幅画极慢地呼吸、跟着鼠标轻轻错动（视差）。叠在画上的层：
 *   光束   窗外照进来的斜光，打拍子时亮一点
 *   微尘   光束里飘的小亮点
 *   海面   海上一闪一闪的反光，副歌、声音大时多一些
 *   唱片   窗台唱片机上那张唱片在转（scene.json 里写了位置才有）
 *   歌词   映在窗玻璃上
 * 这些层和插画在同一个会动的容器里，所以呼吸、视差时一起动，对得上画。
 */

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, type SongDetail } from './api';
import { getEngine } from './engine';
import { FxLayer } from './FxLayer';
import { LivingScene } from './LivingScene';
import { Lyrics } from './Lyrics';
import { place, toPx, upper, type Placement, type SceneSpec } from './scene';

interface Props { spec: SceneSpec; song: SongDetail | null }

export function SceneView({ spec, song }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [p, setP] = useState<Placement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight;
      setSize({ w, h });
      // 多放大 8%，给呼吸、漂移和视差留边，不露底
      const pl = place(spec, w * 1.08, h * 1.08);
      setP({ scale: pl.scale, left: pl.left - w * 0.04, top: pl.top - h * 0.04 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [spec]);

  // 呼吸 + 视差：直接改 transform，不走 React
  useEffect(() => {
    const el = box.current, w = world.current;
    if (!el || !w) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let mx = 0, my = 0, cx = 0, cy = 0, raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      mx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      my = ((e.clientY - r.top) / r.height - 0.5) * 2;
    };
    el.addEventListener('pointermove', onMove);
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (reduce) return;
      cx += (mx - cx) * 0.04;
      cy += (my - cy) * 0.04;
      // 呼吸：约 9 秒一吸一呼，放大 0～3%；再加一点慢慢的漂移，鼠标不动时画面也是活的
      const breath = 0.5 - 0.5 * Math.cos((now / 9000) * Math.PI * 2);
      const s = 1.004 + 0.026 * breath;
      const dx = 14 * Math.sin(now / 13000) - cx * 9;
      const dy = 8 * Math.sin(now / 17000 + 1.3) - cy * 6;
      w.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', onMove);
    };
  }, []);

  const img = p ? { left: p.left, top: p.top, width: spec.width * p.scale, height: spec.height * p.scale } : null;
  const glass = p ? toPx(spec.glass, spec, p) : null;
  const beam = p && spec.beam ? { ...toPx(spec.beam, spec, p), angle: spec.beam.angle } : null;

  return (
    <div className="sl-scene" ref={box}>
      <div className="sl-scene-world" ref={world}>
        {img && spec.mask
          ? <LivingScene image={api.assetUrl(spec.image)} mask={api.assetUrl(spec.mask)} blur={spec.fog ? api.assetUrl(spec.fog) : undefined} rain={!!spec.rain} horizon={spec.horizon ?? 0.5} style={img} />
          : img ? <img className="sl-scene-img" src={api.assetUrl(spec.image)} alt="" style={img} draggable={false} /> : null}
        {beam ? (
          <div className="sl-beam" style={{ left: beam.left, top: beam.top, width: beam.width, height: beam.height }}>
            <div className="sl-beam-rays" style={{ transform: `rotate(${beam.angle}deg)` }} />
          </div>
        ) : null}
        {p ? <Sparkles spec={spec} p={p} w={size.w} h={size.h} /> : null}
        {p ? <FxLayer spec={spec} p={p} w={size.w} h={size.h} /> : null}
        {p && spec.turntable ? <Turntable spec={spec} p={p} /> : null}
        {glass ? (
          <div className="sl-glass" style={glass}>
            <div className="sl-glass-sheen" />
            <Lyrics song={song} variant="glass" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 微尘（光束里）和海面闪光，一张画布 */
function Sparkles({ spec, p, w, h }: { spec: SceneSpec; p: Placement; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g || !w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const engine = getEngine();
    const beam = spec.beam ? toPx(spec.beam, spec, p) : null;
    const sea = spec.sea ? toPx(spec.sea, spec, p) : null;
    const motes = beam ? Array.from({ length: 46 }, () => ({
      x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.8,
      vx: (Math.random() - 0.5) * 0.004, vy: -0.002 - Math.random() * 0.006, ph: Math.random() * 6.28,
    })) : [];
    const glints: { x: number; y: number; life: number; size: number }[] = [];
    let lastBeat = -1, pulse = 0, raf = 0, last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const song = engine.state.current;
      const t = engine.time;
      const playing = engine.state.playing;
      if (song && playing) {
        const i = upper(song.downbeats, t) - 1;
        if (i !== lastBeat && i >= 0 && t - song.downbeats[i] < 0.2) pulse = 1;
        lastBeat = i;
      }
      pulse *= Math.exp(-dt * 2.5);
      const energy = engine.energy();
      const chorus = song?.sections.some((s) => s.kind === 'chorus' && t >= s.startSec && t < s.endSec) ?? false;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // 微尘
      if (beam) {
        for (const m of motes) {
          m.x += m.vx * dt * 6; m.y += m.vy * dt * 6;
          if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
          if (m.x < -0.02) m.x = 1.02; else if (m.x > 1.02) m.x = -0.02;
          const tw = 0.45 + 0.55 * Math.sin(now / 900 + m.ph);
          g.globalAlpha = Math.max(0, tw) * (0.55 + pulse * 0.35);
          g.fillStyle = '#fffaf0';
          g.beginPath();
          g.arc(beam.left + m.x * beam.width, beam.top + m.y * beam.height, m.r, 0, 6.283);
          g.fill();
        }
      }
      // 海面闪光
      if (sea) {
        const rate = (playing ? 5 : 2) + energy * 14 + (chorus ? 6 : 0) + pulse * 10;
        if (Math.random() < rate * dt) {
          // 越靠近海平线越小
          const yy = Math.random();
          glints.push({ x: Math.random(), y: yy, life: 1, size: 1.2 + yy * 3.2 });
        }
        for (let k = glints.length - 1; k >= 0; k--) {
          const s = glints[k];
          s.life -= dt * 1.6;
          if (s.life <= 0) { glints.splice(k, 1); continue; }
          const a = Math.sin(s.life * Math.PI);
          const x = sea.left + s.x * sea.width, y = sea.top + s.y * sea.height;
          g.globalAlpha = a * 0.9;
          g.strokeStyle = '#ffffff';
          g.lineWidth = 1;
          const L = s.size * (1.5 + a);
          g.beginPath(); g.moveTo(x - L, y); g.lineTo(x + L, y); g.moveTo(x, y - L * 0.6); g.lineTo(x, y + L * 0.6); g.stroke();
          g.fillStyle = '#ffffff';
          g.beginPath(); g.arc(x, y, s.size * 0.45, 0, 6.283); g.fill();
        }
      }
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [spec, p, w, h]);
  return <canvas className="sl-sparkles" ref={ref} />;
}

/** 窗台唱片机上那张唱片：画里的唱片和唱臂不动，放歌时在上面叠一层转着的反光；俯视有透视，所以是压扁的圆 */
function Turntable({ spec, p }: { spec: SceneSpec; p: Placement }) {
  const engine = getEngine();
  const playing = useSyncExternalStore(engine.subscribe, () => engine.state.playing);
  const t = spec.turntable!;
  const r = t.r * spec.width * p.scale;
  const cx = p.left + t.cx * spec.width * p.scale;
  const cy = p.top + t.cy * spec.height * p.scale;
  return (
    <div className="sl-tt" style={{ left: cx - r, top: cy - r, width: r * 2, height: r * 2, transform: `scaleY(${t.squash})` }}>
      <div className={`sl-tt-disc ${playing ? 'is-playing' : ''}`} />
    </div>
  );
}
