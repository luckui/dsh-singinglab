/**
 * 学歌工作室：把「环境」「模型货架」「声音」「配方」合在一起，对外只回答三件事：
 *   status()     现在能不能学、缺什么、每一项的状态（页面和她都看这个）
 *   prepare()    一键把缺的都补上：装环境 → 下当前配方要的模型。不用用户做任何选择
 *   plan(out)    学一首歌时用什么跑（给 Learner）
 * 手动模式（设置里填了 python 和 sing.json）给愿意折腾的人：用他自己的环境，不走这些。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildConfig, modelsFor, resolveRecipe, type RecipeChoice } from './recipe';
import { Setup } from './setup';
import { Shelf, type Catalog } from './shelf';
import { Voices } from './voices';
import type { Plan } from './learner';

export interface StudioSettings {
  python: string;
  config: string;
  remote: string;
  recipe: RecipeChoice;
  voice: string | null;
  /** 我们自己的模型镜像（ModelScope 上），空 = 用目录里写的 */
  mirror: string;
}

export interface Need { kind: 'env' | 'model' | 'voice'; id?: string; name: string; bytes?: number }

export class Studio {
  readonly setup: Setup;
  readonly shelf: Shelf;
  readonly voices: Voices;
  preparing = false;
  prepareError: string | null = null;

  constructor(readonly catalog: Catalog, dataDir: string, engineSrc: string, private readonly settings: () => StudioSettings, onChange: () => void) {
    this.setup = new Setup(join(dataDir, 'engine'), engineSrc, onChange);
    this.shelf = new Shelf(catalog, join(dataDir, 'models'), onChange);
    this.voices = new Voices(join(dataDir, 'voices'));
  }

  get manual(): boolean {
    const s = this.settings();
    return !!(s.python && s.config);
  }

  get mirror(): string {
    return this.settings().mirror || this.catalog.mirror || '';
  }

  recipe() {
    return resolveRecipe(this.catalog, this.settings().recipe);
  }

  /** 还缺什么（按要补的顺序） */
  async needs(): Promise<Need[]> {
    if (this.manual) return [];
    const out: Need[] = [];
    if (!(await this.setup.ready()).ok) out.push({ kind: 'env', name: '学歌环境（Python + PyTorch，约 5 GB）', bytes: 5e9 });
    for (const id of modelsFor(this.recipe().use)) {
      if (!(await this.shelf.installed(id))) out.push({ kind: 'model', id, name: this.shelf.model(id)?.name ?? id, bytes: this.shelf.bytes(id) });
    }
    if (!(await this.voices.list()).length) out.push({ kind: 'voice', name: '她的声音（RVC 模型 .pth）' });
    return out;
  }

  /** 给 Learner：一句话说缺什么 */
  async check(): Promise<string | null> {
    const n = await this.needs();
    if (!n.length) return null;
    const first = n[0];
    if (first.kind === 'voice' && n.length === 1) return '还没有她的声音：在「学歌设置 → 声音」导入一个 RVC 模型（.pth）';
    return `学歌还没准备好：还缺${n.map((x) => x.name).join('、')}。在「学歌设置」点「一键准备」就行`;
  }

  /** 一键准备：缺什么补什么，不问用户 */
  async prepare(): Promise<void> {
    if (this.preparing) return;
    this.preparing = true;
    this.prepareError = null;
    try {
      if (!(await this.setup.ready()).ok) await this.setup.install();
      for (const id of modelsFor(this.recipe().use)) await this.shelf.download(id, this.mirror);
    } catch (err) {
      this.prepareError = (err as Error).message;
    } finally {
      this.preparing = false;
    }
  }

  /** 跑学歌程序的环境变量：插件自己的环境要带上 ffmpeg 所在的 bin 目录 */
  private env(managed: boolean): NodeJS.ProcessEnv {
    const baseEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    if (!managed) return baseEnv;
    const sep = process.platform === 'win32' ? ';' : ':';
    return { ...baseEnv, KMP_DUPLICATE_LIB_OK: 'TRUE', HF_HUB_OFFLINE: '1', PATH: `${join(this.setup.root, 'bin')}${sep}${process.env.PATH ?? ''}` };
  }

  /** 修音页的常驻进程用什么跑：学这首歌时的配置（配方模式在歌的目录里有 recipe.json；手动模式用设置里的 sing.json） */
  async editRuntime(songDir: string): Promise<{ python: string; env: NodeJS.ProcessEnv; cfg: string }> {
    const own = join(songDir, 'recipe.json');
    const managed = await stat(own).then((st) => st.isFile(), () => false);
    const cfgPath = managed ? own : this.settings().config;
    if (!cfgPath) throw new Error('找不到学这首歌时用的配置，修不了');
    const cfg = JSON.parse((await readFile(cfgPath, 'utf8')).replace(/^\uFEFF/, ''));
    const python = String(cfg.rvcPython || (managed ? this.setup.python : this.settings().python));
    return { python, env: this.env(managed), cfg: cfgPath };
  }

  async plan(out: string): Promise<Plan> {
    const s = this.settings();
    if (this.manual) return { python: s.python, config: s.config, key: null, remote: s.remote, env: this.env(false), recipe: 'manual' };
    const recipe = this.recipe();
    const voice = await this.voices.get(s.voice);
    const { config, key } = await buildConfig(this.catalog, recipe.use, this.shelf, this.setup, voice);
    await mkdir(out, { recursive: true });
    const file = join(out, 'recipe.json');
    await writeFile(file, JSON.stringify({ recipe: recipe.id, voice: voice?.name, ...config }, null, 2));
    return { python: this.setup.python, config: file, key, remote: '', recipe: recipe.id, env: this.env(true) };
  }

  async status() {
    const recipe = this.recipe();
    const models = await this.shelf.status();
    return {
      mode: this.manual ? 'manual' : 'recipe',
      ready: !(await this.needs()).length,
      needs: await this.needs(),
      preparing: this.preparing || this.setup.running,
      prepareError: this.prepareError,
      env: { ready: (await this.setup.ready()).ok, steps: this.setup.steps, gpu: this.setup.gpu },
      recipe,
      recipes: this.catalog.recipes,
      steps: this.catalog.steps,
      models: this.catalog.models.map((m) => ({ ...m, files: undefined, msst: undefined, place: undefined, ...models.find((x) => x.id === m.id) })),
      voices: await this.voices.list(),
      voice: (await this.voices.get(this.settings().voice))?.id ?? null,
      mirror: !!this.mirror,
    };
  }
}
