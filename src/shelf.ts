/**
 * 模型货架：assets/catalog.json 里的每个模型，下到 <数据目录>/models/<id>/。
 * 下载：sources 按顺序试（{mirror} 没配就跳过），断点续传（.part），边下边算 sha256，大小和 sha256 都对才算下好。
 * 也可以从电脑里已有的文件导入：在给的目录里按「文件名 + 大小」找，sha256 对上就拷过来（同一块盘就建硬链接，不占空间）。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CatalogFile { name: string; size: number; sha256: string; sources: string[] }
export interface CatalogModel {
  id: string;
  step: string;
  name: string;
  license: string;
  note: string;
  msst?: { type: string; config: string; checkpoint: string; stem?: string };
  /** 下好后还要放一份到学歌引擎目录里的哪儿（RVC 的基础模型） */
  place?: Record<string, string>;
  files: CatalogFile[];
}
export interface Catalog {
  mirror: string;
  models: CatalogModel[];
  steps: Array<{ id: string; name: string; fixed?: boolean; required?: boolean; optional?: boolean; patch?: boolean; why?: string; modes?: string[] }>;
  recipes: Array<{ id: string; name: string; note: string; use: RecipeUse }>;
}
export interface RecipeUse {
  separate: string;
  karaoke: string | null;
  dereverb: string | null;
  lyrics: string | null;
  pitch: boolean;
  key: 'auto' | 'none' | number;
}

export interface ModelStatus {
  id: string;
  installed: boolean;
  bytes: number;
  /** 正在下：下了多少 */
  downloading?: { done: number; total: number; file: string };
  error?: string;
}

const UA = 'dsh-singinglab';

