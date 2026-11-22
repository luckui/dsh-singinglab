/** 播放器页面：歌库 ⇄ 正在播放。两页共用一张场景插画：播放页是清楚的画，歌库页是磨砂过的同一张画。 */

import React, { useEffect, useState } from 'react';
import { api } from './api';
import { getEngine } from './engine';
import { Library } from './Library';
import { NowPlaying } from './NowPlaying';
import type { SceneSpec } from './scene';

let sceneCache: SceneSpec | null = null;

function useScene(): SceneSpec | null {
  const [spec, setSpec] = useState<SceneSpec | null>(sceneCache);
  useEffect(() => {
    if (sceneCache) return;
    let alive = true;
    api.scene().then((s) => {
      sceneCache = s;
      if (alive) setSpec(s);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return spec;
}

export function App() {
  const engine = getEngine();
  const [view, setView] = useState<'library' | 'now'>(() => (engine.state.current ? 'now' : 'library'));
  const spec = useScene();

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

  const bg = spec ? api.assetUrl(spec.blurred ?? spec.image) : null;

  return (
    <div className={`sl-root sl-view-${view}`}>
      <div className="sl-libbg" aria-hidden style={bg ? { backgroundImage: `url(${bg})` } : undefined} />
      <div className="sl-views">
        <div className="sl-pane sl-pane-lib" aria-hidden={view !== 'library'}>
          <Library onOpenNow={() => setView('now')} heroImage={spec ? api.assetUrl(spec.image) : null} />
        </div>
        <div className="sl-pane sl-pane-now" aria-hidden={view !== 'now'}>
          <NowPlaying spec={spec} onBack={() => setView('library')} />
        </div>
      </div>
    </div>
  );
}
