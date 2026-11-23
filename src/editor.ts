/**
 * 修音页的宿主端：管着 assets/sing/edit_worker.py 这个常驻进程（声音模型只加载一次，渲染一句不到一秒）。
 * 第一次用时启动，5 分钟没人用就关掉（放掉显存）。一次只办一件事，按顺序排。
 *
 * 一首歌能不能修，看它目录里有没有 edit/（学歌时留下的干声、原人声、和声、伴奏、音高）。
 * 以前学的歌没有，要重学一遍。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const IDLE_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 5 * 60_000;

export interface WorkerRuntime { python: string; env: NodeJS.ProcessEnv }

interface Pending { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }

export class EditWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private python = '';
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stderr = '';

  constructor(private readonly script: string) {}

  /** 排队调一个命令；进程没起就起 */
  call<T = any>(rt: WorkerRuntime, msg: Record<string, unknown>): Promise<T> {
    const run = this.queue.then(() => this.send<T>(rt, msg));
    this.queue = run.catch(() => {});
    return run;
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.child?.kill();
    this.child = null;
  }

  private start(rt: WorkerRuntime): ChildProcessWithoutNullStreams {
    if (this.child && this.python === rt.python) return this.child;
    this.close();
    const child = spawn(rt.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...rt.env, PYTHONUNBUFFERED: '1' } });
    this.child = child;
    this.python = rt.python;
    this.stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => { this.stderr = (this.stderr + c).slice(-2000); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let reply: any;
      try { reply = JSON.parse(line); } catch { return; }
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      clearTimeout(p.timer);
      if (reply.ok) p.resolve(reply);
      else p.reject(new Error(reply.error ?? '修音进程出错了'));
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      const tail = this.stderr.trim().split('\n').slice(-3).join(' ');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`修音进程退出了（${code}）${tail ? `：${tail.slice(-300)}` : ''}`));
        this.pending.delete(id);
      }
    });
    child.on('error', () => { /* exit 里统一报 */ });
    return child;
  }

  private send<T>(rt: WorkerRuntime, msg: Record<string, unknown>): Promise<T> {
    const child = this.start(rt);
    if (this.idle) clearTimeout(this.idle);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('修音进程太久没回话'));
        this.close();
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { this.armIdle(); resolve(v); },
        reject: (e) => { this.armIdle(); reject(e); },
        timer,
      });
      child.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
  }
}

/** 修音页存的东西：整首升几个半音、做过哪些改动（重新打开时接着改） */
export interface EditState {
  format: 1;
  autoKey: number;
  key: number;
  keyScores?: Record<string, number>;
  ops: EditOp[];
}

/** 一次改动：一段时间（10 ms 一帧）里的音高怎么处理 */
export type EditOp =
  | { a: number; b: number; kind: 'shift'; semitones: number }
  | { a: number; b: number; kind: 'source'; source: 'raw' | 'plan' }
  /** 手画的音高线：从第 a 帧起每帧的音高（Hz，取整到 0.1）；只改原来有声音的帧 */
  | { a: number; b: number; kind: 'draw'; hz: number[] }
  /** 对准：这一段里每个音整体挪到最近的半音（颤音、滑音都留着） */
  | { a: number; b: number; kind: 'snap' };

export const editDir = (songDir: string) => join(songDir, 'edit');

export async function hasEdit(songDir: string): Promise<boolean> {
  return stat(join(editDir(songDir), 'dry.flac')).then((s) => s.isFile(), () => false);
}

export async function readEditState(songDir: string): Promise<EditState> {
  const raw = JSON.parse((await readFile(join(editDir(songDir), 'edit.json'), 'utf8')).replace(/^﻿/, ''));
  return { format: 1, autoKey: Number(raw.autoKey) || 0, key: Number(raw.key ?? raw.autoKey) || 0, keyScores: raw.keyScores, ops: Array.isArray(raw.ops) ? raw.ops : [] };
}

export async function writeEditState(songDir: string, state: EditState): Promise<void> {
  await writeFile(join(editDir(songDir), 'edit.json'), JSON.stringify(state));
}

/** 读 numpy 的 .npy（一维 float32/float64），转成 float32 */
export async function readNpy(file: string): Promise<Float32Array | null> {
  const buf = await readFile(file).catch(() => null);
  if (!buf || buf.toString('latin1', 1, 6) !== 'NUMPY') return null;
  const major = buf[6];
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const start = (major === 1 ? 10 : 12) + headerLen;
  const header = buf.toString('latin1', major === 1 ? 10 : 12, start);
  const descr = /'descr':\s*'([<>|]?)(f4|f8)'/.exec(header)?.[2];
  const body = buf.subarray(start);
  if (descr === 'f4') return new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (descr === 'f8') {
    const f64 = new Float64Array(body.buffer.slice(body.byteOffset, body.byteOffset + (body.byteLength - (body.byteLength % 8))));
    return Float32Array.from(f64);
  }
  return null;
}

export const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
