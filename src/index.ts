/**
 * dsh-singinglab 宿主端：歌库、音频、封面的路由。网页端（client.tsx）是播放器。
 *
 *   GET  /api/dsh-singinglab/library          歌库列表（摘要，新学的在前）
 *   GET  /api/dsh-singinglab/song?id=…        一首歌：歌词（逐字时间）、节拍、段落
 *   GET  /api/dsh-singinglab/audio?id=…       她唱的混音 mix.mp3，支持 Range（拖进度条）
 *   GET  /api/dsh-singinglab/cover?id=…       封面（B 站视频封面，第一次取时缓存到本地）
 *   GET  /api/dsh-singinglab/settings         设置；POST 同路径改设置
 *   POST /api/dsh-singinglab/search  {q}      在 B 站搜视频（q 是 BV 号或链接时直接给那个视频）
 *   POST /api/dsh-singinglab/learn   {bvid, page?, title, artist?, autoplay?, relearn?}   学一首（排队）；relearn = 会唱也重学
 *   GET  /api/dsh-singinglab/jobs             学歌进度：正在学的、排队的、最近学完的
 *   POST /api/dsh-singinglab/cancel  {id}     取消一首
 *   GET  /api/dsh-singinglab/studio           学歌准备好了没有、缺什么、环境/模型/声音/配方的状态
 *   POST /api/dsh-singinglab/prepare          一键准备：装环境、下当前配方要的模型（后台做，进度看 studio）
 *   POST /api/dsh-singinglab/recipe  {id, custom?}   换配方
 *   POST /api/dsh-singinglab/model   {id}     下一个模型
 *   POST /api/dsh-singinglab/import  {dirs}   从电脑里已有的文件导入模型
 *   POST /api/dsh-singinglab/voice?kind=model|index&name=…&id=…   上传声音文件（请求体就是文件）
 *   POST /api/dsh-singinglab/voice-import {path, name?}   从电脑上的路径导入声音
 *   POST /api/dsh-singinglab/voice-use {id} / voice-remove {id} / voice-rename {id, name}
 *
 * 修音页（一首歌学的时候留下了 edit/ 才能修，见 editor.ts）：
 *   GET  /api/dsh-singinglab/edit?id=…                 音高（测到的 raw、自动修过的 plan，base64 float32，10 ms 一帧）、调、做过的改动、歌词
 *   GET  /api/dsh-singinglab/edit-spec?id=…&layer=…    频谱图 PNG，学歌每一步的分轨：orig 原曲 / inst 伴奏 / vocals 人声（含和声）/ lead 主唱 / back 和声 / dry 干声
 *   GET  /api/dsh-singinglab/edit-audio?id=…&name=…    上面这些分轨的音频；accomp 伴奏 + 和声（&key= 移到这个调）；phrase 刚渲染的那一句
 *   POST /api/dsh-singinglab/edit-phrase {id, start, end, f0, key}   用她的声音渲染这一句（和伴奏混好）
 *   POST /api/dsh-singinglab/edit-save   {id, f0, key, ops}           整首重新转、重新混音，换掉 mix.mp3
 *
 * 数据目录：DSH_HOME/dsh-singinglab。歌库目录默认是其中的 songs，设置里可以再加别的目录（只读）。
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Bili, guessTitle, parseVideoRef } from './bili';
import { Covers } from './covers';
import { EditWorker, b64, editDir, hasEdit, readEditState, readNpy, writeEditState, type EditOp } from './editor';
import { Learner } from './learner';
import type { RecipeChoice } from './recipe';
import { loadCatalog } from './shelf';
import { Studio } from './studio';
import { pushCommand, runtime, setStarted } from './runtime';
import { compose } from './pitch';
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
  /** 学歌：装好 librosa、torch 的 Python */
  python: string;
  /** 学歌：sing.json（分离、拆主唱、去混响、RVC、whisper 模型的路径） */
  config: string;
  /** 学歌放到另一台机器：user@host:port；空 = 在本机学 */
  remote: string;
  /** 最长学几秒的歌 */
  maxSec: number;
  /** 学好的歌放哪（空 = <数据目录>/songs）。学歌程序在 Windows、DSH 在 WSL 时要放在两边都读得到的盘上 */
  songsDir: string;
  /** 学歌配方（默认「推荐」） */
  recipe: RecipeChoice;
  /** 用哪个声音（空 = 最新导入的那个） */
  voice: string | null;
  /** 模型镜像（我们在 ModelScope 上的），空 = 用目录里写的 */
  mirror: string;
}

