import type { SongDetail, SongSummary } from '../library';

export type { LyricLine, Section, SongDetail, SongSummary } from '../library';

const BASE = '/api/dsh-singinglab';

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
};
