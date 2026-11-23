/**
 * 修音页：一首歌她要唱的音高，叠在频谱图上。操作照着 Melodyne / OpenUTAU / 常见 DAW 的钢琴卷帘的习惯：
 *
 *   看    滚轮 竖着滚 · Shift+滚轮 横着滚 · Ctrl+滚轮（触控板捏合）横向缩放 · Alt+滚轮 纵向缩放
 *         触控板两指随便推 · 中键拖 平移 · 底下的整首缩略图点 / 拖 跳过去 · F 缩放到选中（没选中就整首）
 *   选    点音符 选中 · Shift+点 加选 · 空白处拖 框一段 · Ctrl+A 全选 · Esc 取消
 *   改    拖音符 按半音（拖的时候就响这个音）· Alt+拖 不吸附 · ↑↓ 半音 · Shift+↑↓ 八度 · 双击音符 对准半音
 *         画笔（B）：按住画音高线 · Shift 画直线 · 右键拖 擦掉（恢复成自动修的）
 *         对准 / 拉直：选一段，中心往半音挪多少、音里的起伏压平多少，先听再「应用」
 *         剪刀（K）：点音符剪成两个 · 双击剪口合回去 · 选几个音符按 J「合并」成一个（拖、对准都当一个音）
 *         Delete 选中的恢复成自动修的 · Ctrl+Z 撤销 · Ctrl+Shift+Z / Ctrl+Y 重做
 *   听    空格 播放 / 停（停了播放头回到开始的地方）· L 循环（边循环边改，下一圈就是改过的）· 点时间尺 放播放头
 *         乐器音（长笛，马上就有）/ 她的声音（只渲染这一段，不到一秒）/ 原唱 / 歌库里的版本
 *
 * 白线是她要唱的音高线，音符块对齐半音格；橙色虚线是原来测到的音（和现在不一样的地方才画）；
 * 带子是她唱着不哑的音域（大肥鱼默认声音实测 A#3–E5，跟着移调走），出了带子的音符是红的。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type EditData, type EditOp } from './api';
import { getEngine } from './engine';
import { Icon } from './icons';
import { FPS, HER_HIGH, HER_LOW, compose, hzOf, marksOf, midiOf, noteName, notesOf, type Note, type Range } from '../pitch';

const MIDI_LO = 36, MIDI_HI = 96; // 频谱图的纵轴范围（C2–C7），每半音 3 格
const KEYW = 46;               // 左边琴键宽
const RULER = 34;              // 上面时间尺 + 歌词

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const keyText = (k: number) => (k === 0 ? '原调' : k > 0 ? `升 ${k}` : `降 ${-k}`);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

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

type Mode = 'synth' | 'her' | 'orig' | 'mix';
type Tool = 'select' | 'draw' | 'cut';

const PARTIALS = [0, 1, 0.32, 0.1, 0.04]; // 长笛一样：基音为主，一点点二三次谐波

/** 试听：都用 WebAudio 放，播放头的时间才准 */
class Preview {
  ctx = new AudioContext();
  private nodes: AudioScheduledSourceNode[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private held: { osc: OscillatorNode; g: GainNode } | null = null;
  startedAt = 0;
  offset = 0;
  end = 0;
  playing: Mode | null = null;
  /** 一段放完了（音频节点自己报的，切到后台也照样报）：Editor 决定循环还是停 */
  onEnd: (() => void) | null = null;
  private run = 0;

  /** 这一段的「主」节点放完时报一次；中途被 stop() 打断的不报 */
  private watch(node: AudioScheduledSourceNode): void {
    const run = ++this.run;
    node.onended = () => {
      if (run !== this.run || !this.playing) return;
      this.stop();
      this.onEnd?.();
    };
  }

  private wave(): PeriodicWave {
    return this.ctx.createPeriodicWave(new Float32Array(PARTIALS), new Float32Array(PARTIALS.length));
  }

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
    this.run++;
    for (const n of this.nodes) { try { n.stop(); } catch { /* 已经停了 */ } }
    this.nodes = [];
    this.playing = null;
  }

  get time(): number {
    return this.playing ? this.offset + (this.ctx.currentTime - this.startedAt) : this.offset;
  }

  playBuffer(buf: AudioBuffer, from: number, bufStart: number, mode: Mode, gain = 1, to?: number): void {
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
    this.end = Math.min(to ?? Infinity, bufStart + buf.duration);
    if (to !== undefined && to < bufStart + buf.duration) src.stop(at + (to - from));
    this.playing = mode;
    if (mode !== 'synth') this.watch(src); // 乐器音的伴奏只是垫底，结束看长笛那一路
  }

  /** 长笛一样的音色按音高线吹出来；acc 是移好调的伴奏 */
  playSynth(f: Float32Array, key: number, from: number, to: number, acc: AudioBuffer | null): void {
    this.stop();
    const at = this.ctx.currentTime + 0.05;
    if (acc) this.playBuffer(acc, from, 0, 'synth', 0.55);
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(this.wave());
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
    osc.stop(at + (b - a) / FPS + 0.05);
    this.nodes.push(osc);
    this.startedAt = at;
    this.offset = from;
    this.end = to;
    this.playing = 'synth';
    this.watch(osc);
  }

  /** 拖音符时一直响着这个音，跟着手走 */
  holdTone(hz: number): void {
    this.releaseTone();
    void this.ctx.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(this.wave());
    osc.frequency.value = hz;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(0.2, now, 0.015);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(now);
    this.held = { osc, g };
  }

  moveTone(hz: number): void {
    this.held?.osc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.012);
  }

  releaseTone(): void {
    if (!this.held) return;
    const now = this.ctx.currentTime;
    this.held.g.gain.setTargetAtTime(0, now, 0.03);
    this.held.osc.stop(now + 0.25);
    this.held = null;
  }
}

