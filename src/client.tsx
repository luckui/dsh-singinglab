/**
 * dsh-singinglab 网页端：侧栏「唱歌」入口 → 播放器（ui/App.tsx）。
 * 用到的是 DSH 网页端的公开服务 slots（main 区域、侧栏面板列表），照 dsh-livestream 的用法。
 */

import React from 'react';
import { App } from './ui/App';
import { CSS } from './ui/style';

export const PANEL_ID = 'dsh-singinglab';

export const inject = ['slots'];

interface ClientContext {
  slots: { inject(name: string, callback: () => unknown): unknown; register(spec: any, component: any): () => void };
  effect(effect: () => () => void, label?: string): unknown;
}

function DiscIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M16.5 7.5a6.4 6.4 0 0 1 1.9 3.2" />
    </svg>
  );
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
}
