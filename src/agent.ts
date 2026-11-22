/**
 * 唱歌工具：挂在根上（cordis.patch.yml），用户平时的每个会话、任何模式都能用；插件不带预设、不带人设。
 * 用户在对话里说「我想听晴天」「帮我把学歌装好」，就用这些工具办完：
 *   singinglab_status          学歌准备好了没有、缺什么、歌库有几首、正在学什么
 *   singinglab_prepare         一键准备（装环境、下模型），后台进行
 *   singinglab_import_voice    导入一个 RVC 声音模型（电脑上的 .pth 路径）
 *   singinglab_search          在歌库和 B 站上找歌
 *   singinglab_learn           学一首（B 站视频），学会了播放器会自动放
 *   singinglab_play            在播放器里放歌库里的一首
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { guessTitle, parseVideoRef } from './bili';
import { pushCommand, runtime } from './runtime';

export const name = 'dsh-singinglab-agent';
export const inject = ['tools'];

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  tools: { register(tool: unknown): () => void };
}

const text = { schema: { type: 'string' as const }, render: (_a: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function rt() {
  await runtime.ready;
  if (!runtime.studio || !runtime.learner || !runtime.library || !runtime.bili) throw new Error('唱歌插件还没启动好');
  return { studio: runtime.studio, learner: runtime.learner, library: runtime.library, bili: runtime.bili };
}

export function apply(ctx: AgentContext): void {
  const reg = (tool: unknown, label: string) => ctx.effect(() => ctx.tools.register(tool), label);

  reg(defineTool({
    name: 'singinglab_status',
    description: '唱歌插件（dsh-singinglab）的状态：学歌准备好了没有、还缺什么（环境、模型、她的声音）、显卡、歌库有几首、正在学哪首。用户想听歌、想学歌，或者问唱歌插件怎么样了，先看这个。缺环境或模型就直接 singinglab_prepare，不用问用户（默认就是最好的）；唯一要用户给的是她的声音（RVC .pth）。',
    parameters: {},
    output: text,
    async execute() {
      const { studio, learner, library } = await rt();
      const s = await studio.status();
      const songs = await library.list();
      const running = learner.jobs.find((j) => j.state === 'running');
      const queued = learner.jobs.filter((j) => j.state === 'queued');
      const lines = [
        s.mode === 'manual' ? '学歌：用的是用户自己配的环境（手动模式）。' : s.ready ? '学歌：准备好了，可以学。' : `学歌：还没准备好，缺 ${s.needs.map((n) => `${n.name}${n.bytes ? `（${gb(n.bytes)}）` : ''}`).join('、')}。`,
        s.preparing ? `正在一键准备：${s.env.steps.filter((x) => x.state !== 'pending').map((x) => `${x.name} ${x.state === 'done' ? '✓' : x.state === 'running' ? '进行中' : x.state === 'failed' ? `失败：${x.detail ?? ''}` : ''}`).join('；')}` : '',
        s.prepareError ? `上次准备失败：${s.prepareError}` : '',
        s.env.gpu ? `显卡：${s.env.gpu.name}，${Math.round(s.env.gpu.memoryMB / 1024)} GB` : '',
        `她的声音：${s.voices.length ? s.voices.map((v) => v.name + (v.id === s.voice ? '（在用）' : '')).join('、') : '还没有（要一个 RVC 模型 .pth，用 singinglab_import_voice 导入）'}`,
        `配方：${s.recipe.name}`,
        `歌库：${songs.length} 首`,
        running ? `正在学《${running.title}》：${running.label} ${Math.round(running.progress * 100)}%` : '',
        queued.length ? `排队：${queued.map((j) => `《${j.title}》`).join('、')}` : '',
      ];
      return lines.filter(Boolean).join('\n');
    },
  }), 'singinglab_status');

  reg(defineTool({
    name: 'singinglab_prepare',
    description: '一键准备学歌：装学歌环境（Python + PyTorch，插件自己的目录，不碰用户别的环境）、下载当前配方要的模型。后台进行，几分钟到半小时（看网速），进度用 singinglab_status 看。用户不用做任何选择，直接调。',
    parameters: {},
    output: text,
    async execute() {
      const { studio } = await rt();
      const needs = await studio.needs();
      if (!needs.length) return '已经准备好了，不用再装。';
      const work = needs.filter((n) => n.kind !== 'voice');
      if (work.length) void studio.prepare();
      const voice = needs.find((n) => n.kind === 'voice');
      return [
        work.length ? `开始准备：${work.map((n) => `${n.name}${n.bytes ? `（${gb(n.bytes)}）` : ''}`).join('、')}。在后台进行，用 singinglab_status 看进度。` : '',
        voice ? '还缺她的声音：需要一个 RVC 声音模型（.pth 文件，最好带同名 .index）。问用户模型文件在哪，用 singinglab_import_voice 导入；或者让用户在唱歌面板的「学歌设置」里把文件拖进去。' : '',
      ].filter(Boolean).join('\n');
    },
  }), 'singinglab_prepare');

  reg(defineTool({
    name: 'singinglab_import_voice',
    description: '导入她的声音：一个 RVC 声音模型（.pth 文件；同一个文件夹里的 .index 会一起带上）。导入后学歌就用这个声音。',
    parameters: {
      path: { type: 'string', required: true, description: '.pth 文件在这台电脑上的完整路径' },
      name: { type: 'string', description: '给这个声音起个名字（可选）' },
    },
    output: text,
    async execute(args: { path?: string; name?: string }) {
      const { studio } = await rt();
      const id = await studio.voices.importPath(String(args.path ?? ''), args.name ? String(args.name) : undefined);
      return `导入好了（${id}）。之后学歌用这个声音。`;
    },
  }), 'singinglab_import_voice');

  reg(defineTool({
    name: 'singinglab_search',
    description: '找歌：先在她已经学会的歌里找，再去 B 站搜视频。B 站结果里挑一个「有人声在唱一整首歌」的视频去学（不要纯音乐、教学、合集）；原唱、高音质的版本最好。也可以直接给 BV 号或视频链接。',
    parameters: { query: { type: 'string', required: true, description: '歌名，可以加歌手；或者 BV 号 / 视频链接' } },
    output: text,
    async execute(args: { query?: string }) {
      const { library, bili } = await rt();
      const q = String(args.query ?? '').trim();
      const mine = (await library.list()).filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q.toLowerCase().split(/\s+/)[0] ?? '')).slice(0, 5);
      const ref = parseVideoRef(q);
      const hits = ref ? await bili.info(ref.bvid).then((i) => (i ? [{ bvid: i.bvid, title: i.title, up: i.up, durationSec: i.durationSec, views: 0, cover: i.cover }] : [])) : (await bili.search(q)) ?? [];
      return [
        mine.length ? `她已经会唱：\n${mine.map((s) => `- 《${s.title}》${s.artist ? ` ${s.artist}` : ''}（歌库 id：${s.id}）`).join('\n')}` : '她还不会唱这首。',
        hits.length ? `B 站上：\n${hits.slice(0, 8).map((h) => `- ${h.bvid}  ${h.title}  · ${h.up} · ${clock(h.durationSec)}${h.views ? ` · ${h.views} 播放` : ''}  （猜的歌名：${guessTitle(h.title, q)}）`).join('\n')}` : 'B 站上没搜到（或者搜索暂时用不了）。',
      ].join('\n\n');
    },
  }), 'singinglab_search');

  reg(defineTool({
    name: 'singinglab_learn',
    description: '让她学一首歌（B 站视频）：在用户电脑上分离人声、换成她的声音，一首大约 3 分钟（看显卡）。学会了播放器会自动放（正在放别的就排到下一首）。歌名要准（对歌词要用）。',
    parameters: {
      bvid: { type: 'string', required: true, description: 'BV 号或视频链接' },
      title: { type: 'string', required: true, description: '歌名（干净的歌名，不要「MV」「高音质」这些）' },
      artist: { type: 'string', description: '原唱歌手（知道就填，对歌词更准）' },
      page: { type: 'number', description: '分 P（默认第 1 个）' },
    },
    output: text,
    async execute(args: { bvid?: string; title?: string; artist?: string; page?: number }) {
      const { studio, learner } = await rt();
      const ref = parseVideoRef(String(args.bvid ?? ''));
      if (!ref) return '没认出 BV 号。';
      const lack = await studio.check();
      if (lack) return `${lack}\n可以先调 singinglab_prepare。`;
      const job = learner.learn({ bvid: ref.bvid, page: args.page ?? ref.page, title: String(args.title ?? ''), artist: args.artist, autoplay: true });
      return job.state === 'queued' && learner.jobs.some((j) => j.state === 'running' && j.id !== job.id)
        ? `排上了《${job.title}》，前面还有歌在学。学会了会自动放。`
        : `开始学《${job.title}》，大约 3 分钟，学会了会自动放。`;
    },
  }), 'singinglab_learn');

  reg(defineTool({
    name: 'singinglab_play',
    description: '放一首已经学会的歌：在用户的 DSH 网页里直接放出来（不用打开唱歌页面）。用户想看歌词和画面，对话里的卡片上有「去唱歌」按钮。',
    parameters: { song: { type: 'string', required: true, description: '歌库 id（singinglab_search 给的），或者歌名' } },
    output: text,
    async execute(args: { song?: string }) {
      const { library } = await rt();
      const want = String(args.song ?? '').trim();
      const songs = await library.list();
      const hit = songs.find((s) => s.id === want) ?? songs.find((s) => s.title === want) ?? songs.find((s) => s.title.includes(want) || want.includes(s.title));
      if (!hit) return `歌库里没有「${want}」。可以先用 singinglab_search 找、singinglab_learn 学。`;
      pushCommand({ type: 'play', songId: hit.id });
      return `在放《${hit.title}》。`;
    },
  }), 'singinglab_play');
}
