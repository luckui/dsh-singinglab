/**
 * 学歌：右上角一颗小药丸（正在学哪首、学到哪一步、进度），点开是学歌列表（排队的可以取消，没学成的看原因）。
 * 屏幕底部上方的提示条：学会了、没学成。
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { api, type Job } from './api';
import { getEngine } from './engine';
import { Icon } from './icons';

export function LearnPill() {
  const engine = getEngine();
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  const [open, setOpen] = useState(false);
  const running = s.jobs.find((j) => j.state === 'running');
  const queued = s.jobs.filter((j) => j.state === 'queued');
  const recent = s.jobs.filter((j) => j.state === 'done' || j.state === 'failed').slice(-6).reverse();
  if (!running && !queued.length && !open) {
    return recent.length ? <button className="sl-pill sl-pill-quiet" onClick={() => setOpen(true)} title="学歌记录"><Icon name="note" size={16} /></button> : null;
  }
  return (
    <div className="sl-pill-wrap">
      <button className={`sl-pill ${running ? 'is-busy' : ''}`} onClick={() => setOpen((v) => !v)}>
        {running ? (
          <>
            <span className="sl-pill-fish"><Icon name="fish" size={16} /></span>
            <span className="sl-pill-text">正在学《{running.title}》 · {running.label}</span>
            <span className="sl-pill-bar"><i style={{ width: `${Math.round(running.progress * 100)}%` }} /></span>
            <span className="sl-pill-pct">{Math.round(running.progress * 100)}%</span>
          </>
        ) : <span className="sl-pill-text">{queued.length ? `${queued.length} 首在排队` : '学歌记录'}</span>}
        {queued.length && running ? <span className="sl-pill-more">+{queued.length}</span> : null}
      </button>
      {open ? (
        <div className="sl-learnlist">
          <div className="sl-learnlist-head">
            <span>学歌</span>
            <button className="sl-ctl sl-small" onClick={() => setOpen(false)} title="收起"><Icon name="close" size={16} /></button>
          </div>
          {[...(running ? [running] : []), ...queued, ...recent].map((j) => <JobRow key={j.id} job={j} />)}
          {!running && !queued.length && !recent.length ? <div className="sl-learnlist-empty">还没有学过歌</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const engine = getEngine();
  return (
    <div className={`sl-job is-${job.state}`}>
      <img className="sl-job-cover" src={api.coverUrl(job.id)} alt="" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
      <div className="sl-job-text">
        <div className="sl-job-title">{job.title}</div>
        <div className="sl-job-sub">
          {job.state === 'running' ? `${job.label} · ${Math.round(job.progress * 100)}%`
            : job.state === 'queued' ? '排队中'
            : job.state === 'done' ? '学会了'
            : `没学成：${job.reason ?? ''}`}
        </div>
        {job.state === 'running' ? <div className="sl-job-bar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div> : null}
      </div>
      {job.state === 'done'
        ? <button className="sl-ctl sl-small" title="播放" onClick={() => void engine.playSong(job.id)}><Icon name="play" size={16} /></button>
        : job.state === 'queued' || job.state === 'running'
          ? <button className="sl-ctl sl-small" title="取消" onClick={() => void engine.cancelJob(job.id)}><Icon name="close" size={16} /></button>
          : null}
    </div>
  );
}

export function Toast() {
  const engine = getEngine();
  const toast = useSyncExternalStore(engine.subscribe, () => engine.state.toast);
  const [shown, setShown] = useState(toast);
  useEffect(() => {
    if (!toast) return;
    setShown(toast);
    const t = window.setTimeout(() => setShown(null), 5200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!shown) return null;
  return (
    <div className="sl-toast" key={shown.id}>
      <Icon name="fish" size={16} />
      <span>{shown.text}</span>
      {shown.songId ? <button className="sl-toast-btn" onClick={() => { void engine.playSong(shown.songId!); setShown(null); }}>现在听</button> : null}
    </div>
  );
}
