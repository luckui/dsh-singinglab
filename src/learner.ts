/**
 * 学歌：一次学一首（显卡只有一块），其余排队。
 * 一首 = 从 B 站取音频 → 跑 assets/sing/prepare.py（分离、拆主唱、去混响、对歌词、修音高、定调、质检、转成她的声音、混音）
 * → <歌库>/<BV号>-p<分P>/ 里出现 song.json 和 mix.mp3，歌库就有这首了。
 * prepare.py 每做完一步吐一行 JSON，进度和这一步的名字原样转给页面。学崩了（质检没过）prepare.py 会说原因，原样给人看。
 *
 * 默认在本机学；设置里填了 remote（user@host:port）就把音频传过去在那台机器上学，再把歌曲包取回来。
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Bili } from './bili';

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  bvid: string;
  page: number;
  title: string;
  artist: string;
  who: string;
  cover: string;
  state: JobState;
  /** 正在做的那一步（给人看的名字） */
  label: string;
  /** 0..1 */
  progress: number;
  reason?: string;
  /** 学会了就直接放 */
  autoplay: boolean;
  /** 哪个 DSH 会话让学的：学完（或没学成）告诉那个会话里的她 */
  session?: string;
  /** 已经会唱也重学一遍（修音页要的分轨以前没留） */
  relearn?: boolean;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface LearnRequest {
  bvid: string;
  page?: number;
  title: string;
  artist?: string;
  autoplay?: boolean;
  session?: string;
  relearn?: boolean;
}

export interface LearnerOptions {
  /** 学好的歌放这里（歌库目录） */
  songsDir: string;
  /** 记最近的学歌记录 */
  stateFile: string;
  /** assets/sing/prepare.py */
  script: string;
  maxSec(): number;
  /** 学歌还缺什么（环境没装、模型没下、没有声音……）；null = 能学 */
  check(): Promise<string | null>;
  /** 学这一首用什么跑：配方模式现生成配置写进 out；手动模式用设置里填的 Python 和 sing.json */
  plan(out: string): Promise<Plan>;
  onChange(): void;
}

export interface Plan {
  python: string;
  config: string;
  /** null = 自动定调 */
  key: number | null;
  /** 在另一台机器上学：user@host:port；空 = 本机 */
  remote: string;
  env: NodeJS.ProcessEnv;
  /** 用的哪个配方（记进学歌记录） */
  recipe: string;
}

/** 每一步的名字和占的进度（按实测耗时：分离 15、拆主唱 30、去混响 13、歌词 36、修音高 30、转声音 13、分析 2、混音 6 秒） */
const STEPS: Array<{ step: string; label: string; weight: number }> = [
  { step: 'download', label: '去 B 站取这首歌', weight: 3 },
  { step: 'separate', label: '把人声和伴奏分开', weight: 11 },
  { step: 'karaoke', label: '找出主唱', weight: 21 },
  { step: 'dereverb', label: '擦干净人声', weight: 9 },
  { step: 'gate', label: '确认是一首歌', weight: 1 },
  { step: 'lyrics', label: '对歌词', weight: 24 },
  { step: 'pitch', label: '听准每个音', weight: 20 },
  { step: 'key', label: '找适合她的调', weight: 1 },
  { step: 'quality', label: '检查学得好不好', weight: 1 },
  { step: 'rvc', label: '换成她的声音', weight: 9 },
  { step: 'analyze', label: '找节拍', weight: 1 },
  { step: 'mix', label: '混音', weight: 4 },
];
const TOTAL = STEPS.reduce((s, x) => s + x.weight, 0);
const LEARN_TIMEOUT_MS = 25 * 60_000;
const KEEP_FINISHED = 30;

