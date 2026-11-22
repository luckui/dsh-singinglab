/** 歌库：搜索、排序、封面网格；底下一条迷你播放条，点它回到正在播放。 */

import React, { useDeferredValue, useMemo, useState, useSyncExternalStore } from 'react';
import { api, type Hit, type SongSummary } from './api';
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
  const [bili, setBili] = useState<{ q: string; hits: Hit[] | null; error?: string } | null>(null);
  const [picking, setPicking] = useState<Hit | null>(null);
  const searchBili = async (text = query) => {
    const t = text.trim();
    if (!t) return;
    setBili({ q: t, hits: null });
    try {
      setBili({ q: t, hits: await api.search(t) });
    } catch (err) {
      setBili({ q: t, hits: [], error: (err as Error).message });
    }
  };
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
          <button className="sl-btn sl-studio-btn" onClick={() => engine.openStudio()} title="学歌设置：环境、她的声音、配方">
            <Icon name="gear" size={16} /> 学歌设置{s.learnMissing ? <span className="sl-badge" /> : null}
          </button>
          <label className="sl-search">
            <Icon name="search" size={18} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void searchBili(); }} placeholder="找歌，回车也去 B 站找" />
          </label>
          <div className="sl-seg" role="tablist">
            <button className={sort === 'recent' ? 'is-on' : ''} onClick={() => setSort('recent')}>最近学会</button>
            <button className={sort === 'title' ? 'is-on' : ''} onClick={() => setSort('title')}>按歌名</button>
          </div>
        </div>
      </header>

      {s.error && !s.songs.length ? <div className="sl-empty">{s.error}</div> : null}
      {!s.error && !s.songs.length ? <div className="sl-empty">歌库还是空的</div> : null}
      {q ? (
        <div className="sl-bili-bar">
          <span>{shown.length ? `她会唱的里有 ${shown.length} 首` : `她还不会唱「${query}」`}</span>
          <button className="sl-btn sl-btn-primary" onClick={() => void searchBili()}><Icon name="search" size={16} /> 去 B 站找「{query.trim()}」让她学</button>
        </div>
      ) : null}
      {bili ? <BiliResults result={bili} onClose={() => setBili(null)} onPick={setPicking} /> : null}

      <div className="sl-grid">
        {shown.map((song) => (
          <Card key={song.id} song={song} active={song.id === currentId} playing={song.id === currentId && s.playing} onPlay={() => play(song)} />
        ))}
      </div>
      <div className="sl-lib-pad" />
      </div>
      <MiniBar onOpen={onOpenNow} />
      {picking ? <LearnConfirm hit={picking} onClose={() => setPicking(null)} /> : null}
    </div>
  );
}

/** 确认歌名（对歌词要用），再开始学 */
function LearnConfirm({ hit, onClose }: { hit: Hit; onClose: () => void }) {
  const engine = getEngine();
  const [title, setTitle] = useState(hit.guess);
  const [artist, setArtist] = useState('');
  return (
    <div className="sl-modal" onClick={onClose}>
      <div className="sl-modal-card" onClick={(e) => e.stopPropagation()}>
        <img className="sl-modal-cover" src={api.imgUrl(hit.cover)} alt="" />
        <div className="sl-modal-title">让她学这首</div>
        <div className="sl-modal-sub">{hit.title} · {hit.up}</div>
        <label className="sl-field"><span>歌名</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="对歌词要用，写准一点" autoFocus /></label>
        <label className="sl-field"><span>歌手</span><input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="可以不填" /></label>
        <div className="sl-modal-actions">
          <button className="sl-btn" onClick={onClose}>算了</button>
          <button className="sl-btn sl-btn-primary" disabled={!title.trim()} onClick={() => { void engine.learn({ bvid: hit.bvid, page: hit.page, title: title.trim(), artist: artist.trim() }); onClose(); }}>
            开始学（学会了就唱给你听）
          </button>
        </div>
      </div>
    </div>
  );
}

/** B 站搜出来的视频：点「学这首」先确认歌名（对歌词要用），再开始学 */
function BiliResults({ result, onClose, onPick }: { result: { q: string; hits: Hit[] | null; error?: string }; onClose: () => void; onPick: (h: Hit) => void }) {
  const engine = getEngine();
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  const learned = new Set(s.songs.map((x) => x.id));
  const learning = new Set(s.jobs.filter((j) => j.state === 'queued' || j.state === 'running').map((j) => j.id));
  const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const views = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : String(n));
  return (
    <section className="sl-bili">
      <div className="sl-bili-head">
        <div className="sl-lib-title">B 站上的「{result.q}」</div>
        <button className="sl-ctl sl-small" onClick={onClose} title="收起"><Icon name="close" size={18} /></button>
      </div>
      {s.learnMissing ? <div className="sl-bili-warn">学歌还没设置好：{s.learnMissing}</div> : null}
      {result.hits === null ? <div className="sl-empty">在 B 站找……</div> : null}
      {result.error ? <div className="sl-empty">{result.error}</div> : null}
      {result.hits && !result.hits.length && !result.error ? <div className="sl-empty">B 站上也没搜到</div> : null}
      <div className="sl-grid">
        {(result.hits ?? []).map((h) => {
          const id = `${h.bvid}-p${h.page}`;
          const state = learned.has(id) ? 'learned' : learning.has(id) ? 'learning' : '';
          return (
            <div key={id} className="sl-card-item sl-hit">
              <div className="sl-card-cover">
                <img src={api.imgUrl(h.cover)} alt="" loading="lazy" />
                <span className="sl-card-tag">{fmt(h.durationSec)}{h.views ? ` · ${views(h.views)}播放` : ''}</span>
              </div>
              <div className="sl-card-title" title={h.title}>{h.title}</div>
              <div className="sl-card-sub">{h.up}</div>
              {state === 'learned'
                ? <button className="sl-btn sl-hit-btn" onClick={() => void engine.playSong(id)}><Icon name="play" size={15} /> 她会唱，听听</button>
                : state === 'learning'
                  ? <button className="sl-btn sl-hit-btn" disabled>正在学……</button>
                  : <button className="sl-btn sl-btn-primary sl-hit-btn" onClick={() => onPick(h)}><Icon name="note" size={15} /> 学这首</button>}
            </div>
          );
        })}
      </div>
    </section>
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
