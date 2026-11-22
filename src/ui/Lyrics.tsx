/**
 * 歌词：当前行在视线上方三分之一处，逐字填亮；前后行变淡、越远越糊。
 * 换行时每一行依次滑过去（后面的行晚一点出发），像一串有弹性的珠子。
 * 两句之间空了 5 秒以上，中间放三个呼吸的点，按间奏的进度一个个亮起来。
 * 每帧只改样式，不让 React 重新渲染。
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { getEngine } from './engine';
import type { LyricLine, SongDetail } from './api';

const GAP_SEC = 5;

interface Item {
  kind: 'line' | 'gap';
  start: number;
  end: number;
  line?: LyricLine;
}

function buildItems(lines: LyricLine[]): Item[] {
  const items: Item[] = [];
  let prevEnd = 0;
  lines.forEach((line, i) => {
    const start = line.start;
    if (start - prevEnd >= GAP_SEC) items.push({ kind: 'gap', start: prevEnd + (i === 0 ? 0.5 : 0.3), end: start - 0.25 });
    const next = lines[i + 1]?.start ?? Infinity;
    const end = Math.max(line.end ?? start + 2, start + 0.3);
    items.push({ kind: 'line', start, end: Math.min(end, next), line });
    prevEnd = Math.min(end, next);
  });
  return items;
}

/** 当前该亮的一项：最后一个已经开始的 */
function currentIndex(items: Item[], t: number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (items[m].start <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

interface Props { song: SongDetail | null; variant?: 'stage' | 'glass' }

export function Lyrics({ song, variant = 'stage' }: Props) {
  const cls = `sl-lyrics is-${variant}`;
  const items = useMemo(() => buildItems(song?.lyrics ?? []), [song]);
  const box = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const words = useRef<(HTMLSpanElement | null)[][]>([]);

  useEffect(() => {
    const el = box.current;
    if (!el || !items.length) return;
    const engine = getEngine();
    let tops: number[] = [];
    let heights: number[] = [];
    let cur = -2;
    let manual = 0;
    let manualAt = 0;
    let raf = 0;

    const measure = () => {
      tops = rows.current.map((r) => r?.offsetTop ?? 0);
      heights = rows.current.map((r) => r?.offsetHeight ?? 0);
      cur = -2; // 下一帧重新排位置
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    const place = (index: number, instant: boolean) => {
      const anchor = el.clientHeight * (variant === 'glass' ? 0.4 : 0.34);
      const focus = Math.max(0, index);
      const shift = anchor - (tops[focus] ?? 0) - (heights[focus] ?? 0) / 2 + manual;
      rows.current.forEach((row, i) => {
        if (!row) return;
        const d = i - focus;
        const dist = Math.abs(d);
        const delay = instant || manual ? 0 : d >= 0 ? Math.min(d, 8) * 45 : 0;
        row.style.transitionDelay = `${delay}ms`;
        row.style.transitionDuration = instant ? '0ms' : '';
        row.style.transform = `translate3d(0, ${shift}px, 0) scale(${i === index ? 1 : 0.94})`;
        row.style.opacity = String(i === index ? 1 : dist > 7 ? 0 : Math.max(0.16, 0.5 - dist * 0.06));
        row.style.filter = i === index ? '' : manual ? 'none' : `blur(${Math.min(dist * 0.7, 3.2).toFixed(1)}px)`;
        row.classList.toggle('is-current', i === index);
        row.classList.toggle('is-past', i < index);
      });
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      manual -= e.deltaY;
      manualAt = performance.now();
      place(cur, true);
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const t = engine.time;
      const index = currentIndex(items, t);
      if (manual && now - manualAt > 2600) {
        manual = 0;
        cur = -2;
      }
      if (index !== cur) {
        const jump = cur === -2 || Math.abs(index - cur) > 3;
        cur = index;
        place(index, jump && engine.state.playing === false);
      }
      // 当前一行逐字填色
      const item = items[index];
      if (!item) return;
      if (item.kind === 'gap') {
        const row = rows.current[index];
        const p = Math.min(1, Math.max(0, (t - item.start) / Math.max(0.1, item.end - item.start)));
        row?.style.setProperty('--p', p.toFixed(3));
        return;
      }
      const spans = words.current[index] ?? [];
      const line = item.line!;
      const at = line.at && line.at.length === spans.length ? line.at : null;
      spans.forEach((span, k) => {
        if (!span) return;
        let p: number;
        if (at) {
          const a = at[k];
          const b = at[k + 1] ?? item.end;
          p = (t - a) / Math.max(0.08, b - a);
        } else {
          p = (t - item.start) / Math.max(0.2, item.end - item.start);
        }
        span.style.setProperty('--p', `${(Math.min(1, Math.max(0, p)) * 100).toFixed(1)}%`);
      });
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, [items, variant]);

  if (!song) return <div className={`${cls} sl-lyrics-empty`} />;
  if (!items.length) {
    return (
      <div className={`${cls} sl-lyrics-empty`}>
        <div className="sl-nolyrics">
          <div className="sl-nolyrics-title">{song.title}</div>
          <div className="sl-nolyrics-sub">这首还没有歌词，安静听她唱吧</div>
        </div>
      </div>
    );
  }

  rows.current = [];
  words.current = [];
  return (
    <div className={cls} ref={box}>
      <div className="sl-lyrics-track">
        {items.map((item, i) => {
          if (item.kind === 'gap') {
            return (
              <div key={`g${i}`} className="sl-line sl-gap" ref={(r) => { rows.current[i] = r; }}>
                <span /><span /><span />
              </div>
            );
          }
          const line = item.line!;
          const tokens = line.tokens && line.tokens.length ? line.tokens : [line.text];
          words.current[i] = [];
          return (
            <div
              key={`l${i}`}
              className="sl-line"
              ref={(r) => { rows.current[i] = r; }}
              onClick={() => getEngine().seek(line.start)}
            >
              {tokens.map((tok, k) => (
                <span key={k} className="sl-word" ref={(r) => { (words.current[i] ??= [])[k] = r; }}>{tok}</span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
