import type { SongDetail, SongSummary } from '../library';
import type { Job } from '../learner';

export type { Job } from '../learner';

export interface Hit { bvid: string; page: number; title: string; up: string; durationSec: number; views: number; cover: string; guess: string }

export type { LyricLine, Section, SongDetail, SongSummary } from '../library';

const BASE = '/api/dsh-singinglab';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { credentials: 'same-origin' });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  library: () => get<{ songs: SongSummary[] }>('library').then((r) => r.songs),
  song: (id: string) => get<{ song: SongDetail }>(`song?id=${encodeURIComponent(id)}`).then((r) => r.song),
  audioUrl: (id: string) => `${BASE}/audio?id=${encodeURIComponent(id)}`,
  coverUrl: (id: string) => `${BASE}/cover?id=${encodeURIComponent(id)}`,
  search: (q: string) => post<{ hits: Hit[] }>('search', { q }).then((r) => r.hits),
  learn: (req: { bvid: string; page?: number; title: string; artist?: string; autoplay?: boolean }) => post<{ job: Job }>('learn', req).then((r) => r.job),
  jobs: (after = 0) => get<{ jobs: Job[]; missing: string | null; commands: Array<{ id: number; type: 'play'; songId: string }> }>(`jobs?after=${after}`),
  cancel: (id: string) => post<{ ok: boolean }>('cancel', { id }),
  imgUrl: (u: string) => `${BASE}/img?u=${encodeURIComponent(u)}`,
  assetUrl: (name: string) => `${BASE}/asset?name=${encodeURIComponent(name)}`,
  scene: async (theme: import('./scene').Theme) => {
    const res = await fetch(`${BASE}/asset?name=scene-${theme}.json`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<import('./scene').SceneSpec>;
  },
};
