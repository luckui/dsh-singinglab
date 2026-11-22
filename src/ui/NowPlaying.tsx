/**
 * 正在播放：左边封面卡片，后面探出一张黑胶，放歌时转；黑胶外圈一圈频谱随声音起伏，小节首拍冒几个泡泡。
 * 下面是歌名、进度、控制。右边是歌词（Lyrics）。
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { upper } from './Backdrop';
import { getEngine } from './engine';
import { Icon } from './icons';
import { Lyrics } from './Lyrics';
import { css, type Palette } from './palette';

const fmt = (sec: number) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

interface Props { palette: Palette; onBack: () => void }

export function NowPlaying({ palette, onBack }: Props) {
  const engine = getEngine();
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const song = state.current;
  const id = song?.id ?? state.queue[state.index];

  return (
    <div className="sl-now" style={{ ['--accent' as string]: css(palette.accent) }}>
      <button className="sl-back" onClick={onBack} title="回到歌库"><Icon name="down" /></button>
      <section className="sl-stage">
        <Disc id={id ?? null} palette={palette} />
        <div className="sl-meta">
          <div className="sl-title" title={song?.title}>{song?.title ?? (state.loading ? '……' : '还没放歌')}</div>
          <div className="sl-artist">
            {song?.artist || '未知歌手'}
            {song?.who ? <span className="sl-who"> · B 站 {song.who}</span> : null}
          </div>
        </div>
        <Progress />
        <Controls />
        <Volume />
        {state.error ? <div className="sl-error">{state.error}</div> : null}
      </section>
      <section className="sl-words">
        <Lyrics song={song} />
      </section>
    </div>
  );
}

function Disc({ id, palette }: { id: string | null; palette: Palette }) {
  const engine = getEngine();
  const playing = useSyncExternalStore(engine.subscribe, () => engine.state.playing);
  const ring = useRef<HTMLCanvasElement>(null);
  const [coverOk, setCoverOk] = useState(true);
  useEffect(() => setCoverOk(true), [id]);
  const accent = useRef(palette.accent);
  accent.current = palette.accent;

  useEffect(() => {
    const canvas = ring.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const bars = new Float32Array(72);
    const smooth = new Float32Array(72);
    const bubbles: { x: number; y: number; r: number; vy: number; life: number }[] = [];
    let lastBeat = -1;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const size = canvas.clientWidth;
      if (canvas.width !== Math.round(size * dpr)) {
        canvas.width = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size, size);
      engine.spectrum(bars);
      const cx = size / 2, cy = size / 2;
      const inner = size * 0.36;
      const color = css(accent.current, 0.85);
      g.lineCap = 'round';
      g.strokeStyle = color;
      g.lineWidth = Math.max(2, size * 0.008);
      // 频谱环：左右对称，一圈 144 根
      for (let i = 0; i < bars.length; i++) {
        smooth[i] += (bars[i] - smooth[i]) * Math.min(1, dt * 14);
        const v = Math.pow(smooth[i], 1.6);
        const len = size * (0.006 + v * 0.085);
        for (const side of [1, -1]) {
          const a = -Math.PI / 2 + side * (i + 0.5) / bars.length * Math.PI;
          const x0 = cx + Math.cos(a) * inner, y0 = cy + Math.sin(a) * inner;
          const x1 = cx + Math.cos(a) * (inner + len), y1 = cy + Math.sin(a) * (inner + len);
          g.globalAlpha = 0.35 + v * 0.65;
          g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        }
      }
      g.globalAlpha = 1;
      // 泡泡：小节首拍从唱片边上冒出来，慢慢往上飘
      const song = engine.state.current;
      if (song && engine.state.playing) {
        const t = engine.time;
        const i = upper(song.downbeats, t) - 1;
        if (i !== lastBeat && i >= 0 && t - song.downbeats[i] < 0.2) {
          for (let k = 0; k < 3; k++) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
            bubbles.push({ x: cx + Math.cos(a) * inner * 1.12, y: cy + Math.sin(a) * inner * 1.12, r: size * (0.006 + Math.random() * 0.012), vy: size * (0.05 + Math.random() * 0.06), life: 1 });
          }
        }
        lastBeat = i;
      }
      for (let k = bubbles.length - 1; k >= 0; k--) {
        const b = bubbles[k];
        b.y -= b.vy * dt;
        b.x += Math.sin(now / 400 + k) * 0.25;
        b.life -= dt * 0.45;
        if (b.life <= 0) { bubbles.splice(k, 1); continue; }
        g.globalAlpha = b.life * 0.7;
        g.lineWidth = 1.2;
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.beginPath(); g.arc(b.x, b.y, b.r, 0, Math.PI * 2); g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fill();
      }
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={`sl-disc ${playing ? 'is-playing' : ''}`}>
      <canvas className="sl-ring" ref={ring} />
      <div className="sl-vinyl">
        <div className="sl-vinyl-spin">
          <div className="sl-vinyl-grooves" />
          <div className="sl-vinyl-label">
            {id && coverOk
              ? <img src={api.coverUrl(id)} alt="" onError={() => setCoverOk(false)} />
              : <span className="sl-vinyl-fish"><Icon name="fish" size={40} /></span>}
          </div>
          <div className="sl-vinyl-hole" />
        </div>
        <div className="sl-vinyl-sheen" />
      </div>
      <svg className="sl-arm" viewBox="0 0 100 220" aria-hidden>
        <circle cx="50" cy="22" r="18" className="sl-arm-base" />
        <circle cx="50" cy="22" r="7" className="sl-arm-pivot" />
        <path d="M50 22 L50 150 Q50 172 34 186" className="sl-arm-rod" />
        <rect x="20" y="180" width="26" height="34" rx="5" transform="rotate(32 33 197)" className="sl-arm-head" />
      </svg>
    </div>
  );
}

function Progress() {
  const engine = getEngine();
  const duration = useSyncExternalStore(engine.subscribe, () => engine.state.duration);
  const fill = useRef<HTMLDivElement>(null);
  const now = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<number | null>(null);
  // 拖动位置先同步记在 ref 里：快速点一下时按下和松开之间可能还没重新渲染
  const dragRef = useRef<number | null>(null);
  const setDrag = (v: number | null) => {
    dragRef.current = v;
    setDragState(v);
  };

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const d = engine.state.duration || 0;
      const t = dragRef.current ?? engine.time;
      const p = d ? Math.min(1, t / d) : 0;
      if (fill.current) fill.current.style.transform = `scaleX(${p})`;
      if (now.current) now.current.textContent = fmt(t);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (engine.state.duration || 0);
  };
  const onDown = (e: React.PointerEvent) => {
    setDrag(at(e.clientX));
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 拿不到捕获也照样能点 */ }
  };
  const onMove = (e: React.PointerEvent) => { if (dragRef.current !== null) setDrag(at(e.clientX)); };
  const onUp = (e: React.PointerEvent) => {
    if (dragRef.current === null) return;
    engine.seek(at(e.clientX));
    setDrag(null);
  };

  return (
    <div className="sl-progress">
      <div className={`sl-bar ${drag !== null ? 'is-drag' : ''}`} ref={bar} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        <div className="sl-bar-track"><div className="sl-bar-fill" ref={fill} /></div>
      </div>
      <div className="sl-times"><span ref={now}>0:00</span><span>{fmt(duration)}</span></div>
    </div>
  );
}

