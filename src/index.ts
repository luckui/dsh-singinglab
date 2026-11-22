/**
 * dsh-singinglab 宿主端：歌库、音频、封面的路由。网页端（client.tsx）是播放器。
 *
 *   GET  /api/dsh-singinglab/library          歌库列表（摘要，新学的在前）
 *   GET  /api/dsh-singinglab/song?id=…        一首歌：歌词（逐字时间）、节拍、段落
 *   GET  /api/dsh-singinglab/audio?id=…       她唱的混音 mix.mp3，支持 Range（拖进度条）
 *   GET  /api/dsh-singinglab/cover?id=…       封面（B 站视频封面，第一次取时缓存到本地）
 *   GET  /api/dsh-singinglab/settings         设置；POST 同路径改设置
 *
 * 数据目录：DSH_HOME/dsh-singinglab。歌库目录默认是其中的 songs，设置里可以再加别的目录（只读）。
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Covers } from './covers';
import { Library, validId } from './library';

export const name = 'dsh-singinglab';
export const inject = ['connection'];

interface HostContext {
  effect(effect: () => () => void, label?: string): unknown;
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch: (request: Request) => Response | Promise<Response> }): () => void } };
}

export interface Settings {
  /** 额外的歌库目录（只读），排在自己的 songs 后面 */
  libraries: string[];
}

const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-singinglab');
const settingsFile = join(dataDir, 'settings.json');

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function readSettings(): Promise<Settings> {
  try {
    // Windows PowerShell 写的文件常带 BOM
    const raw = JSON.parse((await readFile(settingsFile, 'utf8')).replace(/^﻿/, ''));
    return { libraries: Array.isArray(raw.libraries) ? raw.libraries.filter((d: unknown) => typeof d === 'string' && d.trim()) : [] };
  } catch {
    return { libraries: [] };
  }
}

const libraryDirs = (s: Settings) => [join(dataDir, 'songs'), ...s.libraries];

/** 音频按 Range 回一段；浏览器拖进度条、边下边放都靠它 */
async function serveFile(request: Request, file: string, type: string): Promise<Response> {
  const size = (await stat(file)).size;
  const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  if (!range || (range[1] === '' && range[2] === '')) {
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...base, 'content-length': String(size) } });
  }
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  start = Math.max(0, start);
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers: { ...base, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` },
  });
}

export function apply(ctx: HostContext): void {
  let settings: Settings = { libraries: [] };
  const library = new Library(libraryDirs(settings));
  const covers = new Covers(join(dataDir, 'covers'));
  const ready = (async () => {
    await mkdir(join(dataDir, 'songs'), { recursive: true }).catch(() => {});
    settings = await readSettings();
    library.setDirs(libraryDirs(settings));
  })();

  const route = (path: string, methods: string[], fetch: (request: Request) => Response | Promise<Response>) =>
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods, requestBody: 'buffered',
      fetch: async (request) => {
        await ready;
        try {
          return await fetch(request);
        } catch (err) {
          return json({ ok: false, error: (err as Error).message }, 500);
        }
      },
    }), `dsh-singinglab ${path}`);
  const idOf = (request: Request) => new URL(request.url).searchParams.get('id');

  route('/api/dsh-singinglab/library', ['GET'], async () => json({ ok: true, songs: await library.list() }));

  route('/api/dsh-singinglab/song', ['GET'], async (request) => {
    const id = idOf(request);
    if (!validId(id)) return json({ ok: false, error: 'bad id' }, 400);
    const song = await library.detail(id);
    return song ? json({ ok: true, song }) : json({ ok: false, error: '歌库里没有这首' }, 404);
  });

  route('/api/dsh-singinglab/audio', ['GET'], async (request) => {
    const id = idOf(request);
    if (!validId(id)) return json({ ok: false, error: 'bad id' }, 400);
    const file = await library.audioPath(id);
    return file ? serveFile(request, file, 'audio/mpeg') : json({ ok: false, error: '没有音频' }, 404);
  });

  route('/api/dsh-singinglab/cover', ['GET'], async (request) => {
    const id = idOf(request);
    if (!validId(id)) return json({ ok: false, error: 'bad id' }, 400);
    const song = await library.detail(id);
    const bytes = song?.bvid ? await covers.get(song.bvid) : null;
    if (!bytes) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
  });

  route('/api/dsh-singinglab/settings', ['GET', 'POST'], async (request) => {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as Partial<Settings>;
      if (Array.isArray(body.libraries)) {
        settings = { ...settings, libraries: body.libraries.filter((d) => typeof d === 'string' && d.trim()) };
        await mkdir(dataDir, { recursive: true });
        await writeFile(settingsFile, JSON.stringify(settings, null, 2));
        library.setDirs(libraryDirs(settings));
      }
    }
    return json({ ok: true, settings, dataDir });
  });
}
