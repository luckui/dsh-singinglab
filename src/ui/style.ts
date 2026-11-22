/** 播放器的样式。挂在 <style data-plugin="dsh-singinglab">，所有类名都以 sl- 开头，不碰 DSH 自己的样式。 */

const NOISE = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

export const CSS = `
.sl-root {
  --accent: rgb(120, 200, 255);
  --ease: cubic-bezier(.22, 1, .36, 1);
  position: relative; height: 100%; width: 100%; overflow: hidden; isolation: isolate;
  color: #fff; background: #0b1020;
  font-family: "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; container-type: inline-size;
}
:where(.sl-root) button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
/* DSH 全局给圆角用了 superellipse（方圆），唱片、按钮要正圆 */
.sl-root, .sl-root *, .sl-root *::before, .sl-root *::after { box-sizing: border-box; corner-shape: round; }

/* 背景 */
.sl-backdrop { position: absolute; inset: 0; z-index: -2; overflow: hidden; }
.sl-backdrop canvas { position: absolute; inset: -12%; width: 124%; height: 124%; filter: blur(42px) saturate(1.25); }
.sl-grain { position: absolute; inset: 0; background-image: ${NOISE}; opacity: .07; mix-blend-mode: overlay; }
.sl-shade { position: absolute; inset: 0; z-index: -1; pointer-events: none; transition: background .6s var(--ease);
  background: radial-gradient(120% 90% at 30% 40%, rgba(0,0,0,0) 0%, rgba(0,0,0,.28) 70%, rgba(0,0,0,.45) 100%); }
.sl-view-library .sl-shade { background: linear-gradient(180deg, rgba(6,10,22,.35), rgba(6,10,22,.62)); }

/* 两个视图叠在一起，切换时上下滑 */
.sl-views { position: absolute; inset: 0; }
.sl-pane { position: absolute; inset: 0; transition: transform .7s var(--ease), opacity .5s var(--ease); }
.sl-view-library .sl-pane-now { transform: translateY(6%); opacity: 0; pointer-events: none; }
.sl-view-now .sl-pane-lib { transform: translateY(-3%) scale(.98); opacity: 0; pointer-events: none; }

/* ── 正在播放 ── */
.sl-now { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(300px, 0.95fr) minmax(0, 1.15fr);
  gap: clamp(24px, 4cqw, 72px); padding: clamp(28px, 5cqh, 64px) clamp(24px, 4.5cqw, 80px); }
.sl-back { position: absolute; top: 18px; left: 22px; width: 38px; height: 38px; border-radius: 50%;
  display: grid; place-items: center; color: rgba(255,255,255,.75); transition: background .2s, color .2s; z-index: 2; }
.sl-back:hover { background: rgba(255,255,255,.12); color: #fff; }
.sl-stage { display: flex; flex-direction: column; justify-content: center; align-items: center; min-width: 0; gap: 18px; }

.sl-disc { position: relative; width: min(100%, 52cqh, 460px); aspect-ratio: 1; flex: none; }
.sl-ring { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.sl-vinyl { position: absolute; inset: 15%; border-radius: 50%;
  box-shadow: 0 30px 60px -18px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.06); }
.sl-vinyl-spin { position: absolute; inset: 0; border-radius: 50%; overflow: hidden; animation: sl-spin 9s linear infinite; animation-play-state: paused; }
.sl-disc.is-playing .sl-vinyl-spin { animation-play-state: running; }
.sl-vinyl-grooves { position: absolute; inset: 0; border-radius: 50%;
  background:
    repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,.035) 0 1px, rgba(0,0,0,0) 1px 3px),
    radial-gradient(circle at 50% 50%, #1b1b1f 0 40%, #0c0c0f 41%, #141418 70%, #08080a 100%); }
.sl-vinyl-label { position: absolute; inset: 29%; border-radius: 50%; overflow: hidden; background: #222;
  box-shadow: 0 0 0 3px rgba(0,0,0,.6), inset 0 0 0 1px rgba(255,255,255,.12); display: grid; place-items: center; }
.sl-vinyl-label img { width: 100%; height: 100%; object-fit: cover; }
.sl-vinyl-fish { color: rgba(255,255,255,.6); }
.sl-vinyl-hole { position: absolute; left: 50%; top: 50%; width: 3.2%; height: 3.2%; margin: -1.6% 0 0 -1.6%; border-radius: 50%;
  background: #0b0b0d; box-shadow: inset 0 1px 2px rgba(0,0,0,.8), 0 0 0 2px rgba(255,255,255,.18); }
.sl-vinyl-sheen { position: absolute; inset: 0; border-radius: 50%; pointer-events: none; mix-blend-mode: screen;
  background: conic-gradient(from 210deg, rgba(255,255,255,0) 0deg, rgba(255,255,255,.13) 22deg, rgba(255,255,255,0) 55deg,
    rgba(255,255,255,0) 180deg, rgba(255,255,255,.08) 205deg, rgba(255,255,255,0) 235deg); }
@keyframes sl-spin { to { transform: rotate(360deg); } }

.sl-arm { position: absolute; top: -3%; right: -1%; width: 21%; overflow: visible; transform-origin: 50% 10%;
  transform: rotate(-30deg); transition: transform 1.1s var(--ease); filter: drop-shadow(0 10px 14px rgba(0,0,0,.45)); }
.sl-disc.is-playing .sl-arm { transform: rotate(-4deg); }
.sl-arm-base { fill: rgba(255,255,255,.14); stroke: rgba(255,255,255,.28); stroke-width: 1.5; }
.sl-arm-pivot { fill: rgba(255,255,255,.85); }
.sl-arm-rod { fill: none; stroke: rgba(240,244,250,.9); stroke-width: 5; stroke-linecap: round; }
.sl-arm-head { fill: rgba(240,244,250,.95); }

.sl-meta { width: min(100%, 460px); text-align: center; min-width: 0; }
.sl-title { font-size: clamp(20px, 2.3cqw, 30px); font-weight: 750; letter-spacing: .01em; line-height: 1.25;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 2px 18px rgba(0,0,0,.25); }
.sl-artist { margin-top: 6px; font-size: 14.5px; color: rgba(255,255,255,.68); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-who { color: rgba(255,255,255,.45); }

.sl-progress { width: min(100%, 460px); }
.sl-bar { height: 18px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
.sl-bar-track { position: relative; width: 100%; height: 4px; border-radius: 99px; background: rgba(255,255,255,.18); overflow: hidden; transition: height .2s var(--ease); }
.sl-bar:hover .sl-bar-track, .sl-bar.is-drag .sl-bar-track { height: 8px; }
.sl-bar-fill { position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0); border-radius: 99px;
  background: linear-gradient(90deg, rgba(255,255,255,.75), #fff); box-shadow: 0 0 14px var(--accent); }
.sl-times { display: flex; justify-content: space-between; font-size: 12px; color: rgba(255,255,255,.55); font-variant-numeric: tabular-nums; margin-top: 2px; }

.sl-controls { display: flex; align-items: center; justify-content: center; gap: clamp(10px, 1.6cqw, 22px); width: min(100%, 460px); position: relative; }
.sl-ctl { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: rgba(255,255,255,.9);
  transition: transform .2s var(--ease), background .2s, color .2s; }
.sl-ctl:hover { background: rgba(255,255,255,.1); }
.sl-ctl:active { transform: scale(.92); }
.sl-small { width: 36px; height: 36px; color: rgba(255,255,255,.5); position: relative; }
.sl-small.is-on { color: #fff; }
.sl-small.is-on::after { content: ''; position: absolute; bottom: 1px; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--accent); }
.sl-play { width: 64px; height: 64px; background: #fff; color: #0d1120; box-shadow: 0 12px 30px -8px rgba(0,0,0,.45); }
.sl-play:hover { background: #fff; transform: scale(1.05); }
.sl-play svg { width: 28px; height: 28px; }
.sl-volume { display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,.55); margin-top: -4px; }
.sl-volume input { -webkit-appearance: none; appearance: none; width: 120px; height: 4px; border-radius: 99px; outline: none; cursor: pointer;
  background: linear-gradient(90deg, rgba(255,255,255,.85) var(--v), rgba(255,255,255,.18) var(--v)); }
.sl-volume input::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.sl-error { font-size: 13px; color: #ffd2d2; background: rgba(120,0,0,.25); padding: 6px 12px; border-radius: 10px; }

/* ── 歌词 ── */
.sl-words { position: relative; min-width: 0; min-height: 0;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 14%, #000 72%, transparent 100%);
          mask-image: linear-gradient(180deg, transparent 0, #000 14%, #000 72%, transparent 100%); }
.sl-lyrics { position: absolute; inset: 0; overflow: hidden; }
.sl-lyrics-track { position: absolute; left: 0; right: 0; top: 0; padding: 0 4% 0 2%; }
.sl-line { padding: .32em .4em; margin-left: -.4em; border-radius: 14px; cursor: pointer; transform-origin: 0 50%;
  font-size: clamp(22px, 2.55cqw, 40px); font-weight: 800; line-height: 1.28; letter-spacing: -.005em; color: #fff;
  transition-property: transform, opacity, filter; transition-duration: .75s, .5s, .5s; transition-timing-function: var(--ease);
  will-change: transform; word-break: break-word; }
.sl-line:hover { background: rgba(255,255,255,.07); }
.sl-word { white-space: pre-wrap; }
.sl-line.is-current { filter: drop-shadow(0 0 22px rgba(255,255,255,.22)); }
.sl-line.is-current .sl-word { color: transparent; -webkit-background-clip: text; background-clip: text;
  background-image: linear-gradient(90deg, #fff 0, #fff var(--p, 0%), rgba(255,255,255,.4) calc(var(--p, 0%) + 6%), rgba(255,255,255,.4) 100%); }
.sl-gap { display: flex; gap: .3em; align-items: center; height: 1.6em; }
.sl-gap span { width: .36em; height: .36em; border-radius: 50%; background: #fff; opacity: .3; }
.sl-gap.is-current span { animation: sl-breathe 2.2s var(--ease) infinite; }
.sl-gap.is-current span:nth-child(1) { opacity: calc(.3 + .7 * clamp(0, var(--p, 0) * 3, 1)); }
.sl-gap.is-current span:nth-child(2) { opacity: calc(.3 + .7 * clamp(0, var(--p, 0) * 3 - 1, 1)); animation-delay: .15s; }
.sl-gap.is-current span:nth-child(3) { opacity: calc(.3 + .7 * clamp(0, var(--p, 0) * 3 - 2, 1)); animation-delay: .3s; }
@keyframes sl-breathe { 0%, 100% { transform: scale(.85); } 50% { transform: scale(1.15); } }
.sl-lyrics-empty { display: grid; place-items: center; }
.sl-nolyrics { text-align: left; max-width: 90%; }
.sl-nolyrics-title { font-size: clamp(28px, 3.4cqw, 54px); font-weight: 800; line-height: 1.15; }
.sl-nolyrics-sub { margin-top: 12px; font-size: 16px; color: rgba(255,255,255,.6); }

/* ── 歌库 ── */
.sl-library { position: absolute; inset: 0; }
.sl-lib-scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; padding: 0 clamp(18px, 3.2cqw, 48px);
  scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.sl-lib-head { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  padding: 22px 0 16px; margin: 0 calc(-1 * clamp(18px, 3.2cqw, 48px)); padding-left: clamp(18px, 3.2cqw, 48px); padding-right: clamp(18px, 3.2cqw, 48px);
  background: linear-gradient(180deg, rgba(8,12,26,.55), rgba(8,12,26,0)); backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2);
  -webkit-mask-image: linear-gradient(180deg, #000 80%, transparent); mask-image: linear-gradient(180deg, #000 80%, transparent); }
.sl-brand { display: flex; align-items: center; gap: 12px; }
.sl-brand-mark { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
  background: linear-gradient(140deg, rgba(255,255,255,.28), rgba(255,255,255,.06)); box-shadow: inset 0 0 0 1px rgba(255,255,255,.2); }
.sl-brand-name { font-size: 22px; font-weight: 800; letter-spacing: .02em; }
.sl-brand-sub { font-size: 13px; color: rgba(255,255,255,.6); margin-top: 2px; }
.sl-lib-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sl-search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-radius: 99px; width: 240px;
  background: rgba(255,255,255,.1); box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); color: rgba(255,255,255,.6); transition: background .2s, box-shadow .2s; }
.sl-search:focus-within { background: rgba(255,255,255,.16); box-shadow: inset 0 0 0 1px rgba(255,255,255,.35); }
.sl-search input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: #fff; font: inherit; font-size: 14px; }
.sl-search input::placeholder { color: rgba(255,255,255,.45); }
.sl-seg { display: flex; padding: 3px; border-radius: 99px; background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
.sl-seg button { padding: 6px 14px; border-radius: 99px; font-size: 13px; color: rgba(255,255,255,.65); transition: background .2s, color .2s; }
.sl-seg button.is-on { background: rgba(255,255,255,.9); color: #10162a; font-weight: 600; }

.sl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); gap: 26px 20px; padding-top: 8px; }
.sl-card { text-align: left; display: block; min-width: 0; border-radius: 16px; padding: 0; transition: transform .35s var(--ease); }
.sl-card:hover { transform: translateY(-4px); }
.sl-card-cover { position: relative; aspect-ratio: 16 / 10; border-radius: 14px; overflow: hidden; background: rgba(255,255,255,.08);
  box-shadow: 0 14px 30px -14px rgba(0,0,0,.6), inset 0 0 0 1px rgba(255,255,255,.08); }
.sl-card-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .6s var(--ease), filter .4s; }
.sl-card:hover .sl-card-cover img { transform: scale(1.05); }
.sl-card-blank { width: 100%; height: 100%; display: grid; place-items: center; color: rgba(255,255,255,.4);
  background: linear-gradient(135deg, rgba(255,255,255,.12), rgba(255,255,255,.03)); }
.sl-card-play { position: absolute; right: 10px; bottom: 10px; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
  background: rgba(255,255,255,.92); color: #10162a; box-shadow: 0 8px 20px -6px rgba(0,0,0,.5);
  opacity: 0; transform: translateY(6px) scale(.9); transition: opacity .25s, transform .35s var(--ease); }
.sl-card:hover .sl-card-play, .sl-card.is-active .sl-card-play { opacity: 1; transform: none; }
.sl-card-tag { position: absolute; left: 8px; top: 8px; font-size: 11px; padding: 2px 8px; border-radius: 99px; background: rgba(0,0,0,.45); color: rgba(255,255,255,.8); backdrop-filter: blur(6px); }
.sl-card.is-active .sl-card-cover { box-shadow: 0 0 0 2px rgba(255,255,255,.85), 0 14px 30px -14px rgba(0,0,0,.6); }
.sl-card-title { margin-top: 10px; font-size: 14.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-card-sub { margin-top: 3px; font-size: 12.5px; color: rgba(255,255,255,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-eq { display: flex; align-items: flex-end; gap: 2px; height: 14px; }
.sl-eq i { width: 3px; border-radius: 2px; background: currentColor; animation: sl-eq 1s ease-in-out infinite; }
.sl-eq i:nth-child(2) { animation-delay: -.35s; }
.sl-eq i:nth-child(3) { animation-delay: -.7s; }
@keyframes sl-eq { 0%, 100% { height: 30%; } 50% { height: 100%; } }
.sl-empty { padding: 60px 0; text-align: center; color: rgba(255,255,255,.6); }
.sl-lib-pad { height: 110px; }

.sl-mini { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 3; width: min(560px, calc(100% - 32px)); display: flex; align-items: center; gap: 10px;
  padding: 8px 10px 8px 8px; border-radius: 20px; cursor: pointer;
  background: rgba(20,24,40,.55); backdrop-filter: blur(24px) saturate(1.4); -webkit-backdrop-filter: blur(24px) saturate(1.4);
  box-shadow: 0 18px 40px -16px rgba(0,0,0,.7), inset 0 0 0 1px rgba(255,255,255,.12); }
.sl-mini-cover { width: 64px; height: 40px; border-radius: 10px; object-fit: cover; flex: none; }
.sl-mini-text { flex: 1; min-width: 0; }
.sl-mini-title { font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-mini-sub { font-size: 12px; color: rgba(255,255,255,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-play-sm { width: 42px; height: 42px; }
.sl-play-sm svg { width: 20px; height: 20px; }

/* 窄的时候：上下排 */
@container (max-width: 820px) {
  .sl-now { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); gap: 10px; padding: 52px 20px 20px; }
  .sl-disc { width: min(62cqw, 30cqh, 300px); }
  .sl-stage { gap: 10px; }
  .sl-volume { display: none; }
  .sl-line { font-size: clamp(20px, 5cqw, 28px); }
}
@media (prefers-reduced-motion: reduce) {
  .sl-vinyl-spin { animation: none; }
  .sl-line { transition-duration: 0s !important; }
}
`;
