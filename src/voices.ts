/**
 * 她的声音：RVC 模型（.pth，可选 .index），一个声音一个目录：<数据目录>/voices/<id>/{model.pth, model.index, voice.json}。
 * 网页上把文件拖进来就导入；也可以从电脑上的路径导入（给 DSH 里的她用：用户说「用这个模型」，她把路径交过来）。
 */

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface Voice {
  id: string;
  name: string;
  model: string;
  index?: string;
  indexRate?: number;
  addedAt: number;
}

const ID = /^[\w.-]{1,60}$/;

export class Voices {
  constructor(private readonly dir: string) {}

  async list(): Promise<Voice[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: Voice[] = [];
    for (const id of names) {
      try {
        const meta = JSON.parse(await readFile(join(this.dir, id, 'voice.json'), 'utf8'));
        const model = join(this.dir, id, 'model.pth');
        const index = join(this.dir, id, 'model.index');
        if (!(await stat(model).catch(() => null))) continue;
        out.push({ id, name: meta.name ?? id, model, ...((await stat(index).catch(() => null)) ? { index } : {}), indexRate: meta.indexRate, addedAt: meta.addedAt ?? 0 });
      } catch { /* 不是声音目录 */ }
    }
    return out.sort((a, b) => b.addedAt - a.addedAt);
  }

  async get(id: string | null): Promise<Voice | null> {
    const all = await this.list();
    return all.find((v) => v.id === id) ?? all[0] ?? null;
  }

  private newId(name: string): string {
    const base = name.replace(/\.(pth|index)$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'voice';
    return `${base}-${Date.now().toString(36)}`;
  }

  /** 网页上传：文件内容直接写进去。kind 是 model 还是 index */
  async put(id: string | null, name: string, kind: 'model' | 'index', bytes: Uint8Array): Promise<string> {
    const vid = id && ID.test(id) ? id : this.newId(name);
    const dir = join(this.dir, vid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, kind === 'model' ? 'model.pth' : 'model.index'), bytes);
    const metaFile = join(dir, 'voice.json');
    const meta = await readFile(metaFile, 'utf8').then(JSON.parse).catch(() => ({ name: name.replace(/\.(pth|index)$/i, ''), addedAt: Date.now() }));
    await writeFile(metaFile, JSON.stringify(meta, null, 2));
    return vid;
  }

  /** 从电脑上的路径导入（.pth，旁边同名或唯一的 .index 一起带上） */
  async importPath(pth: string, name?: string): Promise<string> {
    if (!/\.pth$/i.test(pth)) throw new Error('RVC 声音模型是 .pth 文件');
    const vid = this.newId(name || basename(pth));
    const dir = join(this.dir, vid);
    await mkdir(dir, { recursive: true });
    await copyFile(pth, join(dir, 'model.pth'));
    const folder = join(pth, '..');
    const idx = (await readdir(folder).catch(() => [] as string[])).filter((f) => /\.index$/i.test(f));
    if (idx.length) await copyFile(join(folder, idx.length === 1 ? idx[0] : idx.find((f) => f.includes(basename(pth, '.pth'))) ?? idx[0]), join(dir, 'model.index'));
    await writeFile(join(dir, 'voice.json'), JSON.stringify({ name: name || basename(pth, '.pth'), addedAt: Date.now() }, null, 2));
    return vid;
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await rm(join(this.dir, id), { recursive: true, force: true });
  }

  async rename(id: string, name: string): Promise<void> {
    const metaFile = join(this.dir, id, 'voice.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    await writeFile(metaFile, JSON.stringify({ ...meta, name: name.slice(0, 40) }, null, 2));
  }
}
