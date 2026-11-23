/**
 * 修音页：一首歌她要唱的音高，叠在频谱图上。
 *   - 频谱图可以换「原人声（含和声）」「主唱干声」「和声」：和声把音测错的地方，频谱上能看到两条声部
 *   - 音符块对齐半音格，可以上下拖；白线是她要唱的音高线；橙色虚线是原来测到的音（和现在不一样的地方才画）
 *   - 工具：选择（拖音符、拖出一段）/ 画音高线（像 OpenUTAU：自动识别的线上局部手画）/ 对准（音的中心挪到最近的半音，颤音留着）
 *   - 选一段：升 / 降八度、升 / 降半音、恢复成测到的、恢复成自动修的
 *   - 整首移调：带子是她唱着不哑的音域（大肥鱼默认声音实测 A#3–E5），音符跑出带子的地方她会哑
 *   - 试听：乐器音（长笛，马上就有，不吃显卡）/ 她的声音（只渲染选中的这一句）/ 原唱 / 现在歌库里的版本
 *   - 保存：整首按改好的音高重新唱、重新混音，播放器里的版本跟着换
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type EditData, type EditOp } from './api';
import { getEngine } from './engine';
import { Icon } from './icons';

const FPS = 100;               // 音高 10 ms 一帧
const MIDI_LO = 36, MIDI_HI = 96; // 频谱图的纵轴范围（C2–C7），每半音 3 格
const KEYW = 46;               // 左边琴键宽
const RULER = 34;              // 上面时间尺 + 歌词
const HER_LOW = 58, HER_HIGH = 76; // 她唱着不哑的音域（A#3–E5，prepare.py 的 HOARSE 表）
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const noteName = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const keyText = (k: number) => (k === 0 ? '原调' : k > 0 ? `升 ${k}` : `降 ${-k}`);

function decode(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function encode(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 测到的 / 自动修过的 + 一条条改动 → 她要唱的音高 */
function compose(raw: Float32Array, plan: Float32Array | null, ops: EditOp[]): Float32Array {
  const f = Float32Array.from(plan ?? raw);
  for (const op of ops) {
    const a = Math.max(0, op.a), b = Math.min(f.length, op.b);
    if (op.kind === 'snap') {
      for (const n of notesOf(f.subarray(a, b))) {
        const k = 2 ** ((Math.round(n.midi) - n.midi) / 12);
        for (let i = a + n.a; i < a + n.b; i++) f[i] *= k;
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

interface Note { a: number; b: number; midi: number }

/** 连着唱、音高差不到 0.8 个半音的一串帧算一个音 */
function notesOf(f: Float32Array): Note[] {
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

type Mode = 'synth' | 'her' | 'orig' | 'mix';
type Tool = 'select' | 'draw' | 'snap';

/** 试听：都用 WebAudio 放，播放头的时间才准 */
class Preview {
  ctx = new AudioContext();
  private nodes: AudioScheduledSourceNode[] = [];
  private buffers = new Map<string, AudioBuffer>();
  startedAt = 0;
  offset = 0;
  end = 0;
  playing: Mode | null = null;

  async buffer(url: string): Promise<AudioBuffer> {
    const hit = this.buffers.get(url);
    if (hit) return hit;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`取音频失败（${res.status}）`);
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
    if (!url.includes('name=phrase')) this.buffers.set(url, buf);
    return buf;
  }

  stop(): void {
    for (const n of this.nodes) { try { n.stop(); } catch { /* 已经停了 */ } }
    this.nodes = [];
    this.playing = null;
  }

  get time(): number {
    return this.playing ? this.offset + (this.ctx.currentTime - this.startedAt) : this.offset;
  }

  playBuffer(buf: AudioBuffer, from: number, bufStart: number, mode: Mode, gain = 1): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.ctx.destination);
    const at = this.ctx.currentTime + 0.05;
    src.start(at, Math.max(0, from - bufStart));
    this.nodes.push(src);
    this.startedAt = at;
    this.offset = from;
    this.end = bufStart + buf.duration;
    this.playing = mode;
  }

  /** 长笛一样的音色按音高线吹出来；acc 是移好调的伴奏 */
  playSynth(f: Float32Array, key: number, from: number, to: number, acc: AudioBuffer | null): void {
    this.stop();
    const at = this.ctx.currentTime + 0.05;
    if (acc) this.playBuffer(acc, from, 0, 'synth', 0.55);
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(this.ctx.createPeriodicWave(new Float32Array([0, 1, 0.32, 0.1, 0.04]), new Float32Array(5)));
    const g = this.ctx.createGain();
    g.gain.value = 0;
    osc.connect(g).connect(this.ctx.destination);
    const ratio = 2 ** (key / 12);
    const a = Math.floor(from * FPS), b = Math.min(f.length, Math.ceil(to * FPS));
    let last = -1, on = false;
    for (let i = a; i < b; i++) {
      const t = at + (i - a) / FPS;
      const v = f[i] > 0;
      if (v) {
        const hz = f[i] * ratio;
        if (Math.abs(hz - last) > 0.3) { osc.frequency.setValueAtTime(hz, t); last = hz; }
      }
      if (v !== on) { g.gain.setTargetAtTime(v ? 0.22 : 0, t, 0.012); on = v; }
    }
    g.gain.setTargetAtTime(0, at + (b - a) / FPS, 0.02);
    osc.start(at);
    osc.stop(at + (b - a) / FPS + 0.2);
    this.nodes.push(osc);
    this.startedAt = at;
    this.offset = from;
    this.end = to;
    this.playing = 'synth';
  }
}

interface Props { id: string; onClose: () => void }

export function Editor({ id, onClose }: Props) {
  const [data, setData] = useState<EditData | null>(null);
  const [error, setError] = useState<{ text: string; relearn: boolean } | null>(null);
  const [ops, setOps] = useState<EditOp[]>([]);
  const [key, setKey] = useState(0);
  const [layer, setLayer] = useState<'vocals' | 'dry' | 'back'>('vocals');
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('synth');
  const [playing, setPlaying] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [glow, setGlow] = useState<'strong' | 'weak' | 'off'>('weak');
  const preview = useRef<Preview | null>(null);

  useEffect(() => {
    let alive = true;
    api.edit(id).then((d) => {
      if (!alive) return;
      setData(d); setOps(d.state.ops); setKey(d.state.key);
    }).catch((err: Error & { relearn?: boolean }) => alive && setError({ text: err.message, relearn: !!err.relearn }));
    preview.current = new Preview();
    return () => { alive = false; preview.current?.stop(); void preview.current?.ctx.close(); };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { preview.current?.stop(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const raw = useMemo(() => (data ? decode(data.raw) : null), [data]);
  const plan = useMemo(() => (data?.plan ? decode(data.plan) : null), [data]);
  const f0 = useMemo(() => (raw ? compose(raw, plan, ops) : null), [raw, plan, ops]);

  const apply = (op: EditOp) => { setOps((o) => [...o, op]); setDirty(true); };
  const undo = () => { setOps((o) => o.slice(0, -1)); setDirty(true); };

  const stop = () => { preview.current?.stop(); setPlaying(false); };

  const play = useCallback(async (m: Mode, from: number, to?: number) => {
    const p = preview.current;
    if (!p || !data || !f0) return;
    p.stop();
    void p.ctx.resume();
    setMode(m);
    const end = to ?? data.durationSec;
    try {
      if (m === 'synth') {
        setBusy('准备伴奏…');
        const acc = await p.buffer(api.editAudioUrl(id, 'accomp', key)).catch(() => null);
        setBusy(null);
        p.playSynth(f0, key, from, end, acc);
      } else if (m === 'her') {
        // 给了终点就渲染这一段（选中的一段、刚拖完的音）；没给就从这里往后 8 秒
        const a = to !== undefined ? from : Math.max(0, from - 0.5);
        const b = to !== undefined ? to : Math.min(data.durationSec, from + 8);
        setBusy('她在唱这一句…');
        const out = await api.editPhrase(id, a, b, encode(f0), key);
        const buf = await p.buffer(`${api.editAudioUrl(id, 'phrase', key)}&t=${Date.now()}`);
        setBusy(null);
        setNote(`这一句渲染用了 ${out.renderSec} 秒`);
        p.playBuffer(buf, out.start, out.start, 'her');
      } else if (m === 'orig') {
        setBusy('取原唱…');
        const buf = await p.buffer(api.editAudioUrl(id, 'vocals', 0));
        setBusy(null);
        p.playBuffer(buf, from, 0, 'orig');
      } else {
        setBusy('取歌库里的版本…');
        const buf = await p.buffer(`${api.audioUrl(id)}&v=${data.savedAt ?? 0}`);
        setBusy(null);
        p.playBuffer(buf, from, 0, 'mix');
      }
      setPlaying(true);
    } catch (err) {
      setBusy(null);
      setNote((err as Error).message);
    }
  }, [data, f0, id, key]);

  // 拖完、画完马上试听：等这次改动画进音高线之后再放（setTimeout 时已经是新的 play）
  const playRef = useRef(play);
  playRef.current = play;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const playSoon = (from: number, to?: number) => { setTimeout(() => void playRef.current(modeRef.current, from, to), 0); };

  const save = async () => {
    if (!f0 || !data) return;
    stop();
    setBusy('她正在按改好的音高重新唱整首，大约半分钟…');
    try {
      const out = await api.editSave(id, encode(f0), key, ops);
      setData({ ...data, savedAt: out.editedAt });
      setDirty(false);
      setNote(`保存好了（${out.sec} 秒），播放器里已经换成新的`);
      getEngine().reloadSong(id);
    } catch (err) {
      setNote(`没保存成：${(err as Error).message}`);
    }
    setBusy(null);
  };

  const relearn = async () => {
    try {
      const song = getEngine().state.songs.find((s) => s.id === id);
      if (!song?.bvid) throw new Error('这首不是从 B 站学的，重学不了');
      await api.learn({ bvid: song.bvid, page: Number(/-p(\d+)$/.exec(id)?.[1] ?? 1), title: song.title, artist: song.artist, autoplay: false, relearn: true });
      setError({ text: '在重学了（3–4 分钟），学完再打开就能修', relearn: false });
    } catch (err) {
      setError({ text: (err as Error).message, relearn: false });
    }
  };

  const title = data ? `${data.title}${data.artist ? ` · ${data.artist}` : ''}` : '';

  return (
    <div className="sl-editor" role="dialog" aria-label="修音">
      <header className="sl-ed-top">
        <button className="sl-ed-back" onClick={() => { stop(); onClose(); }} title="回去"><Icon name="down" size={18} /></button>
        <div className="sl-ed-title"><b>修音</b><span>{title}</span></div>
        {data ? (
          <div className="sl-ed-key" title="整首升降几个半音（她唱的调）">
            <button onClick={() => { setKey((k) => k - 1); setDirty(true); }}>−</button>
            <span>{keyText(key)}{key === data.state.autoKey ? <em>自动选的</em> : null}</span>
            <button onClick={() => { setKey((k) => k + 1); setDirty(true); }}>+</button>
          </div>
        ) : null}
        {data ? <button className="sl-ed-save" disabled={!!busy} onClick={() => void save()}>{dirty ? '保存这首' : '已保存'}</button> : null}
      </header>

      {error ? (
        <div className="sl-ed-empty">
          <p>{error.text}</p>
          {error.relearn ? <button className="sl-btn sl-btn-primary" onClick={() => void relearn()}>重学一遍</button> : null}
        </div>
      ) : !data || !f0 || !raw ? (
        <div className="sl-ed-empty"><p>正在读这首歌的音高…</p></div>
      ) : (
        <>
          <div className="sl-ed-bar">
            <div className="sl-ed-seg" title="工具">
              {(['select', 'draw', 'snap'] as Tool[]).map((t) => (
                <button key={t} className={tool === t ? 'is-on' : ''} onClick={() => setTool(t)}>{t === 'select' ? '选择' : t === 'draw' ? '画音高线' : '对准'}</button>
              ))}
            </div>
            <div className="sl-ed-seg" title="底下的频谱图：哪一轨、多亮">
              {data.layers.map((l) => (
                <button key={l} className={layer === l ? 'is-on' : ''} onClick={() => { setLayer(l); if (glow === 'off') setGlow('weak'); }}>{l === 'vocals' ? '原人声（含和声）' : l === 'dry' ? '主唱干声' : '和声'}</button>
              ))}
              <button className="sl-ed-glow" onClick={() => setGlow((g) => (g === 'strong' ? 'weak' : g === 'weak' ? 'off' : 'strong'))} title="频谱亮度">
                {glow === 'strong' ? '亮' : glow === 'weak' ? '暗' : '关'}
              </button>
            </div>
            <div className="sl-ed-seg" title="试听（空格：播放 / 停）">
              {(['synth', 'her', 'orig', 'mix'] as Mode[]).map((m) => (
                <button key={m} className={mode === m ? 'is-on' : ''} onClick={() => setMode(m)}>{m === 'synth' ? '乐器音' : m === 'her' ? '她的声音（这一句）' : m === 'orig' ? '原唱' : '歌库里的版本'}</button>
              ))}
            </div>
            <span className="sl-ed-hint">{busy ?? note ?? (tool === 'draw' ? '在音高线上按住画 · 只改有声音的地方' : tool === 'snap' ? '点一个音：对准最近的半音' : '拖音符改音高 · 拖空白处选一段 · 空格试听')}</span>
          </div>
          <Roll
            id={id} data={data} raw={raw} plan={plan} f0={f0} ops={ops} keyShift={key} layer={layer} sel={sel} onSel={setSel}
            tool={tool} glow={glow} onOp={apply}
            preview={preview} playing={playing} onPlaying={setPlaying}
            onPlay={(from, to) => void play(mode, from, to)} onPlaySoon={playSoon} onStop={stop} mode={mode}
          />
          <footer className="sl-ed-foot">
            <span className="sl-ed-sel">{sel ? `选中 ${clock(sel.a / FPS)} – ${clock(sel.b / FPS)}` : '没选中：改动对着整首'}</span>
            <div className="sl-ed-actions">
              {([['升八度', 12], ['降八度', -12], ['升半音', 1], ['降半音', -1]] as const).map(([label, n]) => (
                <button key={label} disabled={!sel} onClick={() => sel && apply({ ...sel, kind: 'shift', semitones: n })}>{label}</button>
              ))}
              <button disabled={!sel} onClick={() => sel && apply({ ...sel, kind: 'snap' })} title="这一段里每个音对准最近的半音（颤音、滑音留着）">对准半音</button>
              <button disabled={!sel} onClick={() => sel && apply({ ...sel, kind: 'source', source: 'raw' })} title="这一段用原来测到的音（不要自动修）">用测到的</button>
              {plan ? <button disabled={!sel} onClick={() => sel && apply({ ...sel, kind: 'source', source: 'plan' })} title="这一段恢复成自动修过的音">用自动修的</button> : null}
              <button disabled={!ops.length} onClick={undo}>撤销</button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

interface RollProps {
  id: string; data: EditData; raw: Float32Array; plan: Float32Array | null; f0: Float32Array; ops: EditOp[]; keyShift: number;
  layer: 'vocals' | 'dry' | 'back'; sel: { a: number; b: number } | null; onSel: (s: { a: number; b: number } | null) => void;
  tool: Tool; glow: 'strong' | 'weak' | 'off'; onOp: (op: EditOp) => void;
  onPlaySoon: (from: number, to?: number) => void;
  preview: React.MutableRefObject<Preview | null>; playing: boolean; onPlaying: (v: boolean) => void;
  onPlay: (from: number, to?: number) => void; onStop: () => void; mode: Mode;
}

function Roll(props: RollProps) {
  const { id, data, raw, f0, keyShift, layer, sel, onSel, tool, glow, onOp, onPlaySoon, preview, playing, onPlaying, onPlay, onStop } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 900, h: 480 });
  const view = useRef({ t0: 0, pps: 90, top: 80, spx: 11 }); // 左边是第几秒、每秒几像素、最上面是哪个音、每半音几像素
  const [, setTick] = useState(0);
  const redraw = () => setTick((t) => t + 1);
  const head = useRef(0);
  const drag = useRef<null
    | { kind: 'note'; note: Note; y0: number; d: number }
    | { kind: 'sel'; a: number; x0: number; moved: boolean }
    | { kind: 'draw'; hz: Map<number, number>; last: { i: number; m: number } }>(null);
  const spec = useRef<HTMLImageElement | null>(null);
  const notes = useMemo(() => notesOf(f0), [f0]);

  // 一打开先把视野放在她唱的音附近
  useEffect(() => {
    const ms = notes.map((n) => n.midi).sort((a, b) => a - b);
    if (ms.length) view.current.top = Math.min(MIDI_HI, Math.round(ms[Math.floor(ms.length * 0.95)] + 8));
    redraw();
  }, [notes.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const img = new Image();
    img.onload = () => { spec.current = img; redraw(); };
    img.src = api.editSpecUrl(id, layer);
    spec.current = null;
    redraw();
  }, [id, layer]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 播放头跟着走，走出画面就翻页
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      const p = preview.current;
      if (!p?.playing) { onPlaying(false); return; }
      head.current = p.time;
      if (p.time >= p.end) { p.stop(); onPlaying(false); return; }
      const v = view.current, span = (size.w - KEYW) / v.pps;
      if (head.current > v.t0 + span * 0.92) v.t0 = head.current - span * 0.1;
      redraw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, preview, onPlaying, size.w]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      e.preventDefault(); e.stopPropagation();
      if (playing) onStop();
      else onPlay(sel ? sel.a / FPS : head.current, sel ? sel.b / FPS : undefined);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [playing, sel, onPlay, onStop]);

  const v = view.current;
  const W = size.w, H = size.h;
  const x = (t: number) => KEYW + (t - v.t0) * v.pps;
  const tAt = (px: number) => v.t0 + (px - KEYW) / v.pps;
  const y = (m: number) => RULER + (v.top - m) * v.spx;
  const mAt = (py: number) => v.top - (py - RULER) / v.spx;

  // ── 画 ──
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0c1222'; g.fillRect(0, 0, W, H);
    const t1 = tAt(W);
    // 半音格：黑键那一行深一点
    for (let m = Math.floor(mAt(H)); m <= Math.ceil(v.top); m++) {
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      g.fillStyle = black ? '#0a0f1d' : '#0e1528';
      g.fillRect(KEYW, y(m + 0.5), W - KEYW, v.spx);
      if (m % 12 === 0) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(KEYW, y(m - 0.5), W - KEYW, 1); }
    }
    // 她唱着不哑的音域（按现在的调换算回原调的位置）
    g.fillStyle = 'rgba(120,190,255,.07)';
    g.fillRect(KEYW, y(HER_HIGH - keyShift + 0.5), W - KEYW, (HER_HIGH - HER_LOW + 1) * v.spx);
    g.strokeStyle = 'rgba(120,190,255,.28)'; g.setLineDash([4, 4]); g.lineWidth = 1;
    for (const m of [HER_HIGH + 0.5, HER_LOW - 0.5]) { g.beginPath(); g.moveTo(KEYW, y(m - keyShift)); g.lineTo(W, y(m - keyShift)); g.stroke(); }
    g.setLineDash([]);
    // 频谱
    const img = spec.current;
    if (img) {
      g.save(); g.globalAlpha = glow === 'strong' ? 0.9 : glow === 'weak' ? 0.4 : 0; g.imageSmoothingEnabled = true;
      const sx = v.t0 * FPS, sw = (t1 - v.t0) * FPS;
      const binTop = (MIDI_HI - v.top) * 3, binH = (v.top - mAt(H)) * 3;
      // 第 r 行像素的中心是 MIDI 95.67 - r/3（CQT 从 MIDI 36 起每半音 3 格，图上下翻过）
      g.drawImage(img, sx, binTop - 0.5, sw, binH, KEYW, RULER, W - KEYW, H - RULER);
      g.restore();
    }
    // 选中的一段
    if (sel) {
      g.fillStyle = 'rgba(255,255,255,.07)';
      g.fillRect(x(sel.a / FPS), RULER, (sel.b - sel.a) / FPS * v.pps, H - RULER);
    }
    const a0 = Math.max(0, Math.floor(v.t0 * FPS) - 1), a1 = Math.min(f0.length, Math.ceil(t1 * FPS) + 1);
    // 原来测到的（和现在不一样的地方）：橙色虚线
    g.strokeStyle = 'rgba(255,170,90,.85)'; g.lineWidth = 1.5; g.setLineDash([3, 3]);
    g.beginPath();
    let pen = false;
    for (let i = a0; i < a1; i++) {
      const diff = raw[i] > 0 && f0[i] > 0 && Math.abs(midiOf(raw[i]) - midiOf(f0[i])) > 1;
      if (!diff) { pen = false; continue; }
      const px = x(i / FPS), py = y(midiOf(raw[i]));
      if (pen) g.lineTo(px, py); else g.moveTo(px, py);
      pen = true;
    }
    g.stroke(); g.setLineDash([]);
    // 音符块：对齐到最近的半音格，像钢琴卷帘；块上写音名（她实际唱的音，带上移调）
    const dragging = drag.current?.kind === 'note' ? drag.current : null;
    g.font = '600 10px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const n of notes) {
      if (n.b / FPS < v.t0 || n.a / FPS > t1) continue;
      const d = dragging && dragging.note.a === n.a ? dragging.d : 0;
      const row = Math.round(n.midi) + d;
      const out = row + keyShift > HER_HIGH || row + keyShift < HER_LOW;
      const nx = x(n.a / FPS), nw = Math.max(3, (n.b - n.a) / FPS * v.pps - 1), ny = y(row) - v.spx * 0.46, nh = v.spx * 0.92;
      g.fillStyle = out ? 'rgba(236,92,118,.78)' : (d ? 'rgba(120,200,255,.9)' : 'rgba(62,126,224,.82)');
      g.beginPath(); g.roundRect(nx, ny, nw, nh, 3); g.fill();
      g.strokeStyle = out ? 'rgba(255,170,185,.9)' : 'rgba(160,205,255,.85)'; g.lineWidth = 1; g.stroke();
      if (nw > 30 && v.spx >= 9) { g.fillStyle = 'rgba(255,255,255,.92)'; g.fillText(noteName(row + keyShift), nx + 4, y(row) + 0.5); }
    }
    // 她要唱的音高线
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.6;
    g.beginPath();
    pen = false;
    for (let i = a0; i < a1; i++) {
      if (!(f0[i] > 0)) { pen = false; continue; }
      const d = dragging && i >= dragging.note.a && i < dragging.note.b ? dragging.d : 0;
      const px = x(i / FPS), py = y(midiOf(f0[i]) + d);
      if (pen) g.lineTo(px, py); else g.moveTo(px, py);
      pen = true;
    }
    g.stroke();
    // 正在画的那一段：黄色
    if (drag.current?.kind === 'draw' && drag.current.hz.size) {
      g.strokeStyle = '#ffd866'; g.lineWidth = 2; g.beginPath();
      let prev = -2;
      for (const [i, hz] of [...drag.current.hz.entries()].sort((p, q) => p[0] - q[0])) {
        const px = x(i / FPS), py = y(midiOf(hz));
        if (i === prev + 1) g.lineTo(px, py); else g.moveTo(px, py);
        prev = i;
      }
      g.stroke();
    }
    // 琴键
    g.fillStyle = '#0a0e1a'; g.fillRect(0, RULER, KEYW, H - RULER);
    g.font = '10px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (let m = Math.floor(mAt(H)); m <= Math.ceil(v.top); m++) {
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      g.fillStyle = black ? '#1b2236' : '#d9e2f2';
      g.fillRect(black ? 0 : 0, y(m + 0.5) + 0.5, black ? KEYW * 0.62 : KEYW - 1, v.spx - 1);
      if (m % 12 === 0) { g.fillStyle = '#1b2236'; g.fillText(noteName(m), 4, y(m)); }
    }
    // 时间尺和歌词
    g.fillStyle = '#0a0e1a'; g.fillRect(0, 0, W, RULER);
    g.fillStyle = 'rgba(220,230,250,.55)'; g.font = '10px system-ui, sans-serif'; g.textBaseline = 'top';
    const step = v.pps > 60 ? 1 : v.pps > 20 ? 5 : 15;
    for (let s = Math.ceil(v.t0 / step) * step; s < t1; s += step) {
      g.fillRect(x(s), 0, 1, s % (step * 5) === 0 ? 8 : 4);
      if (s % (step * (v.pps > 60 ? 5 : 2)) === 0) g.fillText(clock(s).replace(/\.0$/, ''), x(s) + 3, 1);
    }
    g.font = '12px system-ui, sans-serif'; g.fillStyle = 'rgba(235,242,255,.85)';
    for (const l of data.lyrics) {
      if (l.end < v.t0 || l.start > t1) continue;
      g.fillText(l.text, Math.max(KEYW + 2, x(l.start)), 15);
    }
    // 播放头
    if (head.current >= v.t0 && head.current <= t1) {
      g.fillStyle = '#7fd0ff'; g.fillRect(x(head.current), 0, 1.5, H);
    }
  });

  const hitNote = (px: number, py: number): Note | null => {
    const t = tAt(px) * FPS, m = mAt(py);
    // 点在音符块上（对齐到半音格的那一行）或者点在块里的音高线附近都算
    return notes.find((n) => t >= n.a && t <= n.b && (Math.abs(Math.round(n.midi) - m) < 0.55 || Math.abs(n.midi - m) < 0.6)) ?? null;
  };

  const onDown = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (px < KEYW) return;
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 拿不到也能拖，只是拖出画布就停 */ }
    if (py < RULER) { head.current = Math.max(0, tAt(px)); onSel(null); redraw(); return; }
    const n = hitNote(px, py);
    if (tool === 'snap') {
      if (n) { onOp({ a: n.a, b: n.b, kind: 'snap' }); onSel({ a: n.a, b: n.b }); onPlaySoon(Math.max(0, n.a / FPS - 0.4), n.b / FPS + 0.4); }
      return;
    }
    if (tool === 'draw') {
      const i = Math.round(tAt(px) * FPS), m = mAt(py);
      drag.current = { kind: 'draw', hz: new Map(), last: { i, m } };
      paint(i, m, i, m);
      redraw();
      return;
    }
    drag.current = n ? { kind: 'note', note: n, y0: py, d: 0 } : { kind: 'sel', a: Math.max(0, Math.round(tAt(px) * FPS)), x0: px, moved: false };
  };

  /** 画音高线：从上一点到这一点之间的每一帧按直线插值；只画原来有声音的帧（气声、辅音不硬塞音高） */
  const paint = (i0: number, m0: number, i1: number, m1: number) => {
    const d = drag.current;
    if (d?.kind !== 'draw') return;
    const [a, b] = i0 <= i1 ? [i0, i1] : [i1, i0];
    for (let i = Math.max(0, a); i <= Math.min(f0.length - 1, b); i++) {
      if (!(f0[i] > 0)) continue;
      const m = a === b ? m1 : m0 + (m1 - m0) * ((i - i0) / (i1 - i0));
      d.hz.set(i, 440 * 2 ** ((m - 69) / 12));
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      const r = canvas.current!.getBoundingClientRect();
      const over = hitNote(e.clientX - r.left, e.clientY - r.top);
      canvas.current!.style.cursor = tool === 'draw' ? 'crosshair' : tool === 'snap' ? (over ? 'pointer' : 'default') : over ? 'ns-resize' : 'crosshair';
      return;
    }
    const r = canvas.current!.getBoundingClientRect();
    if (d.kind === 'draw') {
      const i = Math.round(tAt(e.clientX - r.left) * FPS), m = mAt(e.clientY - r.top);
      paint(d.last.i, d.last.m, i, m);
      d.last = { i, m };
    } else if (d.kind === 'note') {
      d.d = Math.round((d.y0 - (e.clientY - r.top)) / v.spx);
    } else {
      const px = e.clientX - r.left;
      if (Math.abs(px - d.x0) > 3) d.moved = true;
      const b = Math.max(0, Math.round(tAt(px) * FPS));
      if (d.moved) onSel({ a: Math.min(d.a, b), b: Math.max(d.a, b) });
    }
    redraw();
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'draw') {
      if (d.hz.size) {
        const idx = [...d.hz.keys()];
        const a = Math.min(...idx), b = Math.max(...idx) + 1;
        // 轻轻抹平手抖（3 帧滑动平均），取整到 0.1 Hz 存起来
        const hz = Array.from({ length: b - a }, (_, k) => {
          let sum = 0, n = 0;
          for (let j = -1; j <= 1; j++) { const v0 = d.hz.get(a + k + j); if (v0) { sum += v0; n++; } }
          return d.hz.has(a + k) && n ? Math.round((sum / n) * 10) / 10 : 0;
        });
        onOp({ a, b, kind: 'draw', hz });
        onSel({ a, b });
        onPlaySoon(Math.max(0, a / FPS - 0.4), b / FPS + 0.4); // 画完马上听
      }
    } else if (d.kind === 'note') {
      if (d.d) {
        onOp({ a: d.note.a, b: d.note.b, kind: 'shift', semitones: d.d });
        onSel({ a: d.note.a, b: d.note.b });
        onPlaySoon(Math.max(0, d.note.a / FPS - 0.4), d.note.b / FPS + 0.4); // 拖完马上听一下这个音
      } else {
        onSel({ a: d.note.a, b: d.note.b });
      }
    } else if (!d.moved) {
      onSel(null);
      head.current = d.a / FPS;
    }
    redraw();
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const t = tAt(e.clientX - r.left);
      v.pps = Math.min(600, Math.max(8, v.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      v.t0 = Math.max(0, t - (e.clientX - r.left - KEYW) / v.pps);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      v.t0 = Math.max(0, Math.min(data.durationSec - 2, v.t0 + (e.deltaX || e.deltaY) / v.pps));
    } else {
      v.top = Math.min(MIDI_HI, Math.max(MIDI_LO + (H - RULER) / v.spx, v.top - e.deltaY / v.spx / 2));
    }
    redraw();
  };

  return (
    <div className="sl-ed-roll" ref={wrap} onWheel={onWheel}>
      <canvas ref={canvas} style={{ width: W, height: H }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
      <div className="sl-ed-legend">
        <span><i className="w" />她要唱的音</span>
        <span><i className="o" />原来测到的（被和声带偏的地方）</span>
        <span><i className="b" />她唱着不哑的音域</span>
        <span><i className="r" />出了音域的音</span>
      </div>
      <div className="sl-ed-transport">
        <button onClick={() => (playing ? onStop() : onPlay(sel ? sel.a / FPS : head.current, sel ? sel.b / FPS : undefined))}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <span>{clock(head.current)}</span>
      </div>
    </div>
  );
}