const SHORTCUTS: Array<[string, string]> = [
  ['空格', '播放 / 停（停了回到开始的地方）'],
  ['滚轮 / Shift+滚轮', '竖着滚 / 横着滚（触控板两指随便推）'],
  [`${MOD}+滚轮 / Alt+滚轮`, '横向缩放 / 纵向缩放（触控板捏合也行）'],
  ['中键拖', '平移'],
  ['F', '缩放到选中的一段（没选中就整首）'],
  ['V / 1', '选择工具'],
  ['B / 2', '画笔：画音高线（Shift 直线，右键拖擦掉）'],
  ['K / 3', '剪刀：点音符剪成两个，双击剪口合回去'],
  ['J', '选中的几个音符合并成一个'],
  ['L', '循环播放（边循环边改，下一圈就是改过的）'],
  ['点 / Shift+点 / 拖空白', '选音符 / 加选 / 框一段'],
  [`${MOD}+A / Esc`, '全选 / 取消选择'],
  ['拖音符 / Alt+拖', '按半音改 / 不吸附'],
  ['↑ ↓ / Shift+↑ ↓', '选中的升降半音 / 八度'],
  ['双击音符', '对准最近的半音'],
  ['Delete', '选中的恢复成自动修的'],
  [`${MOD}+Z / ${MOD}+Shift+Z`, '撤销 / 重做'],
];

interface Props { id: string; onClose: () => void }

export interface RollApi { fit(range: Range | null): void; zoom(k: number): void }

