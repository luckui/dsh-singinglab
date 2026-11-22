/**
 * 歌库：一个或几个目录，每首歌一个子目录，里面有 song.json 和 mix.mp3（学歌程序 prepare.py 的产物）。
 * 只读。目录名就是歌的 id（例如 BV1P94y147eV-p1），几个目录里重名的以先列的为准。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface LyricLine {
  start: number;
  end: number;
  text: string;
  tokens?: string[];
  at?: number[];
}

export interface Section { startSec: number; endSec: number; kind: string }

/** 列表里每首歌的摘要（不带歌词、节拍这些大字段） */
export interface SongSummary {
  id: string;
  title: string;
  artist: string;
  /** B 站 UP 主 */
  who: string;
  durationSec: number;
  bvid: string | null;
  hasLyrics: boolean;
  keyShift: number;
  learnedAt: number;
}

/** 播放一首歌时页面要的全部数据 */
export interface SongDetail extends SongSummary {
  bpm: number | null;
  beats: number[];
  downbeats: number[];
  sections: Section[];
  lyrics: LyricLine[];
  source: string;
}

const ID = /^[\w.-]{1,80}$/;
export const validId = (id: string | null): id is string => !!id && ID.test(id) && id !== '.' && id !== '..';

const bvidOf = (id: string, source: string): string | null => (id.match(/^(BV[0-9A-Za-z]{10})/) ?? source.match(/(BV[0-9A-Za-z]{10})/))?.[1] ?? null;

function summarize(id: string, d: any, learnedAt: number): SongDetail {
  const source = typeof d.source === 'string' ? d.source : '';
  const lyrics: LyricLine[] = Array.isArray(d.lyrics) ? d.lyrics.filter((l: any) => typeof l?.start === 'number' && typeof l?.text === 'string') : [];
  return {
    id,
    title: String(d.title ?? id),
    artist: String(d.artist ?? ''),
    who: String(d.who ?? ''),
    durationSec: Number(d.durationSec) || 0,
    bvid: bvidOf(id, source),
    hasLyrics: lyrics.length > 0,
    keyShift: Number(d.keyShift) || 0,
    learnedAt,
    bpm: typeof d.bpm === 'number' ? d.bpm : null,
    beats: Array.isArray(d.beats) ? d.beats : [],
    downbeats: Array.isArray(d.downbeats) ? d.downbeats : [],
    sections: Array.isArray(d.sections) ? d.sections : [],
    lyrics,
    source,
  };
}

const brief = (s: SongDetail): SongSummary => ({
  id: s.id, title: s.title, artist: s.artist, who: s.who, durationSec: s.durationSec,
  bvid: s.bvid, hasLyrics: s.hasLyrics, keyShift: s.keyShift, learnedAt: s.learnedAt,
});

export class Library {
  private dirs: string[];
  private cache = new Map<string, { mtime: number; song: SongDetail; dir: string }>();

  constructor(dirs: string[]) {
    this.dirs = dirs;
  }

  setDirs(dirs: string[]): void {
    this.dirs = dirs;
    this.cache.clear();
  }

  /** 歌所在的目录（找不到返回 null） */
  private async locate(id: string): Promise<string | null> {
    const hit = this.cache.get(id);
    if (hit) return hit.dir;
    for (const root of this.dirs) {
      const dir = join(root, id);
      if (await stat(join(dir, 'song.json')).then((s) => s.isFile(), () => false)) return dir;
    }
    return null;
  }

  private async load(id: string, dir: string): Promise<SongDetail | null> {
    const file = join(dir, 'song.json');
    const st = await stat(file).catch(() => null);
    if (!st) return null;
    const hit = this.cache.get(id);
    if (hit && hit.mtime === st.mtimeMs) return hit.song;
    try {
      const song = summarize(id, JSON.parse(await readFile(file, 'utf8')), st.mtimeMs);
      this.cache.set(id, { mtime: st.mtimeMs, song, dir });
      return song;
    } catch {
      return null;
    }
  }

  async list(): Promise<SongSummary[]> {
    const seen = new Set<string>();
    const out: SongSummary[] = [];
    for (const root of this.dirs) {
      const names = await readdir(root).catch(() => [] as string[]);
      await Promise.all(names.map(async (name) => {
        if (!validId(name) || seen.has(name)) return;
        seen.add(name);
        const song = await this.load(name, join(root, name));
        if (song) out.push(brief(song));
      }));
    }
    return out.sort((a, b) => b.learnedAt - a.learnedAt);
  }

  async detail(id: string): Promise<SongDetail | null> {
    const dir = await this.locate(id);
    return dir ? this.load(id, dir) : null;
  }

  async audioPath(id: string): Promise<string | null> {
    const dir = await this.locate(id);
    if (!dir) return null;
    const file = join(dir, 'mix.mp3');
    return (await stat(file).then((s) => s.isFile(), () => false)) ? file : null;
  }
}