const DEFAULTS: Settings = { libraries: [], python: '', config: '', remote: '', maxSec: 600, songsDir: '', recipe: { id: 'recommended' }, voice: null, mirror: '' };

const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-singinglab');
/** lib/index.js 旁边的 ../assets */
const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url));
/** 学歌引擎（Applio / MSST 的推理代码）：lib/index.js 旁边的 ../engine */
const engineDir = fileURLToPath(new URL('../engine/', import.meta.url));
const ASSET_TYPES: Record<string, string> = {
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};
const settingsFile = join(dataDir, 'settings.json');

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function normalize(raw: any): Settings {
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v.trim() : d);
  return {
    libraries: Array.isArray(raw?.libraries) ? raw.libraries.filter((d: unknown) => typeof d === 'string' && d.trim()) : DEFAULTS.libraries,
    python: str(raw?.python, DEFAULTS.python),
    config: str(raw?.config, DEFAULTS.config),
    remote: str(raw?.remote, DEFAULTS.remote),
    maxSec: Number(raw?.maxSec) > 0 ? Number(raw.maxSec) : DEFAULTS.maxSec,
    songsDir: str(raw?.songsDir, DEFAULTS.songsDir),
    recipe: raw?.recipe && typeof raw.recipe.id === 'string' ? { id: raw.recipe.id, ...(raw.recipe.custom ? { custom: raw.recipe.custom } : {}) } : DEFAULTS.recipe,
    voice: typeof raw?.voice === 'string' && raw.voice ? raw.voice : null,
    mirror: str(raw?.mirror, DEFAULTS.mirror),
  };
}

async function readSettings(): Promise<Settings> {
  try {
    // Windows PowerShell 写的文件常带 BOM
    return normalize(JSON.parse((await readFile(settingsFile, 'utf8')).replace(/^\uFEFF/, '')));
  } catch {
    return { ...DEFAULTS };
  }
}

const songsDirOf = (s: Settings) => s.songsDir || join(dataDir, 'songs');
const libraryDirs = (s: Settings) => [songsDirOf(s), ...s.libraries];

