/**
 * 封面：用 B 站视频的封面。第一次要时去 B 站查（视频信息接口不用登录），存到 <数据目录>/covers/<BV号>.jpg，以后直接读。
 * 同一个 BV 号同时只查一次；查不到的记一下，一小时内不再查。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const RETRY_MS = 60 * 60 * 1000;

export class Covers {
  private inflight = new Map<string, Promise<Uint8Array | null>>();
  private failedAt = new Map<string, number>();

  /** 同时最多查 3 个，歌库一下子滚出几百张封面时别把 B 站接口打爆 */
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly dir: string) {}

  private async slot<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= 3) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  async get(bvid: string): Promise<Uint8Array | null> {
    const file = join(this.dir, `${bvid}.jpg`);
    const cached = await readFile(file).catch(() => null);
    if (cached) return cached;
    if (Date.now() - (this.failedAt.get(bvid) ?? 0) < RETRY_MS) return null;
    let job = this.inflight.get(bvid);
    if (!job) {
      job = this.slot(() => this.fetchCover(bvid, file)).finally(() => this.inflight.delete(bvid));
      this.inflight.set(bvid, job);
    }
    return job;
  }

  private async fetchCover(bvid: string, file: string): Promise<Uint8Array | null> {
    try {
      const info = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json()) as { code: number; data?: { pic?: string } };
      const pic = info.code === 0 ? info.data?.pic : undefined;
      if (!pic) throw new Error(`no cover (${info.code})`);
      // B 站图床支持按尺寸裁：宽 960、jpg，够播放器的大封面用
      const url = `${pic.replace(/^http:/, 'https:')}@960w_600h_1c.jpg`;
      const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`cover http ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await mkdir(this.dir, { recursive: true });
      await writeFile(file, bytes);
      return bytes;
    } catch {
      this.failedAt.set(bvid, Date.now());
      return null;
    }
  }
}
