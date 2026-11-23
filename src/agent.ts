/**
 * 唱歌工具：挂在根上（cordis.patch.yml），用户平时的每个会话、任何模式都能用；插件不带预设、不带人设。
 * 用户在对话里说「我想听晴天」「帮我把学歌装好」，就用这些工具办完：
 *   singinglab_status          学歌准备好了没有、缺什么、歌库有几首、正在学什么
 *   singinglab_prepare         一键准备（装环境、下模型），后台进行
 *   singinglab_import_voice    导入一个 RVC 声音模型（电脑上的 .pth 路径）
 *   singinglab_search          在歌库和 B 站上找歌
 *   singinglab_learn           学一首（B 站视频），在后台学；学会了播放器会自动放，
 *                              学完（或没学成）往让学的那个会话里补一条消息叫醒她（像后台任务的完成通知）
 *   singinglab_play            在播放器里放歌库里的一首
 *   singinglab_pitch           修音：看一首歌她要唱的音高（每句一行；带 start/end 就是每个音一行）
 *   singinglab_pitch_edit      修音：改音高（升降、八度、对准、拉直、恢复）、整首移调；改完重新唱整首（约 20 秒）
 *   singinglab_pitch_undo      修音：撤销最近几步
 * 修音怎么判断、怎么改，写在技能 singinglab-pitch 里（用到才读）；改动和修音页是同一份，修音页里能看到、能撤销。
 */

import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { guessTitle, parseVideoRef } from './bili';
import type { Job } from './learner';
import { detail, overview, toOp, type PitchChange } from './pitchdesk';
import { pushCommand, runtime, started } from './runtime';
import { PITCH_SKILL } from './pitchskill';

export const name = 'dsh-singinglab-agent';
export const inject = ['tools'];

interface LiveAgent { followup(message: unknown): void | Promise<void> }

interface SkillRegistry { register(skill: { name: string; description: string; whenToUse?: string; source: string; content: string }): () => void }

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  tools: { register(tool: unknown): () => void };
  get?(name: string): any;
}

