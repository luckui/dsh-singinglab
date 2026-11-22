/**
 * 播放器的样式：清新的蓝白色，配场景插画。挂在 <style data-plugin="dsh-singinglab">，类名都以 sl- 开头，不碰 DSH 自己的样式。
 * 深色字用藏青（--ink），强调色是天蓝（--sky）。
 */

export const CSS = `
.sl-root {
  --ink: #1e3466;
  --ink-2: rgba(30, 52, 102, .62);
  --ink-3: rgba(30, 52, 102, .38);
  --sky: #3d8bff;
  --sky-2: #79c6ff;
  --glass: rgba(255, 255, 255, .58);
  --ease: cubic-bezier(.22, 1, .36, 1);
  position: relative; height: 100%; width: 100%; overflow: hidden; isolation: isolate;
  color: var(--ink); background: #dcebfb;
  font-family: "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; container-type: inline-size;
}
:where(.sl-root) button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
/* DSH 全局给圆角用了 superellipse（方圆），唱片、按钮要正圆 */
.sl-root, .sl-root *, .sl-root *::before, .sl-root *::after { box-sizing: border-box; corner-shape: round; }

/* 歌库页的背景：同一张插画的模糊小图，蒙一层白 */
.sl-libbg { position: absolute; inset: -4%; z-index: -1; background: #dcebfb center / cover no-repeat; }
.sl-libbg::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(246,250,255,.5), rgba(236,244,255,.72)); }

/* 两个视图叠在一起，切换时淡入淡出加一点位移 */
.sl-views { position: absolute; inset: 0; }
.sl-pane { position: absolute; inset: 0; transition: transform .8s var(--ease), opacity .6s var(--ease); }
.sl-view-library .sl-pane-now { transform: scale(1.03); opacity: 0; pointer-events: none; }
.sl-view-now .sl-pane-lib { transform: scale(.98); opacity: 0; pointer-events: none; }

/* ── 正在播放：场景 ── */
.sl-now { position: absolute; inset: 0; overflow: hidden; }
.sl-scene { position: absolute; inset: 0; overflow: hidden; background: #cfe4fa; }
.sl-scene-world { position: absolute; inset: 0; transform-origin: 45% 55%; will-change: transform; }
.sl-scene-img { position: absolute; max-width: none; user-select: none; -webkit-user-drag: none; }

.sl-beam { position: absolute; pointer-events: none; overflow: hidden; mix-blend-mode: screen;
  -webkit-mask-image: radial-gradient(90% 80% at 35% 0%, #000 15%, transparent 72%); mask-image: radial-gradient(90% 80% at 35% 0%, #000 15%, transparent 72%); }
.sl-beam-rays { position: absolute; inset: -60%; opacity: .55; animation: sl-rays 14s ease-in-out infinite alternate;
  background:
    repeating-linear-gradient(90deg, rgba(255,248,225,0) 0 46px, rgba(255,248,225,.32) 64px, rgba(255,248,225,0) 92px, rgba(255,248,225,0) 150px),
    repeating-linear-gradient(90deg, rgba(255,255,245,0) 0 120px, rgba(255,255,245,.22) 150px, rgba(255,255,245,0) 190px, rgba(255,255,245,0) 260px); }
@keyframes sl-rays { 0% { opacity: .38; translate: -18px 0; } 100% { opacity: .62; translate: 18px 0; } }
.sl-sparkles { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

/* 窗台上的唱片：画里的唱片不盖掉（唱臂还在），只在上面叠一层转着的反光和纹路，压扁成透视的椭圆 */
.sl-tt { position: absolute; pointer-events: none; }
.sl-tt-disc { position: absolute; inset: 0; border-radius: 50%; opacity: 0; transition: opacity 1.2s var(--ease); mix-blend-mode: screen;
  -webkit-mask-image: radial-gradient(circle, transparent 0 27%, #000 29% 96%, transparent 99%); mask-image: radial-gradient(circle, transparent 0 27%, #000 29% 96%, transparent 99%);
  background:
    conic-gradient(from 0deg, rgba(255,255,255,0) 0deg, rgba(255,255,255,.38) 14deg, rgba(255,255,255,0) 36deg, rgba(255,255,255,0) 180deg, rgba(255,255,255,.26) 196deg, rgba(255,255,255,0) 220deg),
    repeating-radial-gradient(circle, rgba(255,255,255,.07) 0 1px, rgba(0,0,0,0) 1px 3px);
  animation: sl-spin 1.8s linear infinite; animation-play-state: paused; }
.sl-tt-disc.is-playing { opacity: .55; animation-play-state: running; }
.sl-tt-disc img { display: none; }
@keyframes sl-spin { to { transform: rotate(360deg); } }

/* 窗玻璃：歌词映在上面 */
.sl-glass { position: absolute; container-type: size; pointer-events: auto;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 12%, #000 78%, transparent 100%);
          mask-image: linear-gradient(180deg, transparent 0, #000 12%, #000 78%, transparent 100%); }
.sl-glass-sheen { position: absolute; inset: 0; pointer-events: none; mix-blend-mode: screen;
  background: linear-gradient(115deg, rgba(255,255,255,0) 30%, rgba(255,255,255,.10) 42%, rgba(255,255,255,0) 52%, rgba(255,255,255,0) 64%, rgba(255,255,255,.06) 70%, rgba(255,255,255,0) 76%); }

/* ── 歌词（通用） ── */
.sl-lyrics { position: absolute; inset: 0; overflow: hidden; }
.sl-lyrics-track { position: absolute; left: 0; right: 0; top: 0; }
.sl-line { padding: .3em .4em; margin-left: -.4em; border-radius: 12px; cursor: pointer; transform-origin: 0 50%;
  font-weight: 800; line-height: 1.3; word-break: break-word;
  transition-property: transform, opacity, filter; transition-duration: .8s, .55s, .55s; transition-timing-function: var(--ease); will-change: transform; }
.sl-word { white-space: pre-wrap; }
.sl-gap { display: flex; gap: .3em; align-items: center; height: 1.6em; }
.sl-gap span { width: .34em; height: .34em; border-radius: 50%; background: currentColor; opacity: .35; }
.sl-gap.is-current span { animation: sl-breathe 2.2s var(--ease) infinite; }
.sl-gap.is-current span:nth-child(1) { opacity: calc(.35 + .65 * clamp(0, var(--p, 0) * 3, 1)); }
.sl-gap.is-current span:nth-child(2) { opacity: calc(.35 + .65 * clamp(0, var(--p, 0) * 3 - 1, 1)); animation-delay: .15s; }
.sl-gap.is-current span:nth-child(3) { opacity: calc(.35 + .65 * clamp(0, var(--p, 0) * 3 - 2, 1)); animation-delay: .3s; }
@keyframes sl-breathe { 0%, 100% { transform: scale(.85); } 50% { transform: scale(1.15); } }
.sl-lyrics-empty { display: grid; place-items: center; }

/* 玻璃上的歌词：白字，带一点蓝色的光，像映在玻璃上 */
.sl-lyrics.is-glass { color: #fff; }
.sl-lyrics.is-glass .sl-line { font-size: clamp(18px, 8.4cqw, 48px); font-weight: 750; letter-spacing: .02em;
  text-shadow: 0 1px 2px rgba(18, 56, 120, .4), 0 0 18px rgba(40, 110, 205, .55); }
.sl-lyrics.is-glass .sl-line:hover { background: rgba(255,255,255,.08); }
.sl-lyrics.is-glass .sl-line.is-current { filter: drop-shadow(0 0 14px rgba(255,255,255,.5)); }
.sl-lyrics.is-glass .sl-line.is-current .sl-word { color: transparent; -webkit-background-clip: text; background-clip: text; text-shadow: none;
  background-image: linear-gradient(90deg, #fff 0, #fff var(--p, 0%), rgba(255,255,255,.5) calc(var(--p, 0%) + 6%), rgba(255,255,255,.5) 100%); }
.sl-lyrics.is-glass .sl-gap span { background: #fff; box-shadow: 0 0 10px rgba(46,120,210,.5); }
.sl-nolyrics { text-align: left; max-width: 92%; color: #fff; text-shadow: 0 1px 2px rgba(18,56,120,.3), 0 0 18px rgba(46,120,210,.45); }
.sl-nolyrics-title { font-size: clamp(22px, 9cqw, 50px); font-weight: 800; line-height: 1.15; }
.sl-nolyrics-sub { margin-top: 10px; font-size: clamp(13px, 3.6cqw, 17px); opacity: .9; }

/* ── 播放卡片 ── */
.sl-back { position: absolute; top: 16px; left: 18px; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; z-index: 3;
  background: rgba(255,255,255,.5); color: var(--ink); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 6px 18px -8px rgba(30,70,140,.5), inset 0 0 0 1px rgba(255,255,255,.7);
  transition: opacity .8s var(--ease), background .2s; }
.sl-back:hover { background: rgba(255,255,255,.8); }
.sl-card { position: absolute; bottom: 4.5%; width: clamp(300px, 30cqw, 380px); z-index: 3; padding: 16px 18px 12px; border-radius: 26px;
  background: var(--glass); backdrop-filter: blur(22px) saturate(1.5); -webkit-backdrop-filter: blur(22px) saturate(1.5);
  box-shadow: 0 24px 60px -24px rgba(26, 72, 150, .5), inset 0 0 0 1px rgba(255,255,255,.75);
  transition: opacity .9s var(--ease), transform .9s var(--ease); }
.sl-card-right { right: 3%; }
.sl-card-left { left: 3%; }
.sl-now.is-idle .sl-card { opacity: 0; transform: translateY(12px); pointer-events: none; }
.sl-now.is-idle .sl-back { opacity: 0; pointer-events: none; }
.sl-now.is-idle { cursor: none; }
.sl-card-head { display: flex; align-items: center; gap: 14px; }
.sl-card-meta { min-width: 0; flex: 1; }
.sl-title { font-size: 17px; font-weight: 750; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-artist { margin-top: 2px; font-size: 12.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-who { color: var(--ink-3); }
.sl-spectrum { display: block; width: 100%; height: 20px; margin-top: 6px; }

.sl-minidisc { position: relative; width: 74px; height: 74px; flex: none; border-radius: 50%;
  box-shadow: 0 10px 22px -10px rgba(10, 30, 70, .6); }
.sl-minidisc-spin { position: absolute; inset: 0; border-radius: 50%; animation: sl-spin 8s linear infinite; animation-play-state: paused;
  background:
    repeating-radial-gradient(circle, rgba(255,255,255,.05) 0 1px, rgba(0,0,0,0) 1px 2.4px),
    radial-gradient(circle, #23232a 0 38%, #101014 39%, #1b1b20 72%, #09090b 100%); }
.sl-minidisc.is-playing .sl-minidisc-spin { animation-play-state: running; }
.sl-minidisc-label { position: absolute; inset: 27%; border-radius: 50%; overflow: hidden; background: #cfe3fb; color: var(--sky);
  display: grid; place-items: center; box-shadow: 0 0 0 2px rgba(0,0,0,.5); }
.sl-minidisc-label img { width: 100%; height: 100%; object-fit: cover; }
.sl-minidisc::after { content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  background: conic-gradient(from 200deg, rgba(255,255,255,0), rgba(255,255,255,.16) 25deg, rgba(255,255,255,0) 60deg, rgba(255,255,255,0) 180deg, rgba(255,255,255,.1) 210deg, rgba(255,255,255,0) 240deg); }

.sl-progress { margin-top: 12px; }
.sl-bar { height: 16px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
.sl-bar-track { position: relative; width: 100%; height: 5px; border-radius: 99px; background: rgba(30,52,102,.13); overflow: hidden; transition: height .2s var(--ease); }
.sl-bar:hover .sl-bar-track, .sl-bar.is-drag .sl-bar-track { height: 8px; }
.sl-bar-fill { position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0); border-radius: 99px;
  background: linear-gradient(90deg, var(--sky), var(--sky-2)); }
.sl-times { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; }

.sl-controls { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.sl-ctl { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--ink);
  transition: transform .2s var(--ease), background .2s, color .2s; position: relative; }
.sl-ctl:hover { background: rgba(30,52,102,.07); }
.sl-ctl:active { transform: scale(.92); }
.sl-small { width: 34px; height: 34px; color: var(--ink-3); }
.sl-small.is-on { color: var(--sky); }
.sl-small.is-on::after { content: ''; position: absolute; bottom: 0; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--sky); }
.sl-play { width: 52px; height: 52px; color: #fff; background: linear-gradient(145deg, #4a9bff, #2f63c9);
  box-shadow: 0 10px 22px -8px rgba(40, 100, 210, .7); }
.sl-play:hover { background: linear-gradient(145deg, #5aa7ff, #3770d6); transform: scale(1.04); }
.sl-play svg { width: 24px; height: 24px; }
.sl-volume { display: flex; align-items: center; gap: 6px; color: var(--ink-3); }
.sl-volume input { -webkit-appearance: none; appearance: none; width: 52px; height: 4px; border-radius: 99px; outline: none; cursor: pointer;
  background: linear-gradient(90deg, var(--sky) var(--v), rgba(30,52,102,.15) var(--v)); }
.sl-volume input::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(20,50,110,.45); }
.sl-error { margin-top: 8px; font-size: 12.5px; color: #b4233a; background: rgba(255,220,225,.7); padding: 6px 10px; border-radius: 10px; }

/* 歌单抽屉 */
.sl-drawer { position: absolute; top: 16px; bottom: 16px; width: min(360px, calc(100% - 32px)); z-index: 4; display: flex; flex-direction: column;
  border-radius: 26px; padding: 14px 10px 10px 14px; background: rgba(255,255,255,.66); backdrop-filter: blur(24px) saturate(1.5); -webkit-backdrop-filter: blur(24px) saturate(1.5);
  box-shadow: 0 30px 70px -30px rgba(26,72,150,.6), inset 0 0 0 1px rgba(255,255,255,.8);
  transition: transform .6s var(--ease), opacity .45s var(--ease); opacity: 0; pointer-events: none; }
.sl-drawer-right { right: 16px; transform: translateX(30px); }
.sl-drawer-left { left: 16px; transform: translateX(-30px); }
.sl-drawer.is-open { opacity: 1; transform: none; pointer-events: auto; }
.sl-now.is-list .sl-card { opacity: 0; pointer-events: none; transform: translateY(12px); }
.sl-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 0 2px 8px 4px; }
.sl-drawer-title { font-size: 16px; font-weight: 800; }
.sl-drawer .sl-drawer-search { width: auto; margin: 0 4px 8px 0; height: 36px; }
.sl-drawer-list { flex: 1; overflow-y: auto; padding-right: 4px; scrollbar-width: thin; scrollbar-color: rgba(30,52,102,.25) transparent; }
.sl-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px; border-radius: 14px; text-align: left; transition: background .2s; }
.sl-row:hover { background: rgba(255,255,255,.7); }
.sl-row.is-current { background: rgba(61,139,255,.14); }
.sl-row-cover { width: 56px; height: 35px; border-radius: 8px; object-fit: cover; flex: none; background: rgba(30,52,102,.08); }
.sl-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sl-row-title { font-size: 13.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-row.is-current .sl-row-title { color: #2f6fe0; }
.sl-row-sub { font-size: 11.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-row-eq { color: var(--sky); flex: none; padding-right: 4px; }

/* 学歌：右上角的药丸、学歌列表、提示条、B 站搜索结果、确认框 */
.sl-overlay { position: absolute; top: 16px; right: 18px; z-index: 6; display: flex; justify-content: flex-end; pointer-events: none; }
.sl-overlay > * { pointer-events: auto; }
.sl-root:has(.sl-view-now) .sl-overlay, .sl-root.sl-view-now:has(.sl-now.is-idle) .sl-overlay { transition: opacity .8s; }
.sl-root.sl-view-now:has(.sl-now.is-idle) .sl-overlay { opacity: 0; pointer-events: none; }
.sl-pill-wrap { position: relative; }
.sl-pill { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px 0 8px; border-radius: 99px; font-size: 13px; font-weight: 600; color: var(--ink);
  background: rgba(255,255,255,.72); backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4);
  box-shadow: 0 10px 26px -14px rgba(26,72,150,.6), inset 0 0 0 1px rgba(255,255,255,.85); max-width: min(460px, 70vw); }
.sl-pill-quiet { width: 38px; padding: 0; justify-content: center; color: var(--ink-2); }
.sl-pill-fish { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: linear-gradient(145deg, #6cc0ff, #3a72de); flex: none; }
.sl-pill.is-busy .sl-pill-fish { animation: sl-swim 1.6s ease-in-out infinite; }
@keyframes sl-swim { 0%, 100% { transform: translateY(0) rotate(-6deg); } 50% { transform: translateY(-2px) rotate(6deg); } }
.sl-pill-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sl-pill-bar { width: 64px; height: 5px; border-radius: 99px; background: rgba(30,52,102,.12); overflow: hidden; flex: none; }
.sl-pill-bar i, .sl-job-bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--sky), var(--sky-2)); transition: width .8s var(--ease); }
.sl-pill-pct { font-variant-numeric: tabular-nums; color: var(--ink-2); flex: none; }
.sl-pill-more { font-size: 12px; color: var(--sky); flex: none; }
.sl-learnlist { position: absolute; right: 0; top: 46px; width: 340px; max-height: 60vh; overflow-y: auto; padding: 10px; border-radius: 22px;
  background: rgba(255,255,255,.82); backdrop-filter: blur(22px) saturate(1.4); -webkit-backdrop-filter: blur(22px) saturate(1.4);
  box-shadow: 0 24px 60px -24px rgba(26,72,150,.6), inset 0 0 0 1px rgba(255,255,255,.9); }
.sl-learnlist-head { display: flex; align-items: center; justify-content: space-between; font-weight: 800; padding: 2px 4px 6px 6px; }
.sl-learnlist-empty { padding: 16px; text-align: center; color: var(--ink-2); font-size: 13px; }
.sl-job { display: flex; align-items: center; gap: 10px; padding: 7px; border-radius: 14px; }
.sl-job.is-running { background: rgba(61,139,255,.1); }
.sl-job-cover { width: 52px; height: 33px; border-radius: 8px; object-fit: cover; flex: none; background: rgba(30,52,102,.08); }
.sl-job-text { flex: 1; min-width: 0; }
.sl-job-title { font-size: 13.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-job-sub { font-size: 11.5px; color: var(--ink-2); margin-top: 1px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sl-job.is-failed .sl-job-sub { color: #b4233a; }
.sl-job-bar { height: 4px; margin-top: 5px; border-radius: 99px; background: rgba(30,52,102,.12); overflow: hidden; }
.sl-toast { position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 7; display: flex; align-items: center; gap: 10px;
  padding: 10px 12px 10px 16px; border-radius: 99px; font-size: 14px; font-weight: 600; color: #fff; max-width: min(620px, calc(100% - 32px));
  background: linear-gradient(145deg, rgba(74,155,255,.95), rgba(47,99,201,.95)); box-shadow: 0 18px 40px -16px rgba(30,80,180,.8);
  animation: sl-toast-in .5s var(--ease); }
.sl-toast span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-toast-btn { flex: none; padding: 5px 12px; border-radius: 99px; background: rgba(255,255,255,.9) !important; color: #2f63c9 !important; font-size: 13px; font-weight: 700; }
@keyframes sl-toast-in { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }
.sl-bili-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 4px 0 16px; padding: 12px 12px 12px 18px;
  border-radius: 20px; background: rgba(255,255,255,.6); box-shadow: inset 0 0 0 1px rgba(255,255,255,.8); font-size: 14px; color: var(--ink-2); }
.sl-bili { margin: 0 0 26px; padding: 16px 18px 20px; border-radius: 24px; background: rgba(255,255,255,.5); box-shadow: inset 0 0 0 1px rgba(255,255,255,.8); }
.sl-bili-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.sl-bili-warn { font-size: 13px; color: #9a5b00; background: rgba(255,226,170,.6); padding: 8px 12px; border-radius: 12px; margin-bottom: 10px; }
.sl-hit .sl-card-title { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.35; height: 2.7em; }
.sl-hit-btn { margin-top: 8px; height: 34px; padding: 0 14px; font-size: 13px; }
.sl-btn[disabled] { opacity: .55; cursor: default; transform: none; }
.sl-modal { position: absolute; inset: 0; z-index: 8; display: grid; place-items: center; background: rgba(20,40,80,.25); backdrop-filter: blur(4px); }
.sl-modal-card { width: min(420px, calc(100% - 32px)); padding: 18px; border-radius: 26px; background: rgba(255,255,255,.92); box-shadow: 0 30px 80px -30px rgba(20,60,140,.7); }
.sl-modal-cover { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 16px; }
.sl-modal-title { margin-top: 12px; font-size: 18px; font-weight: 800; }
.sl-modal-sub { margin-top: 2px; font-size: 12.5px; color: var(--ink-2); }
.sl-field { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 13px; color: var(--ink-2); }
.sl-field span { width: 32px; flex: none; }
.sl-field input { flex: 1; height: 38px; padding: 0 12px; border-radius: 12px; border: 0; outline: none; font: inherit; font-size: 14px; color: var(--ink);
  background: rgba(30,52,102,.06); box-shadow: inset 0 0 0 1px rgba(30,52,102,.08); }
.sl-field input:focus { box-shadow: inset 0 0 0 1.5px var(--sky); }
.sl-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; flex-wrap: wrap; }

/* ── 歌库 ── */
.sl-library { position: absolute; inset: 0; }
.sl-lib-scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; padding: 0 clamp(18px, 3.2cqw, 48px);
  scrollbar-width: thin; scrollbar-color: rgba(30,52,102,.25) transparent; }
.sl-lib-head { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  padding: 14px clamp(18px, 3.2cqw, 48px) 14px; margin: 0 calc(-1 * clamp(18px, 3.2cqw, 48px));
  background: linear-gradient(180deg, rgba(240,247,255,.78), rgba(240,247,255,.35)); backdrop-filter: blur(16px) saturate(1.3); -webkit-backdrop-filter: blur(16px) saturate(1.3);
  -webkit-mask-image: linear-gradient(180deg, #000 78%, transparent); mask-image: linear-gradient(180deg, #000 78%, transparent); }
.sl-hero { position: relative; margin: 22px 0 6px; height: clamp(220px, 34cqw, 360px); border-radius: 28px; overflow: hidden;
  background: #cfe4fa 26% 24% / cover no-repeat; box-shadow: 0 30px 60px -34px rgba(20,60,140,.7), inset 0 0 0 1px rgba(255,255,255,.7); }
.sl-hero::before { content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, rgba(240,247,255,0) 30%, rgba(240,247,255,.55) 52%, rgba(240,247,255,.88) 72%); }
.sl-hero-text { position: absolute; right: clamp(20px, 5cqw, 64px); top: 50%; transform: translateY(-50%); text-align: left; max-width: 46%; }
.sl-hero-kicker { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 650; color: var(--sky);
  background: rgba(255,255,255,.75); padding: 4px 10px; border-radius: 99px; }
.sl-hero-title { margin-top: 12px; font-size: clamp(22px, 3cqw, 38px); font-weight: 800; letter-spacing: .02em; line-height: 1.2; }
.sl-hero-sub { margin-top: 6px; font-size: 14px; color: var(--ink-2); }
.sl-hero-actions { margin-top: 18px; display: flex; gap: 10px; flex-wrap: wrap; }
.sl-btn { display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px; border-radius: 99px; font-size: 14px; font-weight: 650;
  background: rgba(255,255,255,.8); color: var(--ink); box-shadow: 0 8px 20px -12px rgba(30,70,140,.6), inset 0 0 0 1px rgba(30,52,102,.08);
  transition: transform .25s var(--ease), box-shadow .25s; }
.sl-btn:hover { transform: translateY(-1px); }
.sl-btn-primary { background: linear-gradient(145deg, #4a9bff, #2f63c9); color: #fff; box-shadow: 0 12px 24px -10px rgba(40,100,210,.75); }
.sl-lib-title { font-size: 19px; font-weight: 800; }
.sl-brand { display: flex; align-items: center; gap: 12px; }
.sl-brand-mark { width: 46px; height: 46px; border-radius: 15px; display: grid; place-items: center; color: #fff;
  background: linear-gradient(145deg, #6cc0ff, #3a72de); box-shadow: 0 10px 22px -10px rgba(40,100,210,.8); }
.sl-brand-name { font-size: 22px; font-weight: 800; letter-spacing: .02em; }
.sl-brand-sub { font-size: 13px; color: var(--ink-2); margin-top: 2px; }
.sl-lib-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sl-search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-radius: 99px; width: 240px;
  background: rgba(255,255,255,.7); box-shadow: inset 0 0 0 1px rgba(30,52,102,.1), 0 6px 16px -10px rgba(30,70,140,.4); color: var(--ink-3); transition: box-shadow .2s; }
.sl-search:focus-within { box-shadow: inset 0 0 0 1.5px var(--sky), 0 6px 16px -10px rgba(30,70,140,.4); }
.sl-search input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: var(--ink); font: inherit; font-size: 14px; }
.sl-search input::placeholder { color: var(--ink-3); }
.sl-seg { display: flex; padding: 3px; border-radius: 99px; background: rgba(255,255,255,.55); box-shadow: inset 0 0 0 1px rgba(30,52,102,.08); }
.sl-seg button { padding: 6px 14px; border-radius: 99px; font-size: 13px; color: var(--ink-2); transition: background .2s, color .2s; }
.sl-seg button.is-on { background: var(--ink); color: #fff; font-weight: 600; }

.sl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 26px 20px; padding-top: 6px; }
.sl-card-item { text-align: left; display: block; min-width: 0; border-radius: 16px; transition: transform .35s var(--ease); }
.sl-card-item:hover { transform: translateY(-4px); }
.sl-card-cover { position: relative; aspect-ratio: 16 / 10; border-radius: 15px; overflow: hidden; background: rgba(255,255,255,.6);
  box-shadow: 0 16px 30px -18px rgba(20,60,130,.6), 0 0 0 1px rgba(255,255,255,.8); }
.sl-card-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .6s var(--ease); }
.sl-card-item:hover .sl-card-cover img { transform: scale(1.05); }
.sl-card-blank { width: 100%; height: 100%; display: grid; place-items: center; color: var(--sky);
  background: linear-gradient(135deg, #e6f1ff, #cfe2fb); }
.sl-card-play { position: absolute; right: 10px; bottom: 10px; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
  background: linear-gradient(145deg, #4a9bff, #2f63c9); color: #fff; box-shadow: 0 8px 20px -6px rgba(30,80,180,.7);
  opacity: 0; transform: translateY(6px) scale(.9); transition: opacity .25s, transform .35s var(--ease); }
.sl-card-item:hover .sl-card-play, .sl-card-item.is-active .sl-card-play { opacity: 1; transform: none; }
.sl-card-tag { position: absolute; left: 8px; top: 8px; font-size: 11px; padding: 2px 8px; border-radius: 99px; background: rgba(255,255,255,.78); color: var(--ink-2); }
.sl-card-item.is-active .sl-card-cover { box-shadow: 0 0 0 2.5px var(--sky), 0 16px 30px -18px rgba(20,60,130,.6); }
.sl-card-title { margin-top: 10px; font-size: 14.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-card-sub { margin-top: 3px; font-size: 12.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-eq { display: flex; align-items: flex-end; gap: 2px; height: 14px; }
.sl-eq i { width: 3px; border-radius: 2px; background: currentColor; animation: sl-eq 1s ease-in-out infinite; }
.sl-eq i:nth-child(2) { animation-delay: -.35s; }
.sl-eq i:nth-child(3) { animation-delay: -.7s; }
@keyframes sl-eq { 0%, 100% { height: 30%; } 50% { height: 100%; } }
.sl-empty { padding: 60px 0; text-align: center; color: var(--ink-2); }
.sl-lib-pad { height: 120px; }

.sl-mini { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 3; width: min(560px, calc(100% - 32px));
  display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 8px; border-radius: 22px; cursor: pointer;
  background: rgba(255,255,255,.72); backdrop-filter: blur(22px) saturate(1.4); -webkit-backdrop-filter: blur(22px) saturate(1.4);
  box-shadow: 0 18px 40px -18px rgba(26,72,150,.55), inset 0 0 0 1px rgba(255,255,255,.85); }
.sl-mini-cover { width: 64px; height: 40px; border-radius: 10px; object-fit: cover; flex: none; }
.sl-mini-text { flex: 1; min-width: 0; }
.sl-mini-title { font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-mini-sub { font-size: 12px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-play-sm { width: 42px; height: 42px; }
.sl-play-sm svg { width: 20px; height: 20px; }

@container (max-width: 760px) {
  .sl-card { left: 16px; right: 16px; width: auto; bottom: 16px; }
  .sl-volume { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .sl-tt-disc, .sl-minidisc-spin, .sl-beam-rays { animation: none; }
  .sl-line { transition-duration: 0s !important; }
}
`;