export class Shelf {
  private busy = new Map<string, { done: number; total: number; file: string }>();
  private errors = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly catalog: Catalog, readonly dir: string, private readonly onChange: () => void) {}

  model(id: string): CatalogModel | undefined {
    return this.catalog.models.find((m) => m.id === id);
  }

  path(id: string, file?: string): string {
    return file ? join(this.dir, id, file) : join(this.dir, id);
  }

  bytes(id: string): number {
    return this.model(id)?.files.reduce((s, f) => s + f.size, 0) ?? 0;
  }

  async installed(id: string): Promise<boolean> {
    const m = this.model(id);
    if (!m) return false;
    for (const f of m.files) {
      const st = await stat(this.path(id, f.name)).catch(() => null);
      if (!st || st.size !== f.size) return false;
    }
    return true;
  }

  async status(): Promise<ModelStatus[]> {
    return Promise.all(this.catalog.models.map(async (m) => ({
      id: m.id, installed: await this.installed(m.id), bytes: this.bytes(m.id),
      ...(this.busy.has(m.id) ? { downloading: this.busy.get(m.id)! } : {}),
      ...(this.errors.has(m.id) ? { error: this.errors.get(m.id)! } : {}),
    })));
  }

  /** 下一个模型（排队，一次下一个）；已经下好的直接返回 */
  download(id: string, mirror: string): Promise<void> {
    const job = this.queue.then(() => this.downloadNow(id, mirror));
    this.queue = job.catch(() => {});
    return job;
  }

  private async downloadNow(id: string, mirror: string): Promise<void> {
    const m = this.model(id);
    if (!m) throw new Error(`货架上没有 ${id}`);
    if (await this.installed(id)) return;
    this.errors.delete(id);
    const total = this.bytes(id);
    let base = 0;
    try {
      await mkdir(this.path(id), { recursive: true });
      for (const f of m.files) {
        const target = this.path(id, f.name);
        const st = await stat(target).catch(() => null);
        if (st?.size === f.size) { base += f.size; continue; }
        const sources = f.sources.map((s) => s.replace('{mirror}', mirror.replace(/\/$/, ''))).filter((s) => !s.startsWith('{') && !(s.startsWith('/') && !mirror));
        let lastErr = '没有能用的下载地址（国内镜像还没配置）';
        let ok = false;
        for (const url of sources.filter((s) => /^https?:\/\//.test(s))) {
          try {
            await this.fetchFile(url, target, f, (done) => { this.busy.set(id, { done: base + done, total, file: f.name }); this.onChange(); });
            ok = true;
            break;
          } catch (err) {
            lastErr = `${new URL(url).host}：${(err as Error).message}`;
          }
        }
        if (!ok) throw new Error(lastErr);
        base += f.size;
      }
    } catch (err) {
      this.errors.set(id, (err as Error).message);
      throw err;
    } finally {
      this.busy.delete(id);
      this.onChange();
    }
  }

  /** 断点续传下一个文件，边下边算 sha256；不对就删掉重来 */
  private async fetchFile(url: string, target: string, f: CatalogFile, progress: (done: number) => void): Promise<void> {
    const part = `${target}.part`;
    const hash = createHash('sha256');
    let have = (await stat(part).catch(() => null))?.size ?? 0;
    if (have > f.size) { await unlink(part).catch(() => {}); have = 0; }
    if (have > 0) {
      // 续传：先把已经下的那部分算进 sha256
      await new Promise<void>((resolve, reject) => createReadStream(part).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject));
    }
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(have ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if (have && res.status !== 206) {
      // 这个源不支持续传：扔掉已下的，从头下
      await res.body.cancel().catch(() => {});
      await unlink(part).catch(() => {});
      return this.fetchFile(url, target, f, progress);
    }
    const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
    let done = have;
    let last = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        // 下载中途卡住 60 秒就算失败（换下一个源或下次续传）
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('下载卡住了')), 60_000))]);
        if (chunk.done) break;
        hash.update(chunk.value);
        done += chunk.value.length;
        if (!out.write(chunk.value)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (Date.now() - last > 400) { last = Date.now(); progress(done); }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    progress(done);
    if (done !== f.size) throw new Error(`大小不对（${done} / ${f.size}）`);
    const sha = hash.digest('hex');
    if (sha !== f.sha256) {
      await unlink(part).catch(() => {});
      throw new Error('校验不对（文件内容和预期的不一样）');
    }
    await rename(part, target);
  }

  /** 从电脑里已有的文件导入：在这些目录里（往下找三层）按文件名和大小找，sha256 对上就链接/拷贝过来。返回导入了哪些模型 */
  async importFrom(dirs: string[]): Promise<string[]> {
    const found = new Map<string, string>(); // "名字|大小" → 路径
    const walk = async (dir: string, depth: number) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
        else if (e.isFile()) {
          const st = await stat(p).catch(() => null);
          if (st) found.set(`${e.name}|${st.size}`, p);
        }
      }
    };
    for (const d of dirs) await walk(d, 0);
    const done: string[] = [];
    for (const m of this.catalog.models) {
      if (await this.installed(m.id)) continue;
      const hits = m.files.map((f) => found.get(`${f.name}|${f.size}`));
      if (hits.some((h) => !h)) continue;
      let ok = true;
      for (let i = 0; i < m.files.length && ok; i++) {
        if ((await sha256(hits[i]!)) !== m.files[i].sha256) ok = false;
      }
      if (!ok) continue;
      await mkdir(this.path(m.id), { recursive: true });
      for (let i = 0; i < m.files.length; i++) await linkOrCopy(hits[i]!, this.path(m.id, m.files[i].name));
      done.push(m.id);
    }
    this.onChange();
    return done;
  }
}

export function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** 同一块盘建硬链接（不占空间），不行就拷贝 */
export async function linkOrCopy(from: string, to: string): Promise<void> {
  if (existsSync(to)) await unlink(to).catch(() => {});
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}

export async function loadCatalog(file: string): Promise<Catalog> {
  return JSON.parse(await readFile(file, 'utf8')) as Catalog;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2));
}