/** 音频按 Range 回一段；浏览器拖进度条、边下边放都靠它 */
async function serveFile(request: Request, file: string, type: string, cache = 'private, max-age=3600'): Promise<Response> {
  const size = (await stat(file)).size;
  const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache };
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
  let settings: Settings = { ...DEFAULTS };
  const library = new Library(libraryDirs(settings));
  const covers = new Covers(join(dataDir, 'covers'));
  const bili = new Bili();
  let learner: Learner | null = null;
  let studio: Studio | null = null;
  const save = async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  };
  const ready = (async () => {
    settings = await readSettings();
    await mkdir(songsDirOf(settings), { recursive: true }).catch(() => {});
    library.setDirs(libraryDirs(settings));
    studio = new Studio(await loadCatalog(join(assetsDir, 'catalog.json')), dataDir, engineDir, () => settings, () => {});
    const st = studio;
    learner = new Learner(bili, {
      songsDir: songsDirOf(settings),
      stateFile: join(dataDir, 'jobs.json'),
      script: join(assetsDir, 'sing', 'prepare.py'),
      maxSec: () => settings.maxSec,
      check: () => st.check(),
      plan: (out) => st.plan(out),
      onChange: () => {},
    });
    Object.assign(runtime, { studio, learner, library, bili });
    setStarted();
  })();
  runtime.ready = ready;
  ctx.effect(() => () => learner?.close(), 'dsh-singinglab learner');
  const worker = new EditWorker(join(assetsDir, 'sing', 'edit_worker.py'));
  ctx.effect(() => () => worker.close(), 'dsh-singinglab edit worker');

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
    // 修音保存后 mix.mp3 会换：不让浏览器拿旧的缓存
    return file ? serveFile(request, file, 'audio/mpeg', 'no-cache') : json({ ok: false, error: '没有音频' }, 404);
  });

  // ── 修音页 ──
  /** 能修的歌：在自己的歌库目录里（别的目录只读），学的时候留下了 edit/ */
  const editable = async (id: string | null) => {
    if (!validId(id)) throw new Error('bad id');
    const dir = await library.dirOf(id);
    if (!dir) throw new Error('歌库里没有这首');
    if (!dir.startsWith(songsDirOf(settings))) throw new Error('这首在只读的歌库目录里，修不了');
    if (!(await hasEdit(dir))) throw Object.assign(new Error('这首是以前学的，没留下修音要用的分轨：重学一遍就能修'), { relearn: true });
    return { dir, edit: editDir(dir), rt: await studio!.editRuntime(dir) };
  };
  const f0In = (s: unknown) => (typeof s === 'string' && s.length < 4_000_000 ? s : null);
  /** 学歌每一步的分轨（按流水线的顺序）；以前学的歌可能只有其中几轨 */
  const STEMS: Array<[string, string, string]> = [
    ['orig', 'orig.mp3', 'audio/mpeg'], ['inst', 'inst.mp3', 'audio/mpeg'], ['vocals', 'vocals.mp3', 'audio/mpeg'],
    ['lead', 'lead.mp3', 'audio/mpeg'], ['back', 'back.mp3', 'audio/mpeg'], ['dry', 'dry.flac', 'audio/flac'],
  ];
  const stemsIn = async (edit: string) => (await Promise.all(STEMS.map(async ([k, f]) => ((await stat(join(edit, f)).then(() => true, () => false)) ? k : null)))).filter((k): k is string => !!k);

  // 大肥鱼修音用：和修音页同一份数据、同一个常驻进程
  runtime.pitch = {
    async open(id) {
      const { dir, edit } = await editable(id);
      const [raw, plan, state, song] = await Promise.all([readNpy(join(edit, 'raw.npy')), readNpy(join(edit, 'plan.npy')), readEditState(dir), library.detail(id)]);
      if (!raw || !song) throw new Error('这首的音高读不到');
      return { song, raw, plan, state };
    },
    async save(id, ops, key) {
      const { dir, edit, rt } = await editable(id);
      const [raw, plan, state] = await Promise.all([readNpy(join(edit, 'raw.npy')), readNpy(join(edit, 'plan.npy')), readEditState(dir)]);
      if (!raw) throw new Error('这首的音高读不到');
      const k = Math.max(-24, Math.min(24, Math.round(key)));
      await writeEditState(dir, { ...state, key: k, ops: ops.slice(0, 2000) });
      const out = await worker.call(rt, { cmd: 'save', dir: edit, cfg: rt.cfg, f0: b64(compose(raw, plan, ops)), key: k });
      pushCommand({ type: 'edited', songId: id });
      return { sec: out.sec };
    },
  };

  route('/api/dsh-singinglab/edit', ['GET'], async (request) => {
    const id = idOf(request);
    try {
      const { dir, edit, rt } = await editable(id);
      const info = await worker.call(rt, { cmd: 'info', dir: edit, cfg: rt.cfg });
      const [raw, plan, state, song] = await Promise.all([readNpy(join(edit, 'raw.npy')), readNpy(join(edit, 'plan.npy')), readEditState(dir), library.detail(id!)]);
      if (!raw) return json({ ok: false, error: '没有测到的音高' }, 500);
      // 后台先把声音模型、移好调的伴奏准备好（排在队里，第一句试听会等它）
      void worker.call(rt, { cmd: 'warm', dir: edit, cfg: rt.cfg, key: state.key }).catch(() => {});
      return json({
        ok: true, id, title: song?.title ?? id, artist: song?.artist ?? '', durationSec: info.durationSec, frames: info.frames,
        raw: b64(raw), plan: plan ? b64(plan) : null, state, lyrics: song?.lyrics ?? [],
        layers: await stemsIn(edit),
      });
    } catch (err) {
      return json({ ok: false, error: (err as Error).message, relearn: !!(err as { relearn?: boolean }).relearn }, 409);
    }
  });

  route('/api/dsh-singinglab/edit-spec', ['GET'], async (request) => {
    const layer = new URL(request.url).searchParams.get('layer') ?? 'vocals';
    if (!STEMS.some(([k]) => k === layer)) return json({ ok: false, error: 'bad layer' }, 400);
    const { edit, rt } = await editable(idOf(request));
    const out = await worker.call(rt, { cmd: 'spec', dir: edit, layer });
    return new Response(await readFile(out.file) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=600' } });
  });

  route('/api/dsh-singinglab/edit-audio', ['GET'], async (request) => {
    const q = new URL(request.url).searchParams;
    const { edit, rt } = await editable(idOf(request));
    const name = q.get('name');
    const stem = STEMS.find(([k]) => k === name);
    if (stem) return serveFile(request, join(edit, stem[1]), stem[2]);
    if (name === 'phrase') return serveFile(request, join(edit, 'phrase.wav'), 'audio/wav', 'no-store');
    if (name === 'accomp') {
      const out = await worker.call(rt, { cmd: 'accomp', dir: edit, key: Number(q.get('key')) || 0 });
      return serveFile(request, out.file, 'audio/mpeg');
    }
    return json({ ok: false, error: 'bad name' }, 400);
  });

  route('/api/dsh-singinglab/edit-phrase', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { id?: string; start?: number; end?: number; f0?: string; key?: number };
    const { edit, rt } = await editable(body.id ?? null);
    const f0 = f0In(body.f0);
    if (!f0 || !(Number(body.end) > Number(body.start))) return json({ ok: false, error: '要渲染哪一段？' }, 400);
    const out = await worker.call(rt, { cmd: 'phrase', dir: edit, cfg: rt.cfg, start: Number(body.start), end: Math.min(Number(body.end), Number(body.start) + 60), f0, key: Number(body.key) || 0 });
    return json({ ok: true, start: out.start, end: out.end, renderSec: out.renderSec });
  });

  route('/api/dsh-singinglab/edit-save', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { id?: string; f0?: string; key?: number; ops?: EditOp[] };
    const { dir, edit, rt } = await editable(body.id ?? null);
    const f0 = f0In(body.f0);
    if (!f0) return json({ ok: false, error: '没有音高' }, 400);
    const key = Math.max(-24, Math.min(24, Math.round(Number(body.key) || 0)));
    const state = await readEditState(dir);
    await writeEditState(dir, { ...state, key, ops: Array.isArray(body.ops) ? body.ops.slice(0, 2000) : state.ops });
    const out = await worker.call(rt, { cmd: 'save', dir: edit, cfg: rt.cfg, f0, key });
    return json({ ok: true, sec: out.sec, editedAt: out.editedAt });
  });

  route('/api/dsh-singinglab/cover', ['GET'], async (request) => {
    const id = idOf(request);
    if (!validId(id)) return json({ ok: false, error: 'bad id' }, 400);
    const song = await library.detail(id);
    // 还在学的歌（歌库里还没有）也给封面：id 就是 <BV号>-p<分P>
    const bvid = song?.bvid ?? /^(BV[0-9A-Za-z]{10})-p\d+$/.exec(id)?.[1] ?? null;
    const bytes = bvid ? await covers.get(bvid) : null;
    if (!bytes) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
  });

  // 插件自带的美术（场景插画、scene.json），在包里的 assets 目录
  route('/api/dsh-singinglab/asset', ['GET'], async (request) => {
    const name = new URL(request.url).searchParams.get('name');
    if (!name || !/^[\w.-]{1,80}$/.test(name) || name.startsWith('.')) return json({ ok: false, error: 'bad name' }, 400);
    const file = join(assetsDir, name);
    if (!(await stat(file).then((s) => s.isFile(), () => false))) return json({ ok: false, error: '没有这个文件' }, 404);
    const type = ASSET_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
    return new Response(await readFile(file), { headers: { 'content-type': type, 'cache-control': 'private, max-age=600' } });
  });

  route('/api/dsh-singinglab/settings', ['GET', 'POST'], async (request) => {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as Partial<Settings>;
      settings = normalize({ ...settings, ...body });
      await save();
      library.setDirs(libraryDirs(settings));
    }
    return json({ ok: true, settings, dataDir, missing: await studio!.check() });
  });

  // B 站搜索结果的封面：由这边去取（只认 B 站图床），浏览器直连图床时常拿不到
  route('/api/dsh-singinglab/img', ['GET'], async (request) => {
    const u = new URL(request.url).searchParams.get('u') ?? '';
    if (!/^https:\/\/i\d\.hdslb\.com\/bfs\/[\w/.-]+\.(?:jpe?g|png|webp)$/i.test(u)) return json({ ok: false, error: 'bad url' }, 400);
    const res = await fetch(`${u}@480w_300h_1c.jpg`, { headers: { Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res?.ok) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(await res.arrayBuffer()), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
  });

  route('/api/dsh-singinglab/search', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { q?: string };
    const q = String(body.q ?? '').trim().slice(0, 80);
    if (!q) return json({ ok: false, error: '要搜什么？' }, 400);
    const ref = parseVideoRef(q);
    if (ref) {
      const info = await bili.info(ref.bvid);
      if (!info) return json({ ok: false, error: '找不到这个视频' }, 404);
      const part = info.parts.find((p) => p.page === ref.page) ?? info.parts[0];
      return json({ ok: true, hits: [{ bvid: info.bvid, page: part?.page ?? 1, title: info.title, up: info.up, durationSec: part?.durationSec ?? info.durationSec, views: 0, cover: info.cover, guess: guessTitle(info.title) }] });
    }
    const hits = await bili.search(q);
    if (!hits) return json({ ok: false, error: 'B 站搜索暂时用不了，过一会儿再试' }, 502);
    return json({ ok: true, hits: hits.map((h) => ({ ...h, page: 1, guess: guessTitle(h.title, q) })) });
  });

  route('/api/dsh-singinglab/learn', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { bvid?: string; page?: number; title?: string; artist?: string; autoplay?: boolean; relearn?: boolean };
    const ref = parseVideoRef(String(body.bvid ?? ''));
    if (!ref || !learner) return json({ ok: false, error: '没有 BV 号' }, 400);
    const lack = await studio!.check();
    if (lack) return json({ ok: false, error: lack, needs: await studio!.needs() }, 409);
    const job = learner.learn({ bvid: ref.bvid, page: body.page ?? ref.page, title: String(body.title ?? ''), artist: body.artist, autoplay: body.autoplay !== false, relearn: body.relearn === true });
    return json({ ok: true, job });
  });

  route('/api/dsh-singinglab/jobs', ['GET'], async (request) => {
    // 网页带上它已经执行过的最后一条指令编号，这里只给新的（她说「放这首」）
    const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
    return json({ ok: true, jobs: learner?.jobs ?? [], missing: await studio!.check(), commands: runtime.commands.filter((c) => c.id > after) });
  });

  // ── 学歌准备 ──
  route('/api/dsh-singinglab/studio', ['GET'], async () => json({ ok: true, ...(await studio!.status()) }));

  route('/api/dsh-singinglab/prepare', ['POST'], async () => {
    void studio!.prepare();
    return json({ ok: true, started: true });
  });

  route('/api/dsh-singinglab/recipe', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as RecipeChoice;
    if (typeof body.id !== 'string') return json({ ok: false, error: '要哪个配方？' }, 400);
    settings = normalize({ ...settings, recipe: body });
    await save();
    return json({ ok: true, recipe: studio!.recipe(), needs: await studio!.needs() });
  });

  route('/api/dsh-singinglab/model', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { id?: string };
    if (!body.id || !studio!.shelf.model(body.id)) return json({ ok: false, error: '货架上没有这个模型' }, 404);
    void studio!.shelf.download(body.id, studio!.mirror).catch(() => {});
    return json({ ok: true, started: true });
  });

  route('/api/dsh-singinglab/import', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { dirs?: string[] };
    const dirs = (body.dirs ?? []).filter((d) => typeof d === 'string' && d.trim());
    if (!dirs.length) return json({ ok: false, error: '要从哪个文件夹导入？' }, 400);
    return json({ ok: true, imported: await studio!.shelf.importFrom(dirs) });
  });

  route('/api/dsh-singinglab/voice', ['POST'], async (request) => {
    const q = new URL(request.url).searchParams;
    const kind = q.get('kind') === 'index' ? 'index' : 'model';
    const name = (q.get('name') ?? 'voice').slice(0, 80);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length < 1000) return json({ ok: false, error: '文件是空的' }, 400);
    const id = await studio!.voices.put(q.get('id'), name, kind, bytes);
    if (kind === 'model' && !settings.voice) { settings = normalize({ ...settings, voice: id }); await save(); }
    return json({ ok: true, id });
  });

  route('/api/dsh-singinglab/voice-import', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { path?: string; name?: string };
    if (!body.path) return json({ ok: false, error: '模型文件在哪？' }, 400);
    const id = await studio!.voices.importPath(body.path, body.name);
    settings = normalize({ ...settings, voice: id });
    await save();
    return json({ ok: true, id });
  });

  route('/api/dsh-singinglab/voice-use', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { id?: string };
    settings = normalize({ ...settings, voice: body.id ?? null });
    await save();
    return json({ ok: true });
  });

  route('/api/dsh-singinglab/voice-remove', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { id?: string };
    if (body.id) await studio!.voices.remove(body.id);
    if (settings.voice === body.id) { settings = normalize({ ...settings, voice: null }); await save(); }
    return json({ ok: true });
  });

  route('/api/dsh-singinglab/voice-rename', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { id?: string; name?: string };
    if (body.id && body.name) await studio!.voices.rename(body.id, body.name);
    return json({ ok: true });
  });

  route('/api/dsh-singinglab/cancel', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({})) as { id?: string };
    return json({ ok: !!learner?.cancel(String(body.id ?? '')) });
  });
}
