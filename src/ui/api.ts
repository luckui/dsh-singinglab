import type { SongDetail, SongSummary } from '../library';
import type { Job } from '../learner';

export type { Job } from '../learner';

export interface Hit { bvid: string; page: number; title: string; up: string; durationSec: number; views: number; cover: string; guess: string }

export type { LyricLine, Section, SongDetail, SongSummary } from '../library';
export type { EditOp } from '../editor';

/** 修音页要的：音高（base64 float32，10 ms 一帧）、调、做过的改动、歌词、有哪几层频谱 */
export interface EditData {
  id: string; title: string; artist: string; durationSec: number; frames: number;
  raw: string; plan: string | null;
  state: { autoKey: number; key: number; ops: import('../editor').EditOp[] };
  lyrics: import('../library').LyricLine[];
  layers: Array<'vocals' | 'dry' | 'back'>;
  /** 这次打开后保存过：歌库里的版本换了，试听要绕过缓存 */
  savedAt?: number;
}

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
  learn: (req: { bvid: string; page?: number; title: string; artist?: string; autoplay?: boolean; relearn?: boolean }) => post<{ job: Job }>('learn', req).then((r) => r.job),
  edit: async (id: string): Promise<EditData> => {
    const res = await fetch(`${BASE}/edit?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const body = await res.json();
    if (!body.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { relearn: !!body.relearn });
    return body as EditData;
  },
  editSpecUrl: (id: string, layer: string) => `${BASE}/edit-spec?id=${encodeURIComponent(id)}&layer=${layer}`,
  editAudioUrl: (id: string, name: 'vocals' | 'accomp' | 'phrase', key: number) => `${BASE}/edit-audio?id=${encodeURIComponent(id)}&name=${name}&key=${key}`,
  editPhrase: (id: string, start: number, end: number, f0: string, key: number) => post<{ start: number; end: number; renderSec: number }>('edit-phrase', { id, start, end, f0, key }),
  editSave: (id: string, f0: string, key: number, ops: import('../editor').EditOp[]) => post<{ sec: number; editedAt: number }>('edit-save', { id, f0, key, ops }),
  jobs: (after = 0) => get<{ jobs: Job[]; missing: string | null; commands: Array<{ id: number; type: 'play' | 'edited'; songId: string }> }>(`jobs?after=${after}`),
  cancel: (id: string) => post<{ ok: boolean }>('cancel', { id }),
  imgUrl: (u: string) => `${BASE}/img?u=${encodeURIComponent(u)}`,
  assetUrl: (name: string) => `${BASE}/asset?name=${encodeURIComponent(name)}`,
  scene: async (theme: import('./scene').Theme) => {
    const res = await fetch(`${BASE}/asset?name=scene-${theme}.json`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<import('./scene').SceneSpec>;
  },
};
