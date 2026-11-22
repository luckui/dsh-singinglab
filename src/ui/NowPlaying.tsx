/**
 * 正在播放：整页是场景（SceneView：大肥鱼坐在窗台听歌，歌词映在窗玻璃上），
 * 角落一张磨砂玻璃小卡片放控制：转着的小唱片、歌名、频谱、进度、按钮、音量。
 * 放歌时鼠标 4 秒不动，卡片和返回键淡出，整页就是一张会动的壁纸；一动鼠标又回来。
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { getEngine } from './engine';
import { Icon } from './icons';
import { SceneView } from './SceneView';
import type { SceneSpec } from './scene';

const IDLE_MS = 4000;

const fmt = (sec: number) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

interface Props { spec: SceneSpec | null; onBack: () => void }

export function NowPlaying({ spec, onBack }: Props) {
  const engine = getEngine();
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const song = state.current;
  const id = song?.id ?? state.queue[state.index] ?? null;
  const idle = useIdle(state.playing);

  return (
    <div className={`sl-now ${idle ? 'is-idle' : ''}`}>
      {spec ? <SceneView spec={spec} song={song} /> : <div className="sl-scene sl-scene-missing" />}
      <button className="sl-back" onClick={onBack} title="回到歌库"><Icon name="down" /></button>
      <section className={`sl-card sl-card-${spec?.card ?? 'left'}`}>
        <div className="sl-card-head">
          <MiniDisc id={id} />
          <div className="sl-card-meta">
            <div className="sl-title" title={song?.title}>{song?.title ?? (state.loading ? '……' : '还没放歌')}</div>
            <div className="sl-artist">
              {song?.artist || '未知歌手'}
              {song?.who ? <span className="sl-who"> · {song.who}</span> : null}
            </div>
            <Spectrum />
          </div>
        </div>
        <Progress />
        <Controls />
        {state.error ? <div className="sl-error">{state.error}</div> : null}
      </section>
    </div>
  );
}

/** 放歌时鼠标、键盘一段时间没动 → true */
function useIdle(playing: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!playing) { setIdle(false); return; }
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [playing]);
  return idle;
}

function MiniDisc({ id }: { id: string | null }) {
  const engine = getEngine();
  const playing = useSyncExternalStore(engine.subscribe, () => engine.state.playing);
  const [ok, setOk] = useState(true);
  useEffect(() => setOk(true), [id]);
  return (
    <div className={`sl-minidisc ${playing ? 'is-playing' : ''}`}>
      <div className="sl-minidisc-spin">
        <div className="sl-minidisc-label">
          {id && ok ? <img src={api.coverUrl(id)} alt="" onError={() => setOk(false)} /> : <Icon name="fish" size={18} />}
        </div>
      </div>
    </div>
  );
}

/** 歌名下面一排细细的频谱 */
function Spectrum() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const engine = getEngine();
    const n = 40;
    const bars = new Float32Array(n);
    const smooth = new Float32Array(n);
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      engine.spectrum(bars);
      const step = w / n;
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#5aa7ff');
      grad.addColorStop(1, '#8fd3ff');
      g.fillStyle = grad;
      for (let i = 0; i < n; i++) {
        smooth[i] += (bars[i] - smooth[i]) * 0.35;
        const v = Math.pow(smooth[i], 1.5);
        const bh = Math.max(2, v * h);
        const x = i * step + step * 0.2;
        g.globalAlpha = 0.45 + v * 0.55;
        g.beginPath();
        g.roundRect(x, h - bh, step * 0.6, bh, step * 0.3);
        g.fill();
      }
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas className="sl-spectrum" ref={ref} />;
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
      <button className={`sl-ctl sl-small ${s.shuffle ? 'is-on' : ''}`} onClick={() => engine.toggleShuffle()} title="随机播放"><Icon name="shuffle" size={19} /></button>
      <button className="sl-ctl" onClick={() => engine.step(-1)} title="上一首"><Icon name="prev" /></button>
      <button className="sl-ctl sl-play" onClick={() => engine.toggle()} title={s.playing ? '暂停' : '播放'}><Icon name={s.playing ? 'pause' : 'play'} /></button>
      <button className="sl-ctl" onClick={() => engine.step(1)} title="下一首"><Icon name="next" /></button>
      <button className={`sl-ctl sl-small ${s.repeat !== 'off' ? 'is-on' : ''}`} onClick={() => engine.cycleRepeat()} title={s.repeat === 'one' ? '单曲循环' : s.repeat === 'all' ? '列表循环' : '不循环'}>
        <Icon name={s.repeat === 'one' ? 'repeat1' : 'repeat'} size={19} />
      </button>
      <Volume />
    </div>
  );
}

function Volume() {
  const engine = getEngine();
  const volume = useSyncExternalStore(engine.subscribe, () => engine.state.volume);
  return (
    <label className="sl-volume" title="音量">
      <Icon name={volume === 0 ? 'mute' : 'volume'} size={18} />
      <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => engine.setVolume(Number(e.target.value))} style={{ ['--v' as string]: `${volume * 100}%` }} />
    </label>
  );
}
