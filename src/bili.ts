/**
 * B 站：搜视频、看分 P、取音频地址。不登录（游客 buvid3 + WBI 签名），学歌只要能搜、能取音频。
 * 实测（dsh-livestream 2026-10）：请求要一个接一个发，同时发几个会被限流 412。
 *   搜视频     x/web-interface/wbi/search/type?search_type=video
 *   详情       x/web-interface/view（分 P 和 cid）
 *   音频       x/player/wbi/playurl fnval=16 → dash.audio，挑码率最高的
 */

import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
const SESSION_TTL_MS = 30 * 60_000;
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export interface VideoHit {
  bvid: string;
  title: string;
  up: string;
  durationSec: number;
  views: number;
  cover: string;
}

export interface VideoPart { cid: number; page: number; title: string; durationSec: number }

export interface VideoInfo {
  bvid: string;
  title: string;
  up: string;
  durationSec: number;
  cover: string;
  parts: VideoPart[];
}

interface Session { cookie: string; mixinKey: string }

function clean(value: unknown, max = 120): string {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const clockSec = (text: unknown) => String(text ?? '').split(':').reduce((sum, n) => sum * 60 + (Number(n) || 0), 0);
const https = (url: unknown) => String(url ?? '').replace(/^(?:http:)?\/\//, 'https://');

export function signWbi(params: Record<string, string | number>, mixinKey: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const all: Record<string, string | number> = { ...params, wts: nowSec };
  const query = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${crypto.createHash('md5').update(query + mixinKey).digest('hex')}`;
}

/** BV 号或视频链接里的 BV 号和分 P */
export function parseVideoRef(text: string): { bvid: string; page?: number } | null {
  const bvid = /BV[0-9A-Za-z]{10}/.exec(text)?.[0];
  if (!bvid) return null;
  const page = Number(/[?&]p=(\d+)/.exec(text)?.[1]) || undefined;
  return { bvid, ...(page ? { page } : {}) };
}

export class Bili {
  private session: Promise<Session> | null = null;
  private sessionAt = 0;
  private tail: Promise<unknown> = Promise.resolve();

  private auth(): Promise<Session> {
    if (!this.session || Date.now() - this.sessionAt > SESSION_TTL_MS) {
      this.sessionAt = Date.now();
      this.session = (async () => {
        const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
          .then((r) => r.json()) as { data?: { b_3?: string; b_4?: string } };
        const cookie = `buvid3=${spi.data?.b_3 ?? ''}; buvid4=${encodeURIComponent(spi.data?.b_4 ?? '')}`;
        const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
          .then((r) => r.json()) as { data?: { wbi_img?: { img_url: string; sub_url: string } } };
        const img = nav.data?.wbi_img;
        if (!img) throw new Error('B 站签名密钥拿不到');
        const key = (url: string) => url.slice(url.lastIndexOf('/') + 1).split('.')[0];
        const raw = key(img.img_url) + key(img.sub_url);
        return { cookie, mixinKey: MIXIN_TABLE.map((i) => raw[i]).join('').slice(0, 32) };
      })();
      this.session.catch(() => { this.session = null; });
    }
    return this.session;
  }

  /** 一个接一个发 */
  private get<T>(url: string | (() => Promise<string>)): Promise<{ code: number; message?: string; data?: T } | null> {
    const run = async () => {
      try {
        const s = await this.auth();
        const target = typeof url === 'string' ? url : await url();
        const res = await fetch(target, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: s.cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return null;
        return (await res.json()) as { code: number; message?: string; data?: T };
      } catch {
        return null;
      }
    };
    const turn = this.tail.then(run, run);
    this.tail = turn;
    return turn;
  }

  private signed(base: string, params: Record<string, string | number>) {
    return async () => `${base}?${signWbi(params, (await this.auth()).mixinKey)}`;
  }

  async search(query: string, page = 1, retry = true): Promise<VideoHit[] | null> {
    const body = await this.get<{ result?: any[] }>(this.signed('https://api.bilibili.com/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: query, page,
    }));
    // 不登录时连着搜，B 站会风控：返回空结果或报错。换个游客身份、隔一秒再搜一次
    if (retry && (body?.code !== 0 || !body.data?.result?.length)) {
      this.session = null;
      await new Promise((r) => setTimeout(r, 1200));
      return this.search(query, page, false);
    }
    if (body?.code !== 0) return null;
    return (body.data?.result ?? []).filter((v) => v?.bvid).slice(0, 20).map((v): VideoHit => ({
      bvid: v.bvid,
      title: clean(v.title, 90),
      up: clean(v.author, 30),
      durationSec: clockSec(v.duration),
      views: Number(v.play) || 0,
      cover: https(v.pic),
    }));
  }

  async info(bvid: string): Promise<VideoInfo | null> {
    const body = await this.get<any>(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    const d = body?.code === 0 ? body.data : null;
    if (!d?.bvid) return null;
    return {
      bvid: d.bvid,
      title: clean(d.title, 100),
      up: clean(d.owner?.name, 30),
      durationSec: Number(d.duration) || 0,
      cover: https(d.pic),
      parts: (d.pages ?? []).map((p: any) => ({ cid: Number(p.cid), page: Number(p.page), title: clean(p.part, 60), durationSec: Number(p.duration) || 0 })),
    };
  }

  /** 码率最高的那条音频和读它要带的请求头 */
  async audio(bvid: string, cid: number): Promise<{ url: string; headers: Record<string, string> } | null> {
    const body = await this.get<{ dash?: { audio?: Array<{ bandwidth?: number; baseUrl?: string; base_url?: string }> } }>(
      this.signed('https://api.bilibili.com/x/player/wbi/playurl', { bvid, cid, fnval: 16, fourk: 0 }));
    const audio = (body?.code === 0 ? body.data?.dash?.audio ?? [] : []).filter((a) => a.baseUrl || a.base_url);
    audio.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    const url = audio[0]?.baseUrl ?? audio[0]?.base_url;
    return url ? { url, headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': UA } } : null;
  }
}

/** 视频标题 → 像歌名的样子：去掉【】里的、去掉「MV」「官方」「高音质」这类词。搜的词出现在标题里就直接用搜的词 */
export function guessTitle(videoTitle: string, query = ''): string {
  const q = query.trim();
  if (q && q.length <= 20 && videoTitle.toLowerCase().includes(q.toLowerCase())) return q;
  const t = videoTitle
    .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/\b(MV|PV|Official|Lyrics?|Video|Audio|HD|4K|Hi-?Res)\b/gi, ' ')
    .replace(/官方|高音质|无损|完整版|动态歌词|歌词版|中文字幕|中字|修复版|重制版|\d{3,4}[Pp]|\d+FPS|音质/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const quoted = /《([^》]{1,40})》/.exec(videoTitle)?.[1] ?? /「([^」]{1,40})」/.exec(videoTitle)?.[1];
  return (quoted ?? t ?? videoTitle).slice(0, 40) || videoTitle.slice(0, 40);
}