function Controls() {
  const engine = getEngine();
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  return (
    <div className="sl-controls">
      <button className={`sl-ctl sl-small ${s.shuffle ? 'is-on' : ''}`} onClick={() => engine.toggleShuffle()} title="随机播放"><Icon name="shuffle" /></button>
      <button className="sl-ctl" onClick={() => engine.step(-1)} title="上一首"><Icon name="prev" /></button>
      <button className="sl-ctl sl-play" onClick={() => engine.toggle()} title={s.playing ? '暂停' : '播放'}><Icon name={s.playing ? 'pause' : 'play'} /></button>
      <button className="sl-ctl" onClick={() => engine.step(1)} title="下一首"><Icon name="next" /></button>
      <button className={`sl-ctl sl-small ${s.repeat !== 'off' ? 'is-on' : ''}`} onClick={() => engine.cycleRepeat()} title={s.repeat === 'one' ? '单曲循环' : s.repeat === 'all' ? '列表循环' : '不循环'}>
        <Icon name={s.repeat === 'one' ? 'repeat1' : 'repeat'} />
      </button>
    </div>
  );
}

function Volume() {
  const engine = getEngine();
  const volume = useSyncExternalStore(engine.subscribe, () => engine.state.volume);
  return (
    <label className="sl-volume" title="音量">
      <Icon name={volume === 0 ? 'mute' : 'volume'} />
      <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => engine.setVolume(Number(e.target.value))} style={{ ['--v' as string]: `${volume * 100}%` }} />
    </label>
  );
}
