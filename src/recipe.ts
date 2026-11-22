/**
 * 配方：学歌九个环节，每个环节选一种做法（或者关掉）。内置「推荐」「快速」，也可以自定义。
 * 学一首歌时，把当前配方 + 下好的模型 + 装好的引擎 + 选中的声音，翻译成 prepare.py 要的配置（每首歌一份，记在歌的目录里）。
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { linkOrCopy, type Catalog, type RecipeUse, type Shelf } from './shelf';
import type { Setup } from './setup';
import type { Voice } from './voices';

export interface RecipeChoice {
  /** 内置配方的 id，或者 custom */
  id: string;
  /** id 是 custom 时用这个 */
  custom?: RecipeUse;
}

export function resolveRecipe(catalog: Catalog, choice: RecipeChoice): { id: string; name: string; use: RecipeUse } {
  if (choice.id === 'custom' && choice.custom) return { id: 'custom', name: '自定义', use: choice.custom };
  const r = catalog.recipes.find((x) => x.id === choice.id) ?? catalog.recipes[0];
  return { id: r.id, name: r.name, use: r.use };
}

/** 这个配方要哪些模型（换声音总要 RVC 基础模型） */
export function modelsFor(use: RecipeUse): string[] {
  return [use.separate, use.karaoke, use.dereverb, use.lyrics, 'rvc-base'].filter((x): x is string => !!x);
}

/** 生成 prepare.py 的配置；缺什么就抛出一句人话 */
export async function buildConfig(catalog: Catalog, use: RecipeUse, shelf: Shelf, setup: Setup, voice: Voice | null): Promise<{ config: Record<string, unknown>; key: number | null }> {
  if (!voice) throw new Error('还没有她的声音：先在「学歌设置 → 声音」里导入一个 RVC 声音模型');
  for (const id of modelsFor(use)) {
    if (!(await shelf.installed(id))) throw new Error(`还缺模型「${shelf.model(id)?.name ?? id}」，先在学歌设置里下载`);
  }
  // RVC 的两个基础模型要放在引擎目录里 Applio 认的位置
  const base = shelf.model('rvc-base')!;
  for (const [file, rel] of Object.entries(base.place ?? {})) {
    const to = join(setup.codeDir, rel);
    if (!existsSync(to)) {
      await mkdir(dirname(to), { recursive: true });
      await linkOrCopy(shelf.path('rvc-base', file), to);
    }
  }
  const msst = (id: string | null) => {
    if (!id) return undefined;
    const m = catalog.models.find((x) => x.id === id)!;
    return { type: m.msst!.type, config: shelf.path(id, m.msst!.config), checkpoint: shelf.path(id, m.msst!.checkpoint) };
  };
  const config: Record<string, unknown> = {
    msstPython: setup.python,
    msstDir: join(setup.codeDir, 'msst'),
    separator: msst(use.separate),
    ...(use.karaoke ? { karaoke: msst(use.karaoke) } : {}),
    ...(use.dereverb ? { dereverb: msst(use.dereverb) } : {}),
    rvcPython: setup.python,
    applioDir: join(setup.codeDir, 'applio'),
    rvcModel: voice.model,
    rvcIndex: voice.index ?? '',
    ...(use.lyrics ? { whisperModel: shelf.path(use.lyrics) } : {}),
    pitchFix: use.pitch,
    indexRate: voice.indexRate ?? 0.3,
    protect: 0.33,
  };
  const key = use.key === 'auto' ? null : use.key === 'none' ? 0 : Number(use.key) || 0;
  return { config, key };
}
