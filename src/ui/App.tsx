/** 播放器页面：歌库 ⇄ 正在播放。两页共用一张场景插画：播放页是清楚的画，歌库页是磨砂过的同一张画。 */

import React, { useEffect, useState } from 'react';
import { api } from './api';
import { getEngine } from './engine';
import { LearnPill, Toast } from './Learning';
import { Library } from './Library';
import { NowPlaying } from './NowPlaying';
import type { SceneSpec, Theme } from './scene';

const sceneCache = new Map<Theme, SceneSpec>();

function useScene(theme: Theme): SceneSpec | null {
  const [spec, setSpec] = useState<SceneSpec | null>(sceneCache.get(theme) ?? null);
  useEffect(() => {
    const hit = sceneCache.get(theme);
    if (hit) { setSpec(hit); return; }
    let alive = true;
    api.scene(theme).then((s) => {
      sceneCache.set(theme, s);
      if (alive) setSpec(s);
    }).catch(() => {});
    return () => { alive = false; };
  }, [theme]);
  return spec;
}

export type ThemePref = 'auto' | Theme;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem('dsh-singinglab.theme');
    return v === 'day' || v === 'night' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** 主题：默认跟着系统的深色 / 浅色走，也可以手动定成白天或雨夜 */
function useTheme(): [Theme, ThemePref, () => void] {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const query = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
  const [dark, setDark] = useState(!!query?.matches);
  useEffect(() => {
    if (!query) return;
    const on = () => setDark(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, [query]);
  const cycle = () => {
    const order: ThemePref[] = ['auto', 'day', 'night'];
    const next = order[(order.indexOf(pref) + 1) % order.length];
    setPref(next);
    try { localStorage.setItem('dsh-singinglab.theme', next); } catch { /* 存不了就算了 */ }
  };
  return [pref === 'auto' ? (dark ? 'night' : 'day') : pref, pref, cycle];
}

export function App() {
  const engine = getEngine();
  const [view, setView] = useState<'library' | 'now'>(() => (engine.state.current ? 'now' : 'library'));
  const [theme, pref, cycleTheme] = useTheme();
  const spec = useScene(theme);

  useEffect(() => { void engine.refresh(); engine.startJobs(); }, [engine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!document.querySelector('.sl-root')) return;
      if (e.code === 'Space') { e.preventDefault(); engine.toggle(); }
      else if (e.code === 'ArrowRight' && view === 'now') engine.seek(engine.time + 5);
      else if (e.code === 'ArrowLeft' && view === 'now') engine.seek(engine.time - 5);
      else if (e.code === 'Escape' && view === 'now') setView('library');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, view]);

  const bg = spec ? api.assetUrl(spec.blurred ?? spec.image) : null;

  return (
    <div className={`sl-root sl-view-${view} sl-theme-${theme}`}>
      <div className="sl-libbg" aria-hidden style={bg ? { backgroundImage: `url(${bg})` } : undefined} />
      <div className="sl-views">
        <div className="sl-pane sl-pane-lib" aria-hidden={view !== 'library'}>
          <Library onOpenNow={() => setView('now')} heroImage={spec ? api.assetUrl(spec.image) : null} />
        </div>
        <div className="sl-pane sl-pane-now" aria-hidden={view !== 'now'}>
          <NowPlaying spec={spec} onBack={() => setView('library')} theme={pref} onTheme={cycleTheme} />
        </div>
      </div>
      <div className="sl-overlay">
        <LearnPill />
      </div>
      <Toast />
    </div>
  );
}
