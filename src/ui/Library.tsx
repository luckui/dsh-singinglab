/** 歌库：搜索、排序、封面网格；底下一条迷你播放条，点它回到正在播放。 */

import React, { useDeferredValue, useMemo, useState, useSyncExternalStore } from 'react';
import { api, type SongSummary } from './api';
import { getEngine } from './engine';
import { Icon } from './icons';

type Sort = 'recent' | 'title';

const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true });

export function Library({ onOpenNow, heroImage }: { onOpenNow: () => void; heroImage: string | null }) {
  const engine = getEngine();
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const q = useDeferredValue(query.trim().toLowerCase());

  const shown = useMemo(() => {
    const list = q
      ? s.songs.filter((x) => `${x.title} ${x.artist} ${x.who}`.toLowerCase().includes(q))
      : s.songs.slice();
    if (sort === 'title') list.sort((a, b) => collator.compare(a.title, b.title));
    return list;
  }, [s.songs, q, sort]);

  const currentId = s.current?.id ?? s.queue[s.index];
  const play = (song: SongSummary) => {
    if (song.id === currentId) {
      onOpenNow();
      if (!s.playing) engine.toggle();
      return;
    }
    void engine.playSong(song.id, shown.map((x) => x.id));
    onOpenNow();
  };

  return (
    <div className="sl-library">
      <div className="sl-lib-scroll">
      <section className="sl-hero" style={heroImage ? { backgroundImage: `url(${heroImage})` } : undefined}>
        <div className="sl-hero-text">
          <div className="sl-hero-kicker"><Icon name="fish" size={16} /> 大肥鱼的唱片架</div>
          <div className="sl-hero-title">今天想听她唱什么？</div>
          <div className="sl-hero-sub">她已经学会了 {s.songs.length} 首歌</div>
          <div className="sl-hero-actions">
            <button className="sl-btn sl-btn-primary" onClick={() => { if (s.current) { if (!s.playing) engine.toggle(); onOpenNow(); } else if (shown[0]) play(shown[0]); }}>
              <Icon name="play" size={18} /> {s.current ? '继续播放' : '开始播放'}
            </button>
            <button className="sl-btn" onClick={() => {
              const pick = shown[Math.floor(Math.random() * shown.length)];
              if (!pick) return;
              if (!s.shuffle) engine.toggleShuffle();
              void engine.playSong(pick.id, shown.map((x) => x.id));
              onOpenNow();
            }}>
              <Icon name="shuffle" size={18} /> 随机播放
            </button>
          </div>
        </div>
      </section>
      <header className="sl-lib-head">
        <div className="sl-lib-title">全部歌曲</div>
        <div className="sl-lib-tools">
          <label className="sl-search">
            <Icon name="search" size={18} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="找歌名、歌手、UP 主" />
          </label>
          <div className="sl-seg" role="tablist">
            <button className={sort === 'recent' ? 'is-on' : ''} onClick={() => setSort('recent')}>最近学会</button>
            <button className={sort === 'title' ? 'is-on' : ''} onClick={() => setSort('title')}>按歌名</button>
          </div>
        </div>
      </header>

      {s.error && !s.songs.length ? <div className="sl-empty">{s.error}</div> : null}
      {!s.error && !s.songs.length ? <div className="sl-empty">歌库还是空的</div> : null}
      {q && !shown.length ? <div className="sl-empty">没找到「{query}」</div> : null}

      <div className="sl-grid">
        {shown.map((song) => (
          <Card key={song.id} song={song} active={song.id === currentId} playing={song.id === currentId && s.playing} onPlay={() => play(song)} />
        ))}
      </div>
      <div className="sl-lib-pad" />
      </div>
      <MiniBar onOpen={onOpenNow} />
    </div>
  );
}

function Card({ song, active, playing, onPlay }: { song: SongSummary; active: boolean; playing: boolean; onPlay: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button className={`sl-card-item ${active ? 'is-active' : ''}`} onClick={onPlay} title={`${song.title} — ${song.artist}`}>
      <div className="sl-card-cover">
        {broken
          ? <div className="sl-card-blank"><Icon name="note" size={30} /></div>
          : <img src={api.coverUrl(song.id)} alt="" loading="lazy" onError={() => setBroken(true)} />}
        <span className="sl-card-play">{playing ? <Eq /> : <Icon name="play" size={20} />}</span>
        {!song.hasLyrics ? <span className="sl-card-tag">无歌词</span> : null}
      </div>
      <div className="sl-card-title">{song.title}</div>
      <div className="sl-card-sub">{song.artist || song.who || ' '}</div>
    </button>
  );
}

function Eq() {
  return <span className="sl-eq"><i /><i /><i /></span>;
}

function MiniBar({ onOpen }: { onOpen: () => void }) {
  const engine = getEngine();
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  if (!s.current) return null;
  return (
    <div className="sl-mini" onClick={onOpen}>
      <img className="sl-mini-cover" src={api.coverUrl(s.current.id)} alt="" />
      <div className="sl-mini-text">
        <div className="sl-mini-title">{s.current.title}</div>
        <div className="sl-mini-sub">{s.current.artist}</div>
      </div>
      <button className="sl-ctl" onClick={(e) => { e.stopPropagation(); engine.step(-1); }} title="上一首"><Icon name="prev" /></button>
      <button className="sl-ctl sl-play sl-play-sm" onClick={(e) => { e.stopPropagation(); engine.toggle(); }} title={s.playing ? '暂停' : '播放'}>
        <Icon name={s.playing ? 'pause' : 'play'} />
      </button>
      <button className="sl-ctl" onClick={(e) => { e.stopPropagation(); engine.step(1); }} title="下一首"><Icon name="next" /></button>
    </div>
  );
}
