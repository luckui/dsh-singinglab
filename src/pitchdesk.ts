/**
 * 大肥鱼修音用的「看」：把一首歌她要唱的音高写成她读得懂的文字。她听不见，所以只给事实——
 * 每句歌词的时间、唱到哪些音（已经算上移调）、沙不沙（按她的声音实测的表）、有没有出音域、
 * 自动修正改过哪里（原来测到的是什么）、用户 / 她自己改过哪里。
 * 和修音页用的是同一份算法（pitch.ts），两边看到的音符一样。
 */

import type { EditOp, EditState } from './editor';
import type { LyricLine, Section, SongDetail } from './library';
import { FPS, HER_HIGH, HER_LOW, compose, hoarseAt, marksOf, midiOf, noteName, notesOf, type Note } from './pitch';

export interface PitchDoc {
  song: SongDetail;
  raw: Float32Array;
  plan: Float32Array | null;
  state: EditState;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const keyText = (k: number) => (k === 0 ? '原调' : k > 0 ? `升 ${k}` : `降 ${-k}`);

const SECTION: Record<string, string> = { chorus: '响的段（多半是副歌）', verse: '中等的段', quiet: '轻的段' };
const sectionAt = (sections: Section[], t: number) => sections.find((s) => t >= s.startSec && t < s.endSec)?.kind;

/** 一段时间里：音符、沙的程度（按时长加权）、出音域的音、自动修过的秒数、改过的秒数 */
function look(doc: PitchDoc, f: Float32Array, notes: Note[], a: number, b: number) {
  const key = doc.state.key;
  const inside = notes.filter((n) => n.a < b && n.b > a);
  let hoarse = 0, total = 0;
  for (const n of inside) { const d = n.b - n.a; hoarse += hoarseAt(n.midi + key) * d; total += d; }
  const out = inside.filter((n) => Math.round(n.midi + key) > HER_HIGH || Math.round(n.midi + key) < HER_LOW);
  const base = doc.plan ?? doc.raw;
  let fixed = 0, edited = 0;
  for (let i = Math.max(0, a); i < Math.min(f.length, b); i++) {
    if (doc.raw[i] > 0 && base[i] > 0 && Math.abs(midiOf(base[i]) - midiOf(doc.raw[i])) > 1) fixed++;
    if (f[i] > 0 && base[i] > 0 && Math.abs(midiOf(f[i]) - midiOf(base[i])) > 0.3) edited++;
  }
  const sung = inside.map((n) => n.midi + key);
  return {
    inside, out, fixed: fixed / FPS, edited: edited / FPS, hoarse: total ? hoarse / total : 0,
    low: sung.length ? Math.min(...sung) : null, high: sung.length ? Math.max(...sung) : null,
  };
}

/** 没有歌词时：按停顿（0.6 秒以上没声音）切成一句一句 */
function phrasesOf(notes: Note[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && n.a / FPS - last.end < 0.6) last.end = n.b / FPS;
    else out.push({ start: n.a / FPS, end: n.b / FPS, text: '' });
  }
  return out;
}

export function compute(doc: PitchDoc, ops: EditOp[] = doc.state.ops) {
  const f = compose(doc.raw, doc.plan, ops);
  return { f, notes: notesOf(f, marksOf(ops)) };
}

/** 整首：一句一行 */
export function overview(doc: PitchDoc): string {
  const { f, notes } = compute(doc);
  const { song, state } = doc;
  const lines = song.lyrics.length ? song.lyrics : phrasesOf(notes);
  const seen = new Map<string, number>();
  const rows: string[] = [];
  lines.forEach((l, i) => {
    const a = Math.round(l.start * FPS), b = Math.round((l.end || l.start + 4) * FPS);
    const s = look(doc, f, notes, a, b);
    if (!s.inside.length) return;
    const nth = l.text ? (seen.get(l.text) ?? 0) + 1 : 0;
    if (l.text) seen.set(l.text, nth);
    const sec = sectionAt(song.sections, l.start);
    const flags = [
      `唱 ${noteName(s.low!)}–${noteName(s.high!)}`,
      `沙 ${pct(s.hoarse)}`,
      s.out.length ? `出音域 ${s.out.length} 个（${[...new Set(s.out.map((n) => noteName(n.midi + state.key)))].join(' ')}）` : '',
      s.fixed >= 0.1 ? `自动修过 ${s.fixed.toFixed(1)} 秒` : '',
      s.edited >= 0.1 ? `改过 ${s.edited.toFixed(1)} 秒` : '',
    ].filter(Boolean);
    rows.push(`${i + 1}. [${clock(l.start)}–${clock(l.end || l.start + 4)}] ${l.text ? `「${l.text}」` : '（一句）'}${nth > 1 ? `（这句第 ${nth} 次出现）` : ''}${sec ? ` · ${SECTION[sec] ?? sec}` : ''} · ${flags.join(' · ')}`);
  });
  const all = look(doc, f, notes, 0, f.length);
  return [
    `《${song.title}》${song.artist ? ` ${song.artist}` : ''} · ${clock(song.durationSec)} · 歌库 id：${song.id}`,
    `调：现在${keyText(state.key)}（学的时候自动选的是${keyText(state.autoKey)}）。她唱着不哑的音域是 ${noteName(HER_LOW)}–${noteName(HER_HIGH)}，「沙」是她唱那些音时沙哑的比例（大肥鱼默认声音实测；10% 以下听着干净，30% 以上明显哑，高过 E5 会破）。音名都是她实际唱的音（算上了移调）。`,
    `整首：唱 ${all.low !== null ? `${noteName(all.low)}–${noteName(all.high!)}` : '—'}，平均沙 ${pct(all.hoarse)}，出音域的音 ${all.out.length} 个，自动修正改过 ${all.fixed.toFixed(1)} 秒（和声把音测低了一个八度的地方，升回去了），改过 ${all.edited.toFixed(1)} 秒，改动 ${state.ops.length} 步。`,
    '',
    ...rows,
    '',
    '要看某一段每个音：singinglab_pitch 带上 start、end（秒）。',
  ].join('\n');
}

