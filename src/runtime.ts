/**
 * 插件本体（index.ts）和 AI 工具（agent.ts）共用的运行时：本体启动时把这些放进来，工具从这里拿。
 * 打包时两个入口共用这一个模块（esbuild splitting），所以是同一份。
 */

import type { Bili } from './bili';
import type { Learner } from './learner';
import type { Library } from './library';
import type { Studio } from './studio';
import type { EditOp } from './editor';
import type { PitchDoc } from './pitchdesk';

/** 给网页的指令：play = 放这首；edited = 大肥鱼改了这首的音高（修音页开着就刷新，正在放就换成新的） */
export interface PlayerCommand { id: number; type: 'play' | 'edited'; songId: string }

/** 修音：读一首歌的音高、按改动重新唱整首（本体 index.ts 放进来，AI 工具用） */
export interface PitchService {
  open(id: string): Promise<PitchDoc>;
  save(id: string, ops: EditOp[], key: number): Promise<{ sec: number }>;
}

export const runtime: {
  ready: Promise<void> | null;
  studio: Studio | null;
  learner: Learner | null;
  library: Library | null;
  bili: Bili | null;
  pitch: PitchService | null;
  /** 给网页播放器的指令（她说「放这首」时），网页轮询学歌状态时一起取走 */
  commands: PlayerCommand[];
} = { ready: null, studio: null, learner: null, library: null, bili: null, pitch: null, commands: [] };

/** 本体把 learner 这些放进 runtime 之后才 resolve（AI 工具插件可能比本体先启动） */
let markStarted: () => void = () => {};
export const started = new Promise<void>((resolve) => { markStarted = resolve; });
export function setStarted(): void { markStarted(); }

let nextCommand = 1;
export function pushCommand(cmd: Omit<PlayerCommand, 'id'>): void {
  runtime.commands.push({ ...cmd, id: nextCommand++ });
  if (runtime.commands.length > 20) runtime.commands.splice(0, runtime.commands.length - 20);
}