/** prepare.py 的一行 → 总进度和下一步的名字；不认识的行返回 null */
export function stepProgress(line: { step?: string; state?: string }): { progress: number; label: string } | null {
  const at = STEPS.findIndex((s) => s.step === line.step);
  if (at < 0 || !line.state) return null;
  const passed = STEPS.slice(0, at).reduce((sum, s) => sum + s.weight, 0);
  const finished = line.state === 'done' || line.state === 'cached' || line.state === 'skipped' || line.state === 'report';
  return {
    progress: (passed + (finished ? STEPS[at].weight : STEPS[at].weight * 0.15)) / TOTAL,
    label: finished ? STEPS[at + 1]?.label ?? '收尾' : STEPS[at].label,
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let tail = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => { tail = (tail + c).slice(-300); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 失败（${code}）：${tail.trim().slice(-200)}`))));
  });
}

export class Learner {
  jobs: Job[] = [];
  /** 一首学完或没学成时通知（AI 工具用它告诉让学的那个会话） */
  readonly ended = new Set<(job: Job) => void>();
  private stopRunning: (() => void) | null = null;
  private busy = false;

  constructor(private readonly bili: Bili, private readonly options: LearnerOptions) {
    mkdirSync(options.songsDir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) as Job[];
      // 上次没学完的（DSH 关了）重新排上
      this.jobs = saved.map((j) => (j.state === 'running' ? { ...j, state: 'queued' as const, label: '排队中', progress: 0 } : j));
    } catch { /* 第一次用 */ }
    void this.next();
  }


  private save(): void {
    try { writeFileSync(this.options.stateFile, JSON.stringify(this.jobs, null, 1)); } catch { /* 存不了不影响学 */ }
    this.options.onChange();
  }

  private patch(job: Job, p: Partial<Job>): void {
    Object.assign(job, p);
    this.save();
  }

  learn(req: LearnRequest): Job {
    const page = Math.max(1, Math.floor(req.page ?? 1));
    const id = `${req.bvid}-p${page}`;
    const active = this.jobs.find((j) => j.id === id && (j.state === 'queued' || j.state === 'running'));
    if (active) {
      if (req.autoplay) active.autoplay = true;
      if (req.session) active.session = req.session;
      return active;
    }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    const job: Job = {
      id, bvid: req.bvid, page, title: req.title.trim().slice(0, 60) || req.bvid, artist: (req.artist ?? '').trim().slice(0, 40), who: '', cover: '',
      state: 'queued', label: '排队中', progress: 0, autoplay: req.autoplay ?? true, ...(req.session ? { session: req.session } : {}), ...(req.relearn ? { relearn: true } : {}), queuedAt: Date.now(),
    };
    this.jobs.push(job);
    const finished = this.jobs.filter((j) => j.state === 'done' || j.state === 'failed');
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED));
      this.jobs = this.jobs.filter((j) => !drop.has(j));
    }
    this.save();
    void this.next();
    return job;
  }

  /** 取消：排队的直接拿掉，正在学的停掉 */
  cancel(id: string): boolean {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.state === 'queued') {
      this.jobs = this.jobs.filter((j) => j !== job);
      this.save();
      return true;
    }
    if (job.state === 'running') {
      this.patch(job, { reason: '取消了' });
      this.stopRunning?.();
      return true;
    }
    this.jobs = this.jobs.filter((j) => j !== job);
    this.save();
    return true;
  }

  close(): void {
    this.stopRunning?.();
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    const job = this.jobs.find((j) => j.state === 'queued');
    if (!job) return;
    this.busy = true;
    this.patch(job, { state: 'running', startedAt: Date.now(), label: STEPS[0].label, progress: 0, reason: undefined });
    try {
      await this.work(job);
      this.patch(job, { state: 'done', progress: 1, label: '学会了', endedAt: Date.now() });
    } catch (err) {
      this.patch(job, { state: 'failed', reason: job.reason === '取消了' ? '取消了' : (err as Error).message, endedAt: Date.now() });
    } finally {
      this.busy = false;
      this.stopRunning = null;
      for (const listener of this.ended) {
        try { listener(job); } catch { /* 通知失败不影响学下一首 */ }
      }
      void this.next();
    }
  }

  private async work(job: Job): Promise<void> {
    const lack = await this.options.check();
    if (lack) throw new Error(lack);
    const final = join(this.options.songsDir, job.id);
    const learned = existsSync(join(final, 'song.json')) && existsSync(join(final, 'mix.mp3'));
    if (learned && !job.relearn) return; // 已经学会了
    // 重学：先学到旁边的 .relearn-<id>（歌库不列点开头的目录），学成了再换掉旧的；没学成旧的还在
    const out = learned ? join(this.options.songsDir, `.relearn-${job.id}`) : final;
    if (learned) rmSync(out, { recursive: true, force: true });
    const info = await this.bili.info(job.bvid);
    if (!info) throw new Error('B 站上找不到这个视频（可能删了或者要登录才能看）');
    const part = info.parts.find((p) => p.page === job.page) ?? info.parts[0];
    if (!part) throw new Error('这个视频没有可以播放的分 P');
    this.patch(job, { who: info.up, cover: info.cover });
    const maxSec = this.options.maxSec();
    if (part.durationSec > maxSec) throw new Error(`这首有 ${Math.round(part.durationSec / 60)} 分钟，太长了（最长 ${Math.round(maxSec / 60)} 分钟）`);

    mkdirSync(out, { recursive: true });
    const audio = join(out, 'source.m4a');
    if (!existsSync(audio)) {
      const src = await this.bili.audio(job.bvid, part.cid);
      if (!src) throw new Error('B 站没给这个视频的音频');
      const res = await fetch(src.url, { headers: src.headers, signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`音频下载失败（${res.status}）`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(`${audio}.part`));
      renameSync(`${audio}.part`, audio);
    }
    this.patch(job, { progress: 3 / TOTAL, label: STEPS[1].label });
    const meta = { title: job.title, artist: job.artist, source: `https://www.bilibili.com/video/${job.bvid}?p=${part.page}`, who: info.up };
    const plan = await this.options.plan(out);
    if (plan.remote) await this.prepareRemote(job, out, audio, meta, plan, maxSec);
    else {
      await this.runPrepare(job, plan.python, [this.options.script, '--config', plan.config, '--audio', audio, '--out', out,
        '--title', meta.title, '--artist', meta.artist, '--source', meta.source, '--who', meta.who, '--max-sec', String(maxSec),
        ...(plan.key !== null ? ['--key', String(plan.key)] : [])], plan.env);
    }
    rmSync(audio, { force: true });
    if (!existsSync(join(out, 'song.json')) || !existsSync(join(out, 'mix.mp3'))) throw new Error('学完了却没有生成歌曲文件');
    if (out !== final) {
      for (const name of readdirSync(out)) {
        rmSync(join(final, name), { recursive: true, force: true });
        renameSync(join(out, name), join(final, name));
      }
      rmSync(out, { recursive: true, force: true });
    }
  }

  /** 传音频过去，在那台机器上跑 prepare.py（那台机器的 sing.json 旁边要有同一套 prepare.py），把歌曲包取回来 */
  private async prepareRemote(job: Job, out: string, audio: string, meta: object, s: Plan, maxSec: number): Promise<void> {
    const at = s.remote.lastIndexOf(':');
    const host = at > 0 ? s.remote.slice(0, at) : s.remote, port = at > 0 ? s.remote.slice(at + 1) : '22';
    const ssh = ['-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host];
    const scp = ['-P', port, '-q', '-o', 'BatchMode=yes'];
    const dir = s.config.slice(0, s.config.lastIndexOf('/'));
    const root = `${dir}/jobs/singinglab-${job.id}`;
    writeFileSync(join(out, 'meta.json'), JSON.stringify(meta));
    await run('ssh', [...ssh, `mkdir -p ${root}`]);
    await run('scp', [...scp, audio, join(out, 'meta.json'), `${host}:${root}/`]);
    await this.runPrepare(job, 'ssh', [...ssh,
      `${s.python} ${dir}/prepare.py --config ${s.config} --audio ${root}/source.m4a --out ${root}/out --meta ${root}/meta.json --max-sec ${maxSec}${s.key !== null ? ` --key ${s.key}` : ''}`], s.env);
    await run('scp', [...scp, `${host}:${root}/out/song.json`, `${host}:${root}/out/mix.mp3`, out]);
    rmSync(join(out, 'meta.json'), { force: true });
    await run('ssh', [...ssh, `rm -rf ${root}`]).catch(() => {});
  }

  private runPrepare(job: Job, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
      // 低优先级：别抢前台（播放、DSH 本身）
      try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 改不了就算了 */ }
      const timer = setTimeout(() => child.kill(), LEARN_TIMEOUT_MS);
      this.stopRunning = () => child.kill();
      let reason = '', tail = '', buffer = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          try {
            const line = JSON.parse(raw) as { step?: string; state?: string; reason?: string };
            if (line.state === 'failed') reason = line.reason ?? '';
            const p = stepProgress(line);
            if (p) this.patch(job, p);
          } catch { /* 不是进度行 */ }
        }
      });
      child.stderr.setEncoding('utf8').on('data', (c: string) => { tail = (tail + c).slice(-500); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new Error(reason || (code === null ? '学得太久，停了' : `学歌程序出错（${code}）：${tail.trim().slice(-200)}`)));
      });
    });
  }
}
