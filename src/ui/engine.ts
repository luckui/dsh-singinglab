/**
 * 播放器引擎：页面外的单例。面板关掉、切去聊天，歌照样放；回到面板接着显示。
 * 一个 <audio> 放歌；第一次播放时接上 WebAudio 分析器，给背景和光晕读低频能量。
 */

import { api, type Job, type SongDetail, type SongSummary } from './api';

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
  /** 学歌任务（正在学、排队、最近学完） */
  jobs: Job[];
  /** 学歌还缺什么设置；null = 能学 */
  learnMissing: string | null;
  /** 一条提示（学会了、没学成） */
  toast: { id: number; text: string; songId?: string } | null;
  /** 要打开「学歌设置」（点了学歌但还没准备好） */
  studioAsk: number;
  /** 要打开修音页的那首歌 */
  editing: string | null;
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
    jobs: [], learnMissing: null, toast: null, studioAsk: 0, editing: null,
  };
  private jobTimer = 0;
  private seenDone = new Set<string>();
  private jobsLoaded = false;
  private lastCommand = -1;

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

  /** 学歌状态：有在学的每 1.5 秒问一次，没有就 8 秒一次 */
  private pollJobs = async (): Promise<void> => {
    clearTimeout(this.jobTimer);
    try {
      const { jobs, missing, commands } = await api.jobs(Math.max(0, this.lastCommand));
      // 她在对话里说「放这首」：第一次轮询只记下编号，不执行以前的
      for (const c of commands) {
        if (this.lastCommand >= 0 && c.type === 'play') { await this.refresh(); void this.playSong(c.songId); }
        this.lastCommand = Math.max(this.lastCommand, c.id);
      }
      if (this.lastCommand < 0) this.lastCommand = 0;
      const fresh = jobs.filter((j) => j.state === 'done' && !this.seenDone.has(j.id));
      const failed = jobs.filter((j) => j.state === 'failed' && !this.seenDone.has(j.id));
      for (const j of [...fresh, ...failed]) this.seenDone.add(j.id);
      this.set({ jobs, learnMissing: missing });
      // 第一次拉到的是以前的记录，不提示
      if (this.jobsLoaded) {
        for (const j of failed) this.notify(`《${j.title}》没学成：${j.reason ?? ''}`);
        if (fresh.length) {
          await this.refresh();
          const last = fresh[fresh.length - 1];
          if (last.autoplay) this.playLearned(last.id, last.title);
          else this.notify(`学会了《${last.title}》`, last.id);
        }
      }
      this.jobsLoaded = true;
    } catch { /* 下次再问 */ }
    const active = this.state.jobs.some((j) => j.state === 'running' || j.state === 'queued');
    this.jobTimer = window.setTimeout(this.pollJobs, active ? 1500 : 8000);
  };

  notify(text: string, songId?: string): void {
    this.set({ toast: { id: Date.now(), text, ...(songId ? { songId } : {}) } });
  }

  /** 学会了：没在放歌就直接放；正在放就排到下一首，提示一下 */
  private playLearned(id: string, title: string): void {
    if (!this.state.playing) {
      void this.playSong(id);
      this.notify(`学会了《${title}》，唱给你听`);
      return;
    }
    this.playNext(id);
    this.notify(`学会了《${title}》，这首放完就唱`, id);
  }

  /** 插到当前这首后面 */
  playNext(id: string): void {
    const queue = this.state.queue.filter((x) => x !== id);
    const at = Math.max(0, queue.indexOf(this.state.queue[this.state.index]));
    queue.splice(at + 1, 0, id);
    this.set({ queue, index: at });
  }

  async learn(req: { bvid: string; page?: number; title: string; artist?: string }): Promise<void> {
    try {
      await api.learn({ ...req, autoplay: true });
      this.notify(`开始学《${req.title}》`);
      void this.pollJobs();
    } catch (err) {
      const msg = (err as Error).message;
      // 还没准备好：直接把学歌设置打开，那里有一键准备
      if (/还没准备好|还没有她的声音|还缺模型/.test(msg)) this.set({ studioAsk: Date.now() });
      this.notify(msg);
    }
  }

  openStudio(): void {
    this.set({ studioAsk: Date.now() });
  }

  openEditor(id: string | null): void {
    if (id) this.audio.pause(); // 修音页自己试听，播放器先停，不叠在一起
    this.set({ editing: id });
  }

  /** 修音保存后歌库里的 mix.mp3 换了：正在放这首就从原来的位置接着放新的 */
  reloadSong(id: string): void {
    if (this.state.current?.id !== id) return;
    const at = this.audio.currentTime, was = !this.audio.paused;
    this.audio.src = `${api.audioUrl(id)}&v=${Date.now()}`;
    this.audio.addEventListener('loadedmetadata', () => {
      this.audio.currentTime = at;
      if (was) void this.audio.play().catch(() => {});
    }, { once: true });
  }

  async cancelJob(id: string): Promise<void> {
    await api.cancel(id).catch(() => {});
    void this.pollJobs();
  }

  startJobs(): void {
    if (!this.jobTimer) void this.pollJobs();
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

  /** 在当前队列里跳到某首（不在队列里就从它开始按歌库顺序放） */
  jump(id: string): void {
    const i = this.state.queue.indexOf(id);
    if (i < 0) { void this.playSong(id); return; }
    this.set({ index: i });
    void this.load(id, true);
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
