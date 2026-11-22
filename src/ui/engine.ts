/**
 * 播放器引擎：页面外的单例。面板关掉、切去聊天，歌照样放；回到面板接着显示。
 * 一个 <audio> 放歌；第一次播放时接上 WebAudio 分析器，给背景和光晕读低频能量。
 */

import { api, type SongDetail, type SongSummary } from './api';

export type Repeat = 'off' | 'all' | 'one';

export interface PlayerState {
  songs: SongSummary[];
  queue: string[];
  index: number;
  current: SongDetail | null;
  loading: boolean;
  playing: boolean;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: Repeat;
  error: string | null;
}

type Listener = () => void;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem('dsh-singinglab.volume'));
    return Number.isFinite(v) && v > 0 ? clamp(v, 0, 1) : 0.8;
  } catch {
    return 0.8;
  }
}

class Engine {
  readonly audio: HTMLAudioElement;
  ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Uint8Array<ArrayBuffer> | null = null;
  private listeners = new Set<Listener>();
  private loadSeq = 0;
  state: PlayerState = {
    songs: [], queue: [], index: -1, current: null, loading: false, playing: false,
    duration: 0, volume: readVolume(), shuffle: false, repeat: 'all', error: null,
  };

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = this.state.volume;
    this.audio.addEventListener('play', () => this.set({ playing: true }));
    this.audio.addEventListener('pause', () => this.set({ playing: false }));
    this.audio.addEventListener('durationchange', () => this.set({ duration: this.audio.duration || this.state.current?.durationSec || 0 }));
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('error', () => {
      if (this.state.current) this.set({ error: '这首放不出来（音频读不到）', playing: false });
    });
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  get time(): number {
    return this.audio.currentTime || 0;
  }

  async refresh(): Promise<void> {
    try {
      const songs = await api.library();
      this.set({ songs, error: null });
    } catch (err) {
      this.set({ error: `歌库读不出来：${(err as Error).message}` });
    }
  }

  /** 低频能量 0..1（没接上分析器时是 0） */
  energy(): number {
    if (!this.analyser || !this.bins || !this.state.playing) return 0;
    this.analyser.getByteFrequencyData(this.bins);
    let sum = 0;
    const n = Math.min(12, this.bins.length);
    for (let i = 1; i < n; i++) sum += this.bins[i];
    return sum / ((n - 1) * 255);
  }

  /** 整个频谱 0..1，给小的频谱条用 */
  spectrum(out: Float32Array): void {
    if (!this.analyser || !this.bins || !this.state.playing) {
      out.fill(0);
      return;
    }
    this.analyser.getByteFrequencyData(this.bins);
    const usable = Math.floor(this.bins.length * 0.7);
    for (let i = 0; i < out.length; i++) {
      // 对数分布：低频多给几格
      const a = Math.floor(Math.pow(i / out.length, 1.8) * usable);
      const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / out.length, 1.8) * usable));
      let m = 0;
      for (let j = a; j < b; j++) m = Math.max(m, this.bins[j]);
      out[i] = m / 255;
    }
  }

  private wire() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.78;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }

  /** 从某首开始放；queue 不给就用整个歌库当前的顺序 */
  async playSong(id: string, queue?: string[]): Promise<void> {
    const order = queue ?? this.state.songs.map((s) => s.id);
    const q = this.state.shuffle ? shuffled(order, id) : order;
    this.set({ queue: q, index: Math.max(0, q.indexOf(id)) });
    await this.load(id, true);
  }

  private async load(id: string, autoplay: boolean): Promise<void> {
    const seq = ++this.loadSeq;
    this.wire();
    this.set({ loading: true, error: null });
    this.audio.src = api.audioUrl(id);
    if (autoplay) void this.audio.play().catch(() => {});
    try {
      const song = await api.song(id);
      if (seq !== this.loadSeq) return;
      this.set({ current: song, loading: false, duration: this.audio.duration || song.durationSec });
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.set({ loading: false, error: `这首读不出来：${(err as Error).message}` });
    }
  }

  toggle(): void {
    if (!this.state.current) {
      const first = this.state.songs[0];
      if (first) void this.playSong(first.id);
      return;
    }
    this.wire();
    if (this.audio.paused) void this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  seek(sec: number): void {
    const d = this.state.duration || this.audio.duration || 0;
    this.audio.currentTime = clamp(sec, 0, Math.max(0, d - 0.05));
  }

  step(delta: 1 | -1): void {
    const { queue, index } = this.state;
    if (!queue.length) return;
    if (delta === -1 && this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    const next = (index + delta + queue.length) % queue.length;
    this.set({ index: next });
    void this.load(queue[next], true);
  }

  setVolume(v: number): void {
    const volume = clamp(v, 0, 1);
    this.audio.volume = volume;
    try { localStorage.setItem('dsh-singinglab.volume', String(volume)); } catch { /* 存不了就算了 */ }
    this.set({ volume });
  }

  toggleShuffle(): void {
    const shuffle = !this.state.shuffle;
    const cur = this.state.queue[this.state.index];
    const base = this.state.songs.map((s) => s.id);
    const queue = cur ? (shuffle ? shuffled(base, cur) : base) : this.state.queue;
    this.set({ shuffle, queue, index: cur ? queue.indexOf(cur) : this.state.index });
  }

  cycleRepeat(): void {
    const order: Repeat[] = ['all', 'one', 'off'];
    this.set({ repeat: order[(order.indexOf(this.state.repeat) + 1) % order.length] });
  }

  private onEnded(): void {
    const { repeat, index, queue } = this.state;
    if (repeat === 'one') {
      this.seek(0);
      void this.audio.play().catch(() => {});
      return;
    }
    if (repeat === 'off' && index >= queue.length - 1) return;
    this.step(1);
  }
}

/** 打乱，但让 first 排第一 */
function shuffled(ids: string[], first: string): string[] {
  const rest = ids.filter((x) => x !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest];
}

let engine: Engine | null = null;
export const getEngine = (): Engine => {
  if (!engine) {
    engine = new Engine();
    // 调试用：控制台里 __singinglab.audio / .state 能直接看
    (window as unknown as { __singinglab: Engine }).__singinglab = engine;
  }
  return engine;
};
export type { Engine };
