/** 播放器页面：歌库 ⇄ 正在播放。背景颜色跟着当前歌的封面走。 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { Backdrop } from './Backdrop';
import { getEngine } from './engine';
import { Library } from './Library';
import { NowPlaying } from './NowPlaying';
import { DEFAULT_PALETTE, extractPalette, type Palette } from './palette';

const paletteCache = new Map<string, Palette>();

function usePalette(id: string | null): Palette {
  const [palette, setPalette] = useState<Palette>(() => (id && paletteCache.get(id)) || DEFAULT_PALETTE);
  useEffect(() => {
    if (!id) return;
    const hit = paletteCache.get(id);
    if (hit) { setPalette(hit); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const p = extractPalette(img);
      paletteCache.set(id, p);
      if (alive) setPalette(p);
    };
    img.src = api.coverUrl(id);
    return () => { alive = false; };
  }, [id]);
  return palette;
}

export function App() {
  const engine = getEngine();
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  const [view, setView] = useState<'library' | 'now'>(() => (engine.state.current ? 'now' : 'library'));
  const palette = usePalette(s.current?.id ?? s.queue[s.index] ?? null);

  useEffect(() => { void engine.refresh(); }, [engine]);

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

  return (
    <div className={`sl-root sl-view-${view}`}>
      <Backdrop palette={palette} />
      <div className="sl-shade" />
      <div className="sl-views">
        <div className="sl-pane sl-pane-lib" aria-hidden={view !== 'library'}>
          <Library onOpenNow={() => setView('now')} />
        </div>
        <div className="sl-pane sl-pane-now" aria-hidden={view !== 'now'}>
          <NowPlaying palette={palette} onBack={() => setView('library')} />
        </div>
      </div>
    </div>
  );
}
