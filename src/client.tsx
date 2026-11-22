/**
 * dsh-singinglab 网页端：
 *   - 侧栏「唱歌」入口 → 播放器（ui/App.tsx）
 *   - 对话里 singinglab_* 工具的卡片：一行说她在干什么，加一个「去唱歌」按钮（切到播放器，不换会话）
 *   - 播放器引擎一进 DSH 就开始听：对话里说「放晴天」、学会一首歌，不打开唱歌页面也能放出来
 * 用到的是 DSH 网页端的公开服务：slots（main、sidebar.panellist、tool.call.toolview）、layout（selectPanel）。
 */

import React, { useState } from 'react';
import { App } from './ui/App';
import { getEngine } from './ui/engine';
import { CSS } from './ui/style';

export const PANEL_ID = 'dsh-singinglab';

export const inject = ['slots', 'layout'];

interface ClientContext {
  slots: { inject(name: string, callback: () => unknown): unknown; register(spec: any, component: any): () => void };
  layout: { selectPanel(id: string | null): void };
  effect(effect: () => () => void, label?: string): unknown;
}

function DiscIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M16.5 7.5a6.4 6.4 0 0 1 1.9 3.2" />
    </svg>
  );
}

const TOOLS = ['singinglab_status', 'singinglab_prepare', 'singinglab_import_voice', 'singinglab_search', 'singinglab_learn', 'singinglab_play'] as const;

/** 卡片标题：她在干什么（用参数说，不用工具名） */
function headline(tool: string, args: Record<string, unknown>, done: boolean): string {
  const s = (k: string) => String(args[k] ?? '').trim();
  switch (tool) {
    case 'singinglab_search': return `${done ? '找了' : '在找'}「${s('query')}」`;
    case 'singinglab_learn': return `${done ? '学' : '准备学'}《${s('title')}》`;
    case 'singinglab_play': return `放《${s('song')}》`;
    case 'singinglab_prepare': return done ? '一键准备学歌' : '在准备学歌…';
    case 'singinglab_import_voice': return done ? '导入她的声音' : '在导入她的声音…';
    default: return done ? '看了唱歌插件的状态' : '在看唱歌插件…';
  }
}

interface ToolViewProps {
  phase: 'preparing' | 'start' | 'result';
  toolName: string;
  block: { argsRaw?: string; call?: { argsRaw: string } | null; content?: readonly { type: string; text?: string }[]; isError?: boolean };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
}

function makeToolCard(open: () => void) {
  return function SingingToolCard(props: ToolViewProps) {
    const [more, setMore] = useState(false);
    const done = props.phase === 'result';
    const args = parseArgs(props.block.argsRaw ?? props.block.call?.argsRaw);
    const text = done ? (props.block.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim() : '';
    const lines = text.split('\n');
    // 放歌的结果本身就是一句话；其余的先给第一行，点开看全部
    const shown = more ? text : lines[0] ?? '';
    return (
      <div className={`sl-toolcard${props.block.isError ? ' is-error' : ''}`}>
        <span className="sl-toolcard-icon"><DiscIcon size={16} /></span>
        <div className="sl-toolcard-body">
          <div className="sl-toolcard-title">{headline(props.toolName, args, done)}{done ? null : <span className="sl-toolcard-dots" />}</div>
          {shown ? <div className="sl-toolcard-text">{shown}</div> : null}
          {lines.length > 1 ? <button className="sl-toolcard-more" onClick={() => setMore(!more)}>{more ? '收起' : '详细'}</button> : null}
        </div>
        <button className="sl-toolcard-go" onClick={open}>去唱歌</button>
      </div>
    );
  };
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-singinglab';
    tag.textContent = CSS;
    document.head.append(tag);
    return () => tag.remove();
  }, 'dsh-singinglab styles');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, App));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 3, label: () => '唱歌' }, DiscIcon));

  const Card = makeToolCard(() => ctx.layout.selectPanel(PANEL_ID));
  for (const tool of TOOLS) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: tool }, Card));

  // 播放器引擎常驻：在对话里让她放歌、学会了自动放，都不用先打开唱歌页面
  ctx.effect(() => { getEngine().startJobs(); return () => {}; }, 'dsh-singinglab player');
}