/** 一段：一个音一行 */
export function detail(doc: PitchDoc, start: number, end: number): string {
  const { f, notes } = compute(doc);
  const key = doc.state.key;
  const a = Math.max(0, Math.round(start * FPS)), b = Math.min(f.length, Math.round(end * FPS));
  const base = doc.plan ?? doc.raw;
  const inside = notes.filter((n) => n.a < b && n.b > a);
  const lyric = doc.song.lyrics.filter((l) => l.end > start && l.start < end).map((l) => l.text).join(' / ');
  const rows = inside.map((n, k) => {
    const m = n.midi + key;
    const cents = Math.round((n.midi - Math.round(n.midi)) * 100);
    const prev = inside[k - 1];
    const jump = prev ? Math.round(n.midi - prev.midi) : 0;
    const rawM = medianOf(doc.raw, n.a, n.b), baseM = medianOf(base, n.a, n.b);
    const flags = [
      Math.round(m) > HER_HIGH ? '高出音域' : Math.round(m) < HER_LOW ? '低出音域' : '',
      rawM !== null && Math.abs(n.midi - rawM) > 6 ? `原来测到的是 ${noteName(rawM + key)}（差 ${Math.round(n.midi - rawM)} 个半音）` : '',
      baseM !== null && Math.abs(n.midi - baseM) > 0.3 ? `改过（自动修的是 ${noteName(baseM + key)}）` : '',
      Math.abs(jump) >= 10 ? `比上一个音${jump > 0 ? '高' : '低'} ${Math.abs(jump)} 个半音` : '',
    ].filter(Boolean);
    return `- ${clock(n.a / FPS)}–${clock(n.b / FPS)} ${noteName(m)}${cents ? `（${cents > 0 ? '偏高' : '偏低'} ${Math.abs(cents)} 音分）` : ''} · 沙 ${pct(hoarseAt(m))}${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
  });
  return [
    `《${doc.song.title}》${clock(start)}–${clock(end)}${lyric ? `「${lyric}」` : ''}：${inside.length} 个音（调：${keyText(key)}；音名是她实际唱的音）`,
    ...rows,
    `歌库 id：${doc.song.id}`,
  ].join('\n');
}

function medianOf(f: Float32Array, a: number, b: number): number | null {
  const ms: number[] = [];
  for (let i = a; i < b; i++) if (f[i] > 0) ms.push(midiOf(f[i]));
  if (!ms.length) return null;
  ms.sort((x, y) => x - y);
  return ms[ms.length >> 1];
}

/** 她说的一次改动 → 改动记录（时间是秒） */
export interface PitchChange {
  start: number;
  end: number;
  action: 'shift' | 'snap' | 'tune' | 'reset' | 'use_measured';
  /** shift：升几个半音（负数是降） */
  semitones?: number;
  /** tune：往半音对准多少、起伏拉直多少（0–100） */
  center?: number;
  flatten?: number;
}

export function toOp(c: PitchChange, frames: number): EditOp {
  const a = Math.max(0, Math.round(c.start * FPS)), b = Math.min(frames, Math.round(c.end * FPS));
  if (!(b > a)) throw new Error(`时间不对：${c.start}–${c.end}`);
  switch (c.action) {
    case 'shift': return { a, b, kind: 'shift', semitones: Math.max(-24, Math.min(24, Math.round(Number(c.semitones ?? 0) * 10) / 10)) };
    case 'snap': return { a, b, kind: 'snap' };
    case 'reset': return { a, b, kind: 'source', source: 'plan' };
    case 'use_measured': return { a, b, kind: 'source', source: 'raw' };
    case 'tune': return { a, b, kind: 'tune', center: clamp01((c.center ?? 100) / 100), flatten: clamp01((c.flatten ?? 0) / 100) };
    default: throw new Error(`不认识的改法 ${String(c.action)}`);
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