export function Editor({ id, onClose }: Props) {
  const [data, setData] = useState<EditData | null>(null);
  const [error, setError] = useState<{ text: string; relearn: boolean } | null>(null);
  const [ops, setOps] = useState<EditOp[]>([]);
  const [redo, setRedo] = useState<EditOp[]>([]);
  const [key, setKey] = useState(0);
  const [layer, setLayer] = useState<'vocals' | 'dry' | 'back'>('vocals');
  const [glow, setGlow] = useState<'strong' | 'weak' | 'off'>('weak');
  const [sel, setSel] = useState<Range | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('synth');
  const [playing, setPlaying] = useState(false);
  /** 上次保存（或打开时）的状态：现在的改动和调跟它一样就算没改 */
  const [saved, setSaved] = useState<{ ops: string; key: number }>({ ops: '[]', key: 0 });
  const [tool, setTool] = useState<Tool>('select');
  const [loop, setLoop] = useState(false);
  const loopRef = useRef(false);
  loopRef.current = loop;
  /** 上一次放的是哪一段（循环、改完重听都用它） */
  const lastPlay = useRef<{ from: number; to?: number } | null>(null);
  /** 她的声音：同一段、同一条音高线、同一个调就不再渲染（循环时只在改过之后重新唱） */
  const phraseCache = useRef<{ f0: Float32Array; key: number; a: number; b: number; buf: AudioBuffer; start: number } | null>(null);
  const [tune, setTune] = useState<{ center: number; flatten: number } | null>(null);
  const [help, setHelp] = useState(false);
  const preview = useRef<Preview | null>(null);
  const head = useRef(0);
  const playFrom = useRef(0);
  const roll = useRef<RollApi | null>(null);

  useEffect(() => {
    let alive = true;
    api.edit(id).then((d) => {
      if (!alive) return;
      setData(d); setOps(d.state.ops); setKey(d.state.key);
      setSaved({ ops: JSON.stringify(d.state.ops), key: d.state.key });
    }).catch((err: Error & { relearn?: boolean }) => alive && setError({ text: err.message, relearn: !!err.relearn }));
    preview.current = new Preview();
    return () => { alive = false; preview.current?.stop(); preview.current?.releaseTone(); void preview.current?.ctx.close(); };
  }, [id]);

  const dirtyRef = useRef(false);
  const dirty = useMemo(() => key !== saved.key || JSON.stringify(ops) !== saved.ops, [ops, key, saved]);
  dirtyRef.current = dirty;
  // 大肥鱼在对话里改了这首：没有没保存的改动就直接刷新成她改完的；有的话提醒一下（保存会盖掉她的）
  const edited = useSyncExternalStore(getEngine().subscribe, () => getEngine().state.edited);
  useEffect(() => {
    if (!edited || edited.songId !== id || !data) return;
    if (dirtyRef.current) { setNote('大肥鱼刚改了这首；你这边还有没保存的改动，保存会盖掉她的'); return; }
    api.edit(id).then((d) => {
      setData({ ...d, savedAt: edited.at }); setOps(d.state.ops); setRedo([]); setKey(d.state.key);
      setSaved({ ops: JSON.stringify(d.state.ops), key: d.state.key });
      setNote('大肥鱼刚改了这首，已经换成她改完的');
    }).catch(() => {});
  }, [edited?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const raw = useMemo(() => (data ? decode(data.raw) : null), [data]);
  const plan = useMemo(() => (data?.plan ? decode(data.plan) : null), [data]);
  // 对准 / 拉直 面板开着时：先按滑杆的值画出来、听，点「应用」才记成一步
  const pending: EditOp | null = tune && sel ? { ...sel, kind: 'tune', center: tune.center / 100, flatten: tune.flatten / 100 } : null;
  const f0 = useMemo(() => (raw ? compose(raw, plan, pending ? [...ops, pending] : ops) : null), [raw, plan, ops, pending?.a, pending?.b, tune?.center, tune?.flatten]); // eslint-disable-line react-hooks/exhaustive-deps
  const notes = useMemo(() => (f0 ? notesOf(f0, marksOf(ops)) : []), [f0, ops]);
  const selNotes = useMemo(() => (sel ? notes.filter((n) => n.a < sel.b && n.b > sel.a) : []), [notes, sel]);
  // 调试用：控制台里 __singinglabEditor.notes / .ops 能直接看
  (window as unknown as { __singinglabEditor: unknown }).__singinglabEditor = { notes, ops, sel, playing, loop };

  const apply = useCallback((op: EditOp) => { setOps((o) => [...o, op]); setRedo([]); }, []);
  const undo = useCallback(() => {
    setOps((o) => {
      if (!o.length) return o;
      setRedo((r) => [...r, o[o.length - 1]]);
      return o.slice(0, -1);
    });
  }, []);
  const redoOne = useCallback(() => {
    setRedo((r) => {
      if (!r.length) return r;
      setOps((o) => [...o, r[r.length - 1]]);
      return r.slice(0, -1);
    });
  }, []);

  const stop = useCallback(() => {
    if (preview.current?.playing) head.current = playFrom.current; // 停了回到开始的地方，方便一遍遍听同一段
    preview.current?.stop();
    setPlaying(false);
  }, []);

  const play = useCallback(async (m: Mode, from: number, to?: number) => {
    const p = preview.current;
    if (!p || !data || !f0) return;
    p.stop();
    void p.ctx.resume();
    setMode(m);
    playFrom.current = from;
    head.current = from;
    lastPlay.current = { from, to };
    const end = to ?? data.durationSec;
    try {
      if (m === 'synth') {
        setBusy('准备伴奏…');
        const acc = await p.buffer(api.editAudioUrl(id, 'accomp', key)).catch(() => null);
        setBusy(null);
        p.playSynth(f0, key, from, end, acc);
      } else if (m === 'her') {
        // 给了终点就渲染这一段（选中的、刚改的）；没给就从这里往后 8 秒
        const a = to !== undefined ? from : Math.max(0, from - 0.5);
        const b = to !== undefined ? to : Math.min(data.durationSec, from + 8);
        let hit = phraseCache.current;
        if (!hit || hit.f0 !== f0 || hit.key !== key || hit.a !== a || hit.b !== b) {
          setBusy('她在唱这一段…');
          const out = await api.editPhrase(id, a, b, encode(f0), key);
          const buf = await p.buffer(`${api.editAudioUrl(id, 'phrase', key)}&t=${Date.now()}`);
          setBusy(null);
          setNote(`这一段渲染用了 ${out.renderSec} 秒`);
          hit = { f0, key, a, b, buf, start: out.start };
          phraseCache.current = hit;
        }
        playFrom.current = hit.start;
        p.playBuffer(hit.buf, hit.start, hit.start, 'her');
      } else if (m === 'orig') {
        setBusy('取原唱…');
        const buf = await p.buffer(api.editAudioUrl(id, 'vocals', 0));
        setBusy(null);
        p.playBuffer(buf, from, 0, 'orig', 1, to);
      } else {
        setBusy('取歌库里的版本…');
        const buf = await p.buffer(`${api.audioUrl(id)}&v=${data.savedAt ?? 0}`);
        setBusy(null);
        p.playBuffer(buf, from, 0, 'mix', 1, to);
      }
      setPlaying(true);
    } catch (err) {
      setBusy(null);
      setNote((err as Error).message);
    }
  }, [data, f0, id, key]);

  // 改完马上试听：等这次改动进了音高线再放（setTimeout 时已经是新的 play）
  const playRef = useRef(play);
  playRef.current = play;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const playSoon = useCallback((from: number, to?: number) => { setTimeout(() => void playRef.current(modeRef.current, from, to), 0); }, []);
  /** 放完了（音频自己报的）：开着循环就再放一遍同一段（用最新的音高线，改过的下一圈就听得到）；不然停下、播放头回到开始 */
  useEffect(() => {
    const p = preview.current;
    if (!p) return;
    p.onEnd = () => {
      head.current = playFrom.current;
      const last = lastPlay.current;
      if (loopRef.current && last) void playRef.current(modeRef.current, last.from, last.to);
      else setPlaying(false);
    };
    return () => { p.onEnd = null; };
  }, [data]);
  const toggle = useCallback(() => {
    if (preview.current?.playing) stop();
    else void playRef.current(modeRef.current, sel ? sel.a / FPS : head.current, sel ? sel.b / FPS : undefined);
  }, [sel, stop]);

  const shiftSel = useCallback((n: number) => { if (sel) apply({ ...sel, kind: 'shift', semitones: n }); }, [sel, apply]);
  const resetSel = useCallback(() => { if (sel) apply({ ...sel, kind: 'source', source: 'plan' }); }, [sel, apply]);
  const joinSel = useCallback(() => { if (sel && selNotes.length >= 2) apply({ ...sel, kind: 'join' }); }, [sel, selNotes, apply]);

  // ── 快捷键 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!data) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      let used = true;
      if (e.code === 'Space') toggle();
      else if (mod && k === 'z' && !e.shiftKey) undo();
      else if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) redoOne();
      else if (mod && k === 'a') setSel({ a: 0, b: data.frames });
      else if (e.key === 'Escape') { if (help) setHelp(false); else if (tune) setTune(null); else setSel(null); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') shiftSel((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
      else if (e.key === 'Delete' || e.key === 'Backspace') resetSel();
      else if (!mod && (k === 'v' || k === '1')) setTool('select');
      else if (!mod && (k === 'b' || k === '2')) setTool('draw');
      else if (!mod && (k === 'k' || k === '3')) setTool('cut');
      else if (!mod && k === 'j') joinSel();
      else if (!mod && k === 'l') setLoop((l) => !l);
      else if (!mod && k === 'f') roll.current?.fit(sel);
      else if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) setHelp((h) => !h);
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [data, sel, help, tune, toggle, undo, redoOne, shiftSel, resetSel, joinSel]);

  const close = () => {
    if (dirty && !window.confirm('改动还没保存，确定离开吗？')) return;
    stop();
    onClose();
  };

  const save = async () => {
    if (!f0 || !data) return;
    stop();
    setBusy('她正在按改好的音高重新唱整首，大约 20 秒…');
    try {
      const out = await api.editSave(id, encode(f0), key, ops);
      setData({ ...data, savedAt: out.editedAt });
      setSaved({ ops: JSON.stringify(ops), key });
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
  const hint = tool === 'draw' ? '按住画音高线 · Shift 画直线 · 右键拖擦掉'
    : tool === 'cut' ? '点音符剪成两个 · 双击剪口合回去'
      : '拖音符改音高 · 拖空白处框一段 · 空格试听 · ? 看快捷键';

  return (
    <div className="sl-editor" role="dialog" aria-label="修音">
      <header className="sl-ed-top">
        <button className="sl-ed-back" onClick={close} title="回去"><Icon name="down" size={18} /></button>
        <div className="sl-ed-title"><b>修音</b><span>{title}</span>{dirty ? <i title="有改动还没保存" /> : null}</div>
        {data ? (
          <div className="sl-ed-key" title="整首升降几个半音（她唱的调）">
            <button onClick={() => setKey((k) => k - 1)}>−</button>
            <span>{keyText(key)}{key === data.state.autoKey ? <em>自动选的</em> : <em>自动选的是{keyText(data.state.autoKey)}</em>}</span>
            <button onClick={() => setKey((k) => k + 1)}>+</button>
          </div>
        ) : null}
        {data ? <button className="sl-ed-save" disabled={!!busy || !dirty} onClick={() => void save()}>{dirty ? '保存这首' : '已保存'}</button> : null}
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
              <button className={tool === 'select' ? 'is-on' : ''} onClick={() => setTool('select')} title="选择（V）">选择</button>
              <button className={tool === 'draw' ? 'is-on' : ''} onClick={() => setTool('draw')} title="画笔：画音高线（B）">画笔</button>
              <button className={tool === 'cut' ? 'is-on' : ''} onClick={() => setTool('cut')} title="剪刀：点音符剪成两个，双击剪口合回去（K）">剪刀</button>
            </div>
            <div className="sl-ed-seg" title="底下的频谱图：哪一轨、多亮">
              {data.layers.map((l) => (
                <button key={l} className={layer === l ? 'is-on' : ''} onClick={() => { setLayer(l); if (glow === 'off') setGlow('weak'); }}>{l === 'vocals' ? '原人声（含和声）' : l === 'dry' ? '主唱干声' : '和声'}</button>
              ))}
              <button onClick={() => setGlow((g) => (g === 'strong' ? 'weak' : g === 'weak' ? 'off' : 'strong'))} title="频谱亮度">{glow === 'strong' ? '亮' : glow === 'weak' ? '暗' : '关'}</button>
            </div>
            <div className="sl-ed-seg" title="试听（空格：播放 / 停）">
              <button className={loop ? 'is-on' : ''} onClick={() => setLoop((l) => !l)} title="循环播放选中的一段（L）：边循环边改，下一圈就是改过的"><Icon name="repeat" size={15} /></button>
              {(['synth', 'her', 'orig', 'mix'] as Mode[]).map((m) => (
                <button key={m} className={mode === m ? 'is-on' : ''} onClick={() => setMode(m)}>{m === 'synth' ? '乐器音' : m === 'her' ? '她的声音' : m === 'orig' ? '原唱' : '歌库里的版本'}</button>
              ))}
            </div>
            <div className="sl-ed-seg" title="缩放">
              <button onClick={() => roll.current?.zoom(1 / 1.5)} title={`缩小（${MOD}+滚轮）`}>−</button>
              <button onClick={() => roll.current?.zoom(1.5)} title={`放大（${MOD}+滚轮）`}>+</button>
              <button onClick={() => roll.current?.fit(sel)} title="缩放到选中的一段，没选中就整首（F）">{sel ? '看选中' : '看整首'}</button>
            </div>
            <span className="sl-ed-hint">{busy ?? note ?? hint}</span>
            <button className="sl-ed-help" onClick={() => setHelp((h) => !h)} title="快捷键（?）">?</button>
          </div>
          <Roll
            data={data} raw={raw} f0={f0} keyShift={key} layer={layer} glow={glow} sel={sel} onSel={(r) => { setSel(r); if (!r) setTune(null); }}
            tool={tool} onOp={apply} playSoon={playSoon} preview={preview} playing={playing} onPlaying={setPlaying} notes={notes}
            head={head} playFrom={playFrom} apiRef={roll} id={id}
          />
          <footer className="sl-ed-foot">
            <span className="sl-ed-sel">{sel ? `选中 ${clock(sel.a / FPS)} – ${clock(sel.b / FPS)}` : '没选中'}</span>
            {tune && sel ? (
              <div className="sl-ed-tune">
                <label title="每个音的中心往最近的半音挪多少">对准 <input type="range" min={0} max={100} value={tune.center} onChange={(e) => setTune({ ...tune, center: Number(e.target.value) })} /> <b>{tune.center}%</b></label>
                <label title="音里的起伏（颤音、漂移）压平多少；压太多会像机器">拉直 <input type="range" min={0} max={100} value={tune.flatten} onChange={(e) => setTune({ ...tune, flatten: Number(e.target.value) })} /> <b>{tune.flatten}%</b></label>
                <button onClick={() => playSoon(sel.a / FPS, sel.b / FPS)}>听一下</button>
                <button className="is-primary" onClick={() => { apply({ ...sel, kind: 'tune', center: tune.center / 100, flatten: tune.flatten / 100 }); setTune(null); }}>应用</button>
                <button onClick={() => setTune(null)}>取消</button>
              </div>
            ) : (
              <div className="sl-ed-actions">
                <button disabled={!sel} onClick={() => shiftSel(12)} title="Shift+↑">升八度</button>
                <button disabled={!sel} onClick={() => shiftSel(-12)} title="Shift+↓">降八度</button>
                <button disabled={!sel} onClick={() => shiftSel(1)} title="↑">升半音</button>
                <button disabled={!sel} onClick={() => shiftSel(-1)} title="↓">降半音</button>
                <button disabled={!sel} onClick={() => setTune({ center: 100, flatten: 0 })} title="中心对准半音、压平起伏，像 Melodyne 的音高校正（双击音符 = 对准这个音）">对准 / 拉直…</button>
                <button disabled={selNotes.length < 2} onClick={joinSel} title="选中的几个音符并成一个，拖、对准都当一个音（J）">合并</button>
                <button disabled={!sel} onClick={resetSel} title="恢复成自动修的（Delete）">恢复自动</button>
                <button disabled={!sel} onClick={() => sel && apply({ ...sel, kind: 'source', source: 'raw' })} title="这一段用原来测到的音（不要自动修）">用测到的</button>
                <span className="sl-ed-gap" />
                <button disabled={!ops.length} onClick={undo} title={`${MOD}+Z`}>撤销</button>
                <button disabled={!redo.length} onClick={redoOne} title={`${MOD}+Shift+Z`}>重做</button>
              </div>
            )}
          </footer>
          {help ? (
            <div className="sl-ed-keys" onClick={() => setHelp(false)}>
              <div onClick={(e) => e.stopPropagation()}>
                <h3>快捷键</h3>
                <dl>{SHORTCUTS.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

interface RollProps {
  id: string; data: EditData; raw: Float32Array; f0: Float32Array; keyShift: number;
  layer: 'vocals' | 'dry' | 'back'; glow: 'strong' | 'weak' | 'off';
  sel: Range | null; onSel: (s: Range | null) => void;
  tool: Tool; onOp: (op: EditOp) => void; playSoon: (from: number, to?: number) => void;
  notes: Note[];
  preview: React.MutableRefObject<Preview | null>; playing: boolean; onPlaying: (v: boolean) => void;
  head: React.MutableRefObject<number>; playFrom: React.MutableRefObject<number>;
  apiRef: React.MutableRefObject<RollApi | null>;
}

type Drag =
  | { kind: 'pan'; x0: number; y0: number; t0: number; top: number }
  | { kind: 'scrub' }
  | { kind: 'note'; note: Note; range: Range; y0: number; d: number }
  | { kind: 'sel'; a: number; x0: number; moved: boolean; base: Range | null }
  | { kind: 'draw'; hz: Map<number, number>; last: { i: number; m: number }; start: { i: number; m: number } }
  | { kind: 'erase'; a: number; b: number };

const overlaps = (n: Range, r: Range | null) => !!r && n.a < r.b && n.b > r.a;

function Roll(props: RollProps) {
  const { id, data, raw, f0, keyShift, layer, glow, sel, onSel, tool, onOp, playSoon, preview, playing, onPlaying, head, playFrom, apiRef, notes } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 900, h: 480 });
  const view = useRef({ t0: 0, pps: 90, top: 80, spx: 14 }); // 左边是第几秒、每秒几像素、最上面是哪个音、每半音几像素
  const [, setTick] = useState(0);
  const redraw = useCallback(() => setTick((t) => t + 1), []);
  const drag = useRef<Drag | null>(null);
  const hover = useRef<{ x: number; y: number; note: Note | null } | null>(null);
  const spec = useRef<HTMLImageElement | null>(null);
  const dur = data.durationSec;

  const v = view.current;
  const W = size.w, H = size.h;
  (window as unknown as { __singinglabRoll: unknown }).__singinglabRoll = { view: v, keyw: KEYW, ruler: RULER }; // 调试用
  const span = () => (W - KEYW) / v.pps;
  const rows = () => (H - RULER) / v.spx;
  const tidy = () => {
    v.pps = clamp(v.pps, Math.max(4, (W - KEYW) / (dur + 2)), 800);
    v.spx = clamp(v.spx, 6, 32);
    v.t0 = clamp(v.t0, 0, Math.max(0, dur - span() * 0.5));
    v.top = clamp(v.top, MIDI_LO + rows(), MIDI_HI);
  };
  const x = (t: number) => KEYW + (t - v.t0) * v.pps;
  const tAt = (px: number) => v.t0 + (px - KEYW) / v.pps;
  const y = (m: number) => RULER + (v.top - m) * v.spx;
  const mAt = (py: number) => v.top - (py - RULER) / v.spx;

  // 一打开先把视野放在第一句、她唱的音附近
  useEffect(() => {
    const ms = notes.map((n) => n.midi).sort((a, b) => a - b);
    if (ms.length) {
      const lo = ms[Math.floor(ms.length * 0.05)], hi = ms[Math.floor(ms.length * 0.95)];
      v.top = Math.round((lo + hi) / 2 + rows() / 2);
      v.t0 = Math.max(0, notes[0].a / FPS - 1.5);
    }
    tidy(); redraw();
  }, [notes.length > 0, H]); // eslint-disable-line react-hooks/exhaustive-deps

  apiRef.current = {
    fit(r) {
      const a = r ? r.a / FPS : 0, b = r ? r.b / FPS : dur;
      const pad = (b - a) * 0.08 + 0.2;
      v.pps = (W - KEYW) / (b - a + pad * 2);
      v.t0 = a - pad;
      const inside = notes.filter((n) => (r ? overlaps(n, r) : true)).map((n) => n.midi);
      if (inside.length) {
        const lo = Math.min(...inside), hi = Math.max(...inside);
        v.spx = clamp((H - RULER) / (hi - lo + 8), 6, 32);
        v.top = hi + 4;
      }
      tidy(); redraw();
    },
    zoom(k) {
      const c = v.t0 + span() / 2;
      v.pps *= k;
      v.t0 = c - span() / 2;
      tidy(); redraw();
    },
  };

  useEffect(() => {
    const img = new Image();
    img.onload = () => { spec.current = img; redraw(); };
    img.src = api.editSpecUrl(id, layer);
    spec.current = null;
    redraw();
  }, [id, layer, redraw]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 播放头跟着走，走出画面就翻页；放完回到开始的地方
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      const p = preview.current;
      if (!p?.playing) { onPlaying(false); redraw(); return; }
      head.current = p.time;
      // 放完由音频节点自己报（Preview.onEnd），这里只画播放头
      if (!drag.current && (head.current > v.t0 + span() * 0.92 || head.current < v.t0)) { v.t0 = head.current - span() * 0.1; tidy(); }
      redraw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 滚轮：要拦住浏览器自己的缩放、翻页，所以用不被动的监听
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {           // 横向缩放（触控板捏合也是 ctrl+wheel）
        const t = tAt(px);
        v.pps *= Math.exp(-dy * 0.0025);
        v.t0 = t - (px - KEYW) / v.pps;
      } else if (e.altKey) {                  // 纵向缩放
        const m = mAt(py);
        v.spx *= Math.exp(-(dy || dx) * 0.0025);
        v.top = m + (py - RULER) / v.spx;
      } else if (e.shiftKey) {                // 横着滚（有的系统 Shift+滚轮给的是 deltaX）
        v.t0 += (dx || dy) / v.pps;
      } else {                                // 触控板两指：两个方向都走；鼠标滚轮：竖着滚
        v.t0 += dx / v.pps;
        v.top -= dy / v.spx / 3;
      }
      tidy(); redraw();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const hitNote = (px: number, py: number): Note | null => {
    const t = tAt(px) * FPS, m = mAt(py);
    return notes.find((n) => t >= n.a && t <= n.b && (Math.abs(Math.round(n.midi) - m) < 0.55 || Math.abs(n.midi - m) < 0.6)) ?? null;
  };

  // ── 画 ──
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0c1222'; g.fillRect(0, 0, W, H);
    const t1 = tAt(W);
    const mLow = Math.floor(mAt(H)), mTop = Math.ceil(v.top);
    // 半音格：黑键那一行深一点，C 那条线亮一点
    for (let m = mLow; m <= mTop; m++) {
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      g.fillStyle = black ? '#0a0f1d' : '#0e1528';
      g.fillRect(KEYW, y(m + 0.5), W - KEYW, v.spx);
      if (m % 12 === 0) { g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(KEYW, y(m - 0.5), W - KEYW, 1); }
    }
    // 她唱着不哑的音域（按现在的调换算回原调的位置）
    g.fillStyle = 'rgba(120,190,255,.06)';
    g.fillRect(KEYW, y(HER_HIGH - keyShift + 0.5), W - KEYW, (HER_HIGH - HER_LOW + 1) * v.spx);
    g.strokeStyle = 'rgba(120,190,255,.3)'; g.setLineDash([4, 4]); g.lineWidth = 1;
    for (const m of [HER_HIGH + 0.5, HER_LOW - 0.5]) { g.beginPath(); g.moveTo(KEYW, y(m - keyShift)); g.lineTo(W, y(m - keyShift)); g.stroke(); }
    g.setLineDash([]);
    // 频谱（第 r 行像素的中心是 MIDI 95.67 - r/3：CQT 从 MIDI 36 起每半音 3 格，图上下翻过）
    const img = spec.current;
    if (img && glow !== 'off') {
      g.save(); g.globalAlpha = glow === 'strong' ? 0.9 : 0.42; g.imageSmoothingEnabled = true;
      g.drawImage(img, v.t0 * FPS, (MIDI_HI - v.top) * 3 - 0.5, (t1 - v.t0) * FPS, (v.top - mAt(H)) * 3, KEYW, RULER, W - KEYW, H - RULER);
      g.restore();
    }
    // 拍子线没有，用秒的竖线帮眼睛对齐
    const step = v.pps > 160 ? 0.5 : v.pps > 60 ? 1 : v.pps > 20 ? 5 : 15;
    g.fillStyle = 'rgba(255,255,255,.035)';
    for (let s = Math.ceil(v.t0 / step) * step; s < t1; s += step) g.fillRect(x(s), RULER, 1, H - RULER);
    // 选中的一段
    if (sel) { g.fillStyle = 'rgba(140,200,255,.08)'; g.fillRect(x(sel.a / FPS), RULER, (sel.b - sel.a) / FPS * v.pps, H - RULER); }
    const d0 = drag.current;
    if (d0?.kind === 'erase') { g.fillStyle = 'rgba(255,200,120,.1)'; g.fillRect(x(d0.a / FPS), RULER, (d0.b - d0.a + 1) / FPS * v.pps, H - RULER); }
    const a0 = Math.max(0, Math.floor(v.t0 * FPS) - 1), a1 = Math.min(f0.length, Math.ceil(t1 * FPS) + 1);
    // 原来测到的（和现在差一个半音以上的地方）：橙色虚线
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
    // 音符块：对齐到最近的半音格；块上写她实际唱的音（带上移调）
    const moving = d0?.kind === 'note' ? d0 : null;
    const hov = hover.current?.note ?? null;
    g.font = '600 10px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const n of notes) {
      if (n.b / FPS < v.t0 || n.a / FPS > t1) continue;
      const dd = moving && overlaps(n, moving.range) ? moving.d : 0;
      const row = Math.round(n.midi + dd);
      const out = row + keyShift > HER_HIGH || row + keyShift < HER_LOW;
      const picked = overlaps(n, sel);
      const nx = x(n.a / FPS), nw = Math.max(3, (n.b - n.a) / FPS * v.pps - 1), ny = y(row) - v.spx * 0.46, nh = v.spx * 0.92;
      g.fillStyle = out ? (picked ? 'rgba(255,120,145,.95)' : 'rgba(236,92,118,.72)') : picked ? 'rgba(96,168,255,.98)' : 'rgba(62,126,224,.72)';
      g.beginPath(); g.roundRect(nx, ny, nw, nh, 3); g.fill();
      g.lineWidth = picked || hov === n ? 1.6 : 1;
      g.strokeStyle = picked ? '#ffffff' : hov === n ? 'rgba(220,236,255,.95)' : out ? 'rgba(255,170,185,.7)' : 'rgba(160,205,255,.6)';
      g.stroke();
      if (nw > 30 && v.spx >= 10) { g.fillStyle = 'rgba(255,255,255,.95)'; g.fillText(noteName(row + keyShift), nx + 4, y(row) + 0.5); }
    }
    // 她要唱的音高线
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.6;
    g.beginPath();
    pen = false;
    for (let i = a0; i < a1; i++) {
      if (!(f0[i] > 0)) { pen = false; continue; }
      const dd = moving && i >= moving.range.a && i < moving.range.b ? moving.d : 0;
      const px = x(i / FPS), py = y(midiOf(f0[i]) + dd);
      if (pen) g.lineTo(px, py); else g.moveTo(px, py);
      pen = true;
    }
    g.stroke();
    // 剪刀：音符之间挨着的地方（剪口）画一道细缝；指着音符时画出要剪的位置
    g.fillStyle = '#0c1222';
    for (let k = 1; k < notes.length; k++) {
      const n = notes[k], prev = notes[k - 1];
      if (prev.b !== n.a || n.a / FPS < v.t0 || n.a / FPS > t1) continue;
      g.fillRect(x(n.a / FPS) - 1, y(Math.round(n.midi)) - v.spx * 0.5, 2, v.spx);
    }
    if (tool === 'cut' && hover.current?.note && !d0) {
      const cx = x(Math.round(tAt(hover.current.x) * FPS) / FPS), n = hover.current.note;
      g.strokeStyle = '#ffd866'; g.lineWidth = 1.5; g.setLineDash([3, 2]);
      g.beginPath(); g.moveTo(cx, y(Math.round(n.midi)) - v.spx * 1.2); g.lineTo(cx, y(Math.round(n.midi)) + v.spx * 1.2); g.stroke(); g.setLineDash([]);
    }
    // 正在画的那一笔：黄色
    if (d0?.kind === 'draw' && d0.hz.size) {
      g.strokeStyle = '#ffd866'; g.lineWidth = 2.2; g.beginPath();
      let prev = -2;
      for (const [i, hz] of [...d0.hz.entries()].sort((p, q) => p[0] - q[0])) {
        const px = x(i / FPS), py = y(midiOf(hz));
        if (i === prev + 1) g.lineTo(px, py); else g.moveTo(px, py);
        prev = i;
      }
      g.stroke();
    }
    // 琴键：C 标音名；鼠标所在的那个音亮一下
    g.fillStyle = '#0a0e1a'; g.fillRect(0, RULER, KEYW, H - RULER);
    const hm = hover.current ? Math.round(mAt(hover.current.y)) : null;
    for (let m = mLow; m <= mTop; m++) {
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      g.fillStyle = m === hm ? '#7fb8ff' : black ? '#1b2236' : '#d9e2f2';
      g.fillRect(0, y(m + 0.5) + 0.5, black ? KEYW * 0.62 : KEYW - 1, v.spx - 1);
      if (m % 12 === 0 && v.spx >= 8) { g.fillStyle = '#1b2236'; g.font = '10px system-ui, sans-serif'; g.fillText(noteName(m), 4, y(m)); }
    }
    // 时间尺和歌词
    g.fillStyle = '#0a0e1a'; g.fillRect(0, 0, W, RULER);
    g.fillStyle = 'rgba(220,230,250,.55)'; g.font = '10px system-ui, sans-serif'; g.textBaseline = 'top';
    const label = step * (v.pps > 60 ? 5 : 2);
    for (let s = Math.ceil(v.t0 / step) * step; s < t1; s += step) {
      g.fillRect(x(s), 0, 1, Math.abs(s / label - Math.round(s / label)) < 1e-6 ? 8 : 4);
      if (Math.abs(s / label - Math.round(s / label)) < 1e-6) g.fillText(clock(s).replace(/\.0$/, ''), x(s) + 3, 1);
    }
    g.font = '12px system-ui, sans-serif'; g.fillStyle = 'rgba(235,242,255,.85)';
    for (const l of data.lyrics) {
      if (l.end < v.t0 || l.start > t1) continue;
      g.fillText(l.text, Math.max(KEYW + 2, x(l.start)), 15);
    }
    // 播放头
    if (head.current >= v.t0 && head.current <= t1) { g.fillStyle = '#7fd0ff'; g.fillRect(x(head.current) - 0.75, 0, 1.5, H); }
    // 提示：拖的时候说改成了什么；指着音符时说它是什么音、偏多少
    const tip = moving
      ? `${moving.d > 0 ? '+' : ''}${Number.isInteger(moving.d) ? moving.d : moving.d.toFixed(1)} 半音 → ${noteName(moving.note.midi + moving.d + keyShift)}`
      : hov && hover.current && !d0
        ? (() => { const c = Math.round((hov.midi - Math.round(hov.midi)) * 100); return `${noteName(hov.midi + keyShift)}${c ? `  ${c > 0 ? '偏高' : '偏低'} ${Math.abs(c)} 音分` : '  正好'}`; })()
        : null;
    if (tip && hover.current) {
      g.font = '600 12px system-ui, sans-serif';
      const tw = g.measureText(tip).width + 14;
      const tx = clamp(hover.current.x + 14, KEYW, W - tw - 4), ty = clamp(hover.current.y - 30, RULER + 2, H - 26);
      g.fillStyle = 'rgba(8,12,24,.88)'; g.beginPath(); g.roundRect(tx, ty, tw, 22, 6); g.fill();
      g.fillStyle = '#eaf2ff'; g.textBaseline = 'middle'; g.fillText(tip, tx + 7, ty + 11);
    }
  });

  // ── 指针 ──
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  /** 画笔：从上一点到这一点之间每一帧按直线插值；只画原来有声音的帧（气声、辅音不硬塞音高） */
  const paint = (d: Extract<Drag, { kind: 'draw' }>, i0: number, m0: number, i1: number, m1: number) => {
    const [a, b] = i0 <= i1 ? [i0, i1] : [i1, i0];
    for (let i = Math.max(0, a); i <= Math.min(f0.length - 1, b); i++) {
      if (!(f0[i] > 0)) continue;
      const m = a === b ? m1 : m0 + (m1 - m0) * ((i - i0) / (i1 - i0));
      d.hz.set(i, hzOf(m));
    }
  };

  const onDown = (e: React.PointerEvent) => {
    const { px, py } = pos(e);
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 拿不到也能拖，只是拖出画布就停 */ }
    if (e.button === 1) { e.preventDefault(); drag.current = { kind: 'pan', x0: px, y0: py, t0: v.t0, top: v.top }; return; }
    if (px < KEYW) return;
    if (py < RULER) { head.current = clamp(tAt(px), 0, dur); drag.current = { kind: 'scrub' }; redraw(); return; }
    const i = clamp(Math.round(tAt(px) * FPS), 0, f0.length - 1);
    if (tool === 'cut') {
      const n = hitNote(px, py);
      if (n && e.button === 0 && i - n.a >= 2 && n.b - i >= 2) { onOp({ a: i, b: i + 1, kind: 'cut' }); onSel(null); }
      return;
    }
    if (tool === 'draw') {
      if (e.button === 2) { drag.current = { kind: 'erase', a: i, b: i }; redraw(); return; }
      const m = mAt(py);
      const d: Drag = { kind: 'draw', hz: new Map(), last: { i, m }, start: { i, m } };
      drag.current = d;
      paint(d, i, m, i, m);
      redraw();
      return;
    }
    if (e.button !== 0) return;
    const n = hitNote(px, py);
    if (n) {
      const inSel = overlaps(n, sel);
      const range = e.shiftKey && sel ? { a: Math.min(sel.a, n.a), b: Math.max(sel.b, n.b) } : inSel && sel ? sel : { a: n.a, b: n.b };
      onSel(range);
      drag.current = { kind: 'note', note: n, range, y0: py, d: 0 };
      preview.current?.holdTone(hzOf(n.midi + keyShift));
    } else {
      drag.current = { kind: 'sel', a: i, x0: px, moved: false, base: e.shiftKey ? sel : null };
    }
    redraw();
  };

  const onMove = (e: React.PointerEvent) => {
    const { px, py } = pos(e);
    hover.current = { x: px, y: py, note: hitNote(px, py) };
    const d = drag.current;
    const c = canvas.current!;
    if (!d) {
      c.style.cursor = px < KEYW || py < RULER ? 'default' : tool === 'draw' ? 'crosshair' : tool === 'cut' ? (hover.current.note ? 'col-resize' : 'default') : hover.current.note ? 'ns-resize' : 'default';
      redraw();
      return;
    }
    const i = clamp(Math.round(tAt(px) * FPS), 0, f0.length - 1);
    if (d.kind === 'pan') {
      v.t0 = d.t0 - (px - d.x0) / v.pps;
      v.top = d.top + (py - d.y0) / v.spx;
      tidy();
    } else if (d.kind === 'scrub') {
      head.current = clamp(tAt(px), 0, dur);
    } else if (d.kind === 'note') {
      const raw0 = (d.y0 - py) / v.spx;
      const dd = e.altKey ? Math.round(raw0 * 10) / 10 : Math.round(raw0);
      if (dd !== d.d) { d.d = dd; preview.current?.moveTone(hzOf(d.note.midi + dd + keyShift)); }
    } else if (d.kind === 'sel') {
      if (Math.abs(px - d.x0) > 3) d.moved = true;
      if (d.moved) {
        const r = { a: Math.min(d.a, i), b: Math.max(d.a, i) };
        onSel(d.base ? { a: Math.min(d.base.a, r.a), b: Math.max(d.base.b, r.b) } : r);
      }
    } else if (d.kind === 'draw') {
      const m = mAt(py);
      if (e.shiftKey) { d.hz.clear(); paint(d, d.start.i, d.start.m, i, m); } // Shift：从按下的点拉一条直线
      else paint(d, d.last.i, d.last.m, i, m);
      d.last = { i, m };
    } else if (d.kind === 'erase') {
      d.a = Math.min(d.a, i); d.b = Math.max(d.b, i);
    }
    redraw();
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'note') {
      preview.current?.releaseTone();
      if (d.d) {
        onOp({ ...d.range, kind: 'shift', semitones: d.d });
        playSoon(Math.max(0, d.range.a / FPS - 0.3), d.range.b / FPS + 0.3); // 松手后用选的试听方式听一下改好的这段
      }
    } else if (d.kind === 'sel') {
      if (!d.moved) { onSel(d.base); if (!d.base) head.current = d.a / FPS; }
    } else if (d.kind === 'draw') {
      if (d.hz.size) {
        const idx = [...d.hz.keys()];
        const a = Math.min(...idx), b = Math.max(...idx) + 1;
        // 轻轻抹平手抖（3 帧滑动平均），取整到 0.1 Hz 存起来；直线不用抹
        const hz = Array.from({ length: b - a }, (_, k) => {
          let sum = 0, n = 0;
          for (let j = -1; j <= 1; j++) { const v0 = d.hz.get(a + k + j); if (v0) { sum += v0; n++; } }
          return d.hz.has(a + k) && n ? Math.round((sum / n) * 10) / 10 : 0;
        });
        onOp({ a, b, kind: 'draw', hz });
        onSel({ a, b });
        playSoon(Math.max(0, a / FPS - 0.3), b / FPS + 0.3);
      }
    } else if (d.kind === 'erase') {
      onOp({ a: d.a, b: d.b + 1, kind: 'source', source: 'plan' });
      onSel({ a: d.a, b: d.b + 1 });
    }
    redraw();
  };

  const onDouble = (e: React.MouseEvent) => {
    const { px, py } = pos(e);
    if (tool === 'cut') {
      // 双击剪口（两个挨着的音符中间）：合回去
      const i = Math.round(tAt(px) * FPS);
      const k = notes.findIndex((n, j) => j > 0 && notes[j - 1].b === n.a && Math.abs(n.a - i) <= Math.max(3, 6 / v.pps * FPS));
      if (k > 0) onOp({ a: notes[k - 1].a, b: notes[k].b, kind: 'join' });
      return;
    }
    if (tool !== 'select') return;
    const n = hitNote(px, py);
    if (!n) return;
    onOp({ a: n.a, b: n.b, kind: 'snap' }); // 和 Melodyne 一样：双击音符对准最近的半音
    onSel({ a: n.a, b: n.b });
    playSoon(Math.max(0, n.a / FPS - 0.3), n.b / FPS + 0.3);
  };

  return (
    <div className="sl-ed-main">
      <div className="sl-ed-roll" ref={wrap}>
        <canvas
          ref={canvas} style={{ width: W, height: H }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={() => { hover.current = null; redraw(); }}
          onDoubleClick={onDouble} onContextMenu={(e) => e.preventDefault()}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        />
        <div className="sl-ed-legend">
          <span><i className="w" />她要唱的音</span>
          <span><i className="o" />原来测到的（被和声带偏的地方）</span>
          <span><i className="b" />她唱着不哑的音域</span>
          <span><i className="r" />出了音域的音</span>
        </div>
      </div>
      <Overview notes={notes} dur={dur} view={v} span={span()} head={head.current} sel={sel} keyShift={keyShift}
        onJump={(t) => { v.t0 = t - span() / 2; tidy(); redraw(); }} />
    </div>
  );
}

/** 整首的缩略图：所有音符、选中的一段、播放头、现在看着的那一块。点 / 拖 跳过去 */
function Overview({ notes, dur, view, span, head, sel, keyShift, onJump }: {
  notes: Note[]; dur: number; view: { t0: number }; span: number; head: number; sel: Range | null; keyShift: number; onJump: (t: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(800);
  const H = 40;
  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ms = useMemo(() => notes.map((n) => n.midi), [notes]);
  const lo = ms.length ? Math.min(...ms) - 1 : 48, hi = ms.length ? Math.max(...ms) + 1 : 72;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(H * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0a0e1a'; g.fillRect(0, 0, w, H);
    const X = (t: number) => (t / dur) * w;
    const Y = (m: number) => H - 4 - ((m - lo) / (hi - lo)) * (H - 8);
    if (sel) { g.fillStyle = 'rgba(140,200,255,.14)'; g.fillRect(X(sel.a / FPS), 0, Math.max(2, X((sel.b - sel.a) / FPS)), H); }
    for (const n of notes) {
      const row = Math.round(n.midi);
      const out = row + keyShift > HER_HIGH || row + keyShift < HER_LOW;
      g.fillStyle = out ? 'rgba(236,92,118,.85)' : 'rgba(110,170,255,.8)';
      g.fillRect(X(n.a / FPS), Y(row) - 1, Math.max(1, X((n.b - n.a) / FPS)), 2);
    }
    g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
    g.strokeRect(X(view.t0) + 0.5, 0.5, Math.max(4, X(span)) - 1, H - 1);
    g.fillStyle = '#7fd0ff'; g.fillRect(X(head), 0, 1.5, H);
  });
  const jump = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    onJump(((e.clientX - r.left) / r.width) * dur);
  };
  return (
    <div className="sl-ed-overview" title="整首：点 / 拖 跳过去">
      <canvas ref={canvas} style={{ width: w, height: H }}
        onPointerDown={(e) => { try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 无所谓 */ } jump(e); }}
        onPointerMove={(e) => { if (e.buttons & 1) jump(e); }} />
    </div>
  );
}