const text = { schema: { type: 'string' as const }, render: (_a: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function rt() {
  await runtime.ready;
  if (!runtime.studio || !runtime.learner || !runtime.library || !runtime.bili) throw new Error('唱歌插件还没启动好');
  return { studio: runtime.studio, learner: runtime.learner, library: runtime.library, bili: runtime.bili };
}

/** 学完一首：往让学的那个会话里补一条消息并叫醒她。会话不在了（关了、DSH 重启过）就不说，她下次查状态能看到 */
function tellSession(ctx: AgentContext, job: Job): void {
  if (!job.session || job.reason === '取消了') return;
  const agents = ctx.get?.('agents') as { get?(id: string): LiveAgent | undefined } | undefined;
  const agent = agents?.get?.(job.session);
  if (!agent?.followup) {
    console.warn(`[dsh-singinglab] 学完没能告诉会话 ${job.session}：${agents ? '会话不在线' : '拿不到 agents 服务'}`);
    return;
  }
  const took = job.startedAt && job.endedAt ? `（用时 ${clock((job.endedAt - job.startedAt) / 1000)}）` : '';
  const text = job.state === 'done'
    ? `[唱歌插件] 《${job.title}》学会了${took}，播放器会自动放（正在放别的就排在下一首）。`
    : `[唱歌插件] 《${job.title}》没学成：${job.reason ?? '原因不明'}`;
  // 和 DSH 自己的用户消息一样：带 id 和 role，冻结
  void agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-singinglab' } }));
}

export function apply(ctx: AgentContext): void {
  const reg = (tool: unknown, label: string) => ctx.effect(() => ctx.tools.register(tool), label);

  ctx.effect(() => {
    let off = (): void => {};
    let disposed = false;
    void started.then(() => {
      const learner = runtime.learner;
      if (disposed || !learner) return;
      const listener = (job: Job) => tellSession(ctx, job);
      learner.ended.add(listener);
      off = () => { learner.ended.delete(listener); };
    }).catch(() => { /* 插件没起来就不通知 */ });
    return () => { disposed = true; off(); };
  }, 'singinglab: tell the session when a song is learned');

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
      // 最近结束的几首：学会了还是没学成（没学成要说原因，她才能告诉用户、决定重学）
      const ended = learner.jobs.filter((j) => j.state === 'done' || j.state === 'failed').slice(-3);
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
        ended.length ? `最近学的：${ended.map((j) => `《${j.title}》${j.state === 'done' ? '学会了' : `没学成（${j.reason ?? '原因不明'}）`}`).join('；')}` : '',
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
        `${mine.length ? `她会唱 ${mine.length} 首` : '她还不会唱'}；B 站上${hits.length ? `找到 ${Math.min(hits.length, 8)} 个` : '没找到'}。`,
        mine.length ? `她已经会唱：\n${mine.map((s) => `- 《${s.title}》${s.artist ? ` ${s.artist}` : ''}（歌库 id：${s.id}）`).join('\n')}` : '她还不会唱这首。',
        hits.length ? `B 站上：\n${hits.slice(0, 8).map((h) => `- ${h.bvid}  ${h.title}  · ${h.up} · ${clock(h.durationSec)}${h.views ? ` · ${h.views} 播放` : ''}  （猜的歌名：${guessTitle(h.title, q)}）`).join('\n')}` : 'B 站上没搜到（或者搜索暂时用不了）。',
      ].join('\n\n');
    },
  }), 'singinglab_search');

  reg(defineTool({
    name: 'singinglab_learn',
    description: '让她学一首歌（B 站视频）：在用户电脑上分离人声、换成她的声音，一首大约 3 分钟（看显卡）。在后台学，学会了播放器会自动放（正在放别的就排到下一首），不用等它学完：告诉用户大概几分钟后会放，这一轮就可以结束。学完（或没学成）会在这个会话里收到一条「[唱歌插件]」消息。歌名要准（对歌词要用）。',
    parameters: {
      bvid: { type: 'string', required: true, description: 'BV 号或视频链接' },
      title: { type: 'string', required: true, description: '歌名（干净的歌名，不要「MV」「高音质」这些）' },
      artist: { type: 'string', description: '原唱歌手（知道就填，对歌词更准）' },
      page: { type: 'number', description: '分 P（默认第 1 个）' },
      relearn: { type: 'boolean', description: '已经会唱也重学一遍（以前学的歌没留修音要用的分轨，要修音得先重学；旧的那版学成之前一直在）' },
    },
    output: text,
    async execute(args: { bvid?: string; title?: string; artist?: string; page?: number; relearn?: boolean }, exec?: { agent?: { id: string } }) {
      const { studio, learner } = await rt();
      const ref = parseVideoRef(String(args.bvid ?? ''));
      if (!ref) return '没认出 BV 号。';
      const lack = await studio.check();
      if (lack) return `${lack}\n可以先调 singinglab_prepare。`;
      const job = learner.learn({ bvid: ref.bvid, page: args.page ?? ref.page, title: String(args.title ?? ''), artist: args.artist, autoplay: !args.relearn, ...(args.relearn ? { relearn: true } : {}), ...(exec?.agent?.id ? { session: exec.agent.id } : {}) });
      return job.state === 'queued' && learner.jobs.some((j) => j.state === 'running' && j.id !== job.id)
        ? `排上了《${job.title}》，前面还有歌在学。在后台学，学会了会自动放，学完会告诉你，不用等。`
        : `开始学《${job.title}》，在后台学，大约 3 分钟，学会了会自动放，学完会告诉你，不用等。`;
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

  // ── 修音 ──
  const findSong = async (want: string) => {
    const { library } = await rt();
    const w = want.trim();
    const songs = await library.list();
    return songs.find((s) => s.id === w) ?? songs.find((s) => s.title === w) ?? songs.find((s) => s.title.includes(w) || w.includes(s.title)) ?? null;
  };
  const pitch = async (want: string) => {
    await runtime.ready;
    if (!runtime.pitch) throw new Error('唱歌插件还没启动好');
    const hit = await findSong(want);
    if (!hit) throw new Error(`歌库里没有「${want}」`);
    return { id: hit.id, doc: await runtime.pitch.open(hit.id), svc: runtime.pitch };
  };
  const songParam = { type: 'string' as const, required: true as const, description: '歌库 id 或歌名' };

  reg(defineTool({
    name: 'singinglab_pitch',
    description: '修音：看一首歌她要唱的音高。不带时间：整首每句歌词一行——时间、唱到哪些音（她实际唱的音，算上了移调）、沙不沙（按她的声音实测）、出没出音域、自动修正改过哪里、改过哪里、这句是第几次出现、在响的段（多半是副歌）还是轻的段。带 start/end（秒）：这一段每个音一行，和原来测到的差多少、比前一个音跳了多少。用户说哪里唱得哑、跑调、高音破了、某句不对，先用这个找到是哪几个音。怎么判断、怎么改见技能 singinglab-pitch。',
    parameters: {
      song: songParam,
      start: { type: 'number', description: '从第几秒（看一段时带上）' },
      end: { type: 'number', description: '到第几秒' },
    },
    output: text,
    async execute(args: { song?: string; start?: number; end?: number }) {
      try {
        const { doc } = await pitch(String(args.song ?? ''));
        return typeof args.start === 'number' && typeof args.end === 'number' && args.end > args.start ? detail(doc, args.start, args.end) : overview(doc);
      } catch (err) {
        return (err as Error).message;
      }
    },
  }), 'singinglab_pitch');

  reg(defineTool({
    name: 'singinglab_pitch_edit',
    description: '修音：改一首歌她要唱的音高，改完整首重新唱、重新混音（约 20 秒），播放器里换成新的；修音页开着也会刷新。一次可以改好几处。改法（start/end 是秒）：shift 升降 semitones 个半音（12 = 一个八度，可以带小数）；snap 每个音对准最近的半音（颤音留着）；tune 对准 center%（0–100）、把音里的起伏拉直 flatten%（0–100，太多会像机器）；reset 恢复成自动修正的结果；use_measured 用原来测到的音（不要自动修正）。key 是整首升降几个半音（伴奏跟着移），不改就不填。改动和修音页是同一份记录，用户在修音页里能看到、能撤销。',
    parameters: {
      song: songParam,
      changes: {
        type: 'array',
        description: '这一次的改动，按顺序做',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start: { type: 'number', required: true, description: '从第几秒' },
            end: { type: 'number', required: true, description: '到第几秒' },
            action: { type: 'string', required: true, enum: ['shift', 'snap', 'tune', 'reset', 'use_measured'], description: '怎么改' },
            semitones: { type: 'number', description: 'shift 用：升几个半音（负数是降）' },
            center: { type: 'number', description: 'tune 用：往半音对准多少（0–100，默认 100）' },
            flatten: { type: 'number', description: 'tune 用：起伏拉直多少（0–100，默认 0）' },
          },
        },
      },
      key: { type: 'number', description: '整首升降几个半音（她唱的调）；不改就不填' },
    },
    output: text,
    async execute(args: { song?: string; changes?: PitchChange[]; key?: number }) {
      try {
        const { id, doc, svc } = await pitch(String(args.song ?? ''));
        const changes = Array.isArray(args.changes) ? args.changes : [];
        if (!changes.length && typeof args.key !== 'number') return '没说要改什么。';
        const added = changes.map((c) => toOp(c, doc.raw.length));
        const key = typeof args.key === 'number' ? Math.round(args.key) : doc.state.key;
        const { sec } = await svc.save(id, [...doc.state.ops, ...added], key);
        const after = await svc.open(id);
        const parts = changes.map((c) => detail(after, Math.max(0, c.start - 0.3), c.end + 0.3).split('\n').slice(0, -1).join('\n'));
        return [
          `改好了，整首重新唱完（${sec} 秒），播放器里已经是新的。${typeof args.key === 'number' && key !== doc.state.key ? `调从${doc.state.key >= 0 ? '升' : '降'} ${Math.abs(doc.state.key)} 换成${key >= 0 ? '升' : '降'} ${Math.abs(key)}。` : ''}`,
          ...parts,
          `这首现在一共 ${after.state.ops.length} 步改动；singinglab_pitch_undo 能撤销，修音页里也能看、能撤销。`,
          `歌库 id：${id}`,
        ].join('\n');
      } catch (err) {
        return `没改成：${(err as Error).message}`;
      }
    },
  }), 'singinglab_pitch_edit');

  reg(defineTool({
    name: 'singinglab_pitch_undo',
    description: '修音：撤销一首歌最近几步改动（不管是用户在修音页改的还是你改的），撤完重新唱整首（约 20 秒）。',
    parameters: { song: songParam, steps: { type: 'number', description: '撤几步（默认 1）' } },
    output: text,
    async execute(args: { song?: string; steps?: number }) {
      try {
        const { id, doc, svc } = await pitch(String(args.song ?? ''));
        const n = Math.max(1, Math.min(doc.state.ops.length, Math.round(args.steps ?? 1)));
        if (!doc.state.ops.length) return '这首没有改动可以撤销。';
        const { sec } = await svc.save(id, doc.state.ops.slice(0, -n), doc.state.key);
        return `撤销了 ${n} 步，重新唱完（${sec} 秒）。还剩 ${doc.state.ops.length - n} 步改动。\n歌库 id：${id}`;
      } catch (err) {
        return `没撤成：${(err as Error).message}`;
      }
    },
  }), 'singinglab_pitch_undo');

  // 修音的经验：写成一份技能，用到才读，不占平时的提示词
  ctx.effect(() => {
    const skills = ctx.get?.('skills') as SkillRegistry | undefined;
    if (!skills?.register) return () => {};
    return skills.register(PITCH_SKILL);
  }, 'singinglab: pitch skill');
}
