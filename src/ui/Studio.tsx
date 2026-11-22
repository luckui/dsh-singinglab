/**
 * 学歌设置（歌库页右上角「学歌设置」打开的抽屉）。
 * 默认只看到一件事：准备好了没有。没准备好就一个大按钮「一键准备」，缺的东西自己补，不用选。
 * 唯一要用户给的是她的声音（RVC 模型）：拖进来就行。
 * 配方、模型货架收在「高级」里，给愿意折腾的人。
 */

import React, { useEffect, useRef, useState } from 'react';
import { getEngine } from './engine';
import { Icon } from './icons';

const BASE = '/api/dsh-singinglab';
const post = (p: string, body: unknown) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

interface StudioState {
  mode: 'recipe' | 'manual';
  ready: boolean;
  needs: Array<{ kind: string; id?: string; name: string; bytes?: number }>;
  preparing: boolean;
  prepareError: string | null;
  env: { ready: boolean; steps: Array<{ id: string; name: string; state: string; detail?: string; sec?: number }>; gpu: { name: string; memoryMB: number } | null };
  recipe: { id: string; name: string; use: Record<string, unknown> };
  recipes: Array<{ id: string; name: string; note: string }>;
  steps: Array<{ id: string; name: string; optional?: boolean; patch?: boolean; why?: string }>;
  models: Array<{ id: string; step: string; name: string; note: string; license: string; installed: boolean; bytes: number; downloading?: { done: number; total: number }; error?: string }>;
  voices: Array<{ id: string; name: string; index?: string }>;
  voice: string | null;
  mirror: boolean;
}

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

export function StudioPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [s, setS] = useState<StudioState | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [msg, setMsg] = useState('');
  const timer = useRef(0);

  const load = async () => {
    try {
      const r = await fetch(`${BASE}/studio`).then((x) => x.json());
      if (r.ok) setS(r);
    } catch { /* 下次再问 */ }
  };
  useEffect(() => {
    if (!open) return;
    void load();
    const tick = () => { void load(); timer.current = window.setTimeout(tick, s?.preparing ? 1000 : 2500); };
    timer.current = window.setTimeout(tick, 1000);
    return () => clearTimeout(timer.current);
  }, [open, s?.preparing]);

  if (!open) return null;
  const downloading = s?.models.filter((m) => m.downloading) ?? [];
  const needBytes = (s?.needs ?? []).reduce((sum, n) => sum + (n.bytes ?? 0), 0);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const pth = [...files].find((f) => /\.pth$/i.test(f.name));
    const idx = [...files].find((f) => /\.index$/i.test(f.name));
    if (!pth) { setMsg('要一个 .pth 文件（RVC 声音模型），.index 可以一起拖进来'); return; }
    setMsg(`正在导入 ${pth.name}……`);
    const up = (f: File, kind: string, id?: string) => fetch(`${BASE}/voice?kind=${kind}&name=${encodeURIComponent(f.name)}${id ? `&id=${id}` : ''}`, { method: 'POST', body: f }).then((r) => r.json());
    const a = await up(pth, 'model');
    if (!a.ok) { setMsg(`导入失败：${a.error}`); return; }
    if (idx) await up(idx, 'index', a.id);
    setMsg(`导入好了：${pth.name.replace(/\.pth$/i, '')}`);
    void load();
  };

  return (
    <div className="sl-modal sl-studio-wrap" onClick={onClose}>
      <div className="sl-studio" onClick={(e) => e.stopPropagation()}>
        <div className="sl-studio-head">
          <div>
            <div className="sl-studio-title">学歌设置</div>
            <div className="sl-studio-sub">{s ? (s.mode === 'manual' ? '用的是你自己的学歌环境（手动模式）' : s.ready ? '一切就绪，可以学歌了' : '还差几样，一键补上') : '……'}</div>
          </div>
          <button className="sl-ctl sl-small" onClick={onClose} title="关上"><Icon name="close" size={18} /></button>
        </div>

        {s && s.mode === 'recipe' ? (
          <>
            {!s.ready ? (
              <section className="sl-studio-card sl-studio-main">
                <div className="sl-studio-need">
                  {s.needs.map((n) => <div key={n.kind + (n.id ?? '')} className="sl-need"><span className={`sl-dot is-${n.kind}`} />{n.name}{n.bytes ? <em>{gb(n.bytes)}</em> : null}</div>)}
                </div>
                {s.needs.some((n) => n.kind !== 'voice') ? (
                  <button className="sl-btn sl-btn-primary sl-big" disabled={s.preparing} onClick={() => { void post('prepare', {}); setTimeout(load, 500); }}>
                    {s.preparing ? '正在准备……（可以关掉这里，后台继续）' : `一键准备（约 ${gb(needBytes)}，装在插件自己的目录里）`}
                  </button>
                ) : null}
                {s.prepareError ? <div className="sl-studio-err">没装成：{s.prepareError}。网络不好时再点一次会接着装。</div> : null}
                {s.preparing || s.env.steps.some((x) => x.state !== 'pending') ? (
                  <div className="sl-steps">
                    {s.env.steps.map((x) => (
                      <div key={x.id} className={`sl-step is-${x.state}`}>
                        <span className="sl-step-dot" />{x.name}
                        {x.detail ? <span className="sl-step-detail">{x.detail}</span> : null}
                      </div>
                    ))}
                    {downloading.map((m) => (
                      <div key={m.id} className="sl-step is-running">
                        <span className="sl-step-dot" />下载 {m.name}
                        <span className="sl-step-detail">{gb(m.downloading!.done)} / {gb(m.downloading!.total)}</span>
                        <div className="sl-job-bar"><i style={{ width: `${(m.downloading!.done / Math.max(1, m.downloading!.total)) * 100}%` }} /></div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {!s.mirror && s.needs.some((n) => n.kind === 'model') ? <div className="sl-studio-hint">国内模型镜像还没配置：部分模型要从 Hugging Face 下，国内网络可能下不动。已经有这些模型的话，可以在「高级 → 从电脑里已有的文件导入」。</div> : null}
              </section>
            ) : null}

            <section className="sl-studio-card">
              <div className="sl-studio-h">她的声音</div>
              {s.voices.length ? (
                <div className="sl-voices">
                  {s.voices.map((v) => (
                    <button key={v.id} className={`sl-voice ${v.id === s.voice ? 'is-on' : ''}`} onClick={() => { void post('voice-use', { id: v.id }).then(load); }}>
                      <Icon name="fish" size={16} /> {v.name}{v.index ? '' : <em> · 没有 .index</em>}
                    </button>
                  ))}
                </div>
              ) : <div className="sl-studio-sub">学歌要一个 RVC 声音模型（.pth，最好带上同名的 .index）。</div>}
              <label className="sl-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
                <input type="file" multiple accept=".pth,.index" onChange={(e) => void upload(e.target.files)} />
                把 .pth（和 .index）拖到这里，或者点这里选文件
              </label>
              {msg ? <div className="sl-studio-sub">{msg}</div> : null}
            </section>

            <button className="sl-adv-toggle" onClick={() => setAdvanced((v) => !v)}>{advanced ? '收起高级设置' : '高级设置：配方、模型货架'}</button>
            {advanced ? <Advanced s={s} reload={load} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Advanced({ s, reload }: { s: StudioState; reload: () => void }) {
  const [dir, setDir] = useState('');
  const [note, setNote] = useState('');
  const use = s.recipe.use as Record<string, unknown>;
  const setCustom = (patch: Record<string, unknown>) => void post('recipe', { id: 'custom', custom: { ...use, ...patch } }).then(reload);
  return (
    <>
      <section className="sl-studio-card">
        <div className="sl-studio-h">配方</div>
        <div className="sl-seg sl-recipes">
          {s.recipes.map((r) => <button key={r.id} className={s.recipe.id === r.id ? 'is-on' : ''} onClick={() => void post('recipe', { id: r.id }).then(reload)} title={r.note}>{r.name}</button>)}
          <button className={s.recipe.id === 'custom' ? 'is-on' : ''} onClick={() => setCustom({})}>自定义</button>
        </div>
        <div className="sl-studio-sub">{s.recipes.find((r) => r.id === s.recipe.id)?.note ?? '每一步自己选。'}</div>
        <div className="sl-chain">
          {s.steps.map((st, i) => {
            const options = s.models.filter((m) => m.step === st.id);
            const val = use[st.id];
            return (
              <div key={st.id} className="sl-link">
                <span className="sl-link-n">{i + 1}</span>
                <span className="sl-link-name">{st.name}{st.patch ? <em className="sl-patch">补丁</em> : null}</span>
                <span className="sl-link-ctl">
                  {st.id === 'pitch' ? (
                    <label className="sl-switch"><input type="checkbox" checked={!!val} onChange={(e) => setCustom({ pitch: e.target.checked })} /><i /></label>
                  ) : st.id === 'key' ? (
                    <select value={typeof val === 'number' ? 'fixed' : String(val)} onChange={(e) => setCustom({ key: e.target.value === 'fixed' ? 0 : e.target.value })}>
                      <option value="auto">自动挑她舒服的调</option>
                      <option value="none">不移调</option>
                      <option value="fixed">自己定</option>
                    </select>
                  ) : options.length ? (
                    <select value={val ? String(val) : ''} onChange={(e) => setCustom({ [st.id]: e.target.value || null })}>
                      {st.optional ? <option value="">关掉</option> : null}
                      {options.map((m) => <option key={m.id} value={m.id}>{m.name}{m.installed ? '' : `（要下 ${gb(m.bytes)}）`}</option>)}
                    </select>
                  ) : <span className="sl-link-fixed">{st.id === 'convert' ? 'RVC' : '—'}</span>}
                </span>
                {st.why ? <span className="sl-link-why">{st.why}</span> : null}
              </div>
            );
          })}
        </div>
      </section>
      <section className="sl-studio-card">
        <div className="sl-studio-h">模型货架</div>
        {s.models.map((m) => (
          <div key={m.id} className="sl-shelf-row">
            <div className="sl-shelf-text">
              <div className="sl-shelf-name">{m.name} <em>{gb(m.bytes)}</em></div>
              <div className="sl-shelf-note">{m.note} · {m.license}</div>
              {m.error ? <div className="sl-studio-err">{m.error}</div> : null}
            </div>
            {m.installed ? <span className="sl-shelf-ok">已下好</span>
              : m.downloading ? <span className="sl-shelf-ok">{Math.round((m.downloading.done / Math.max(1, m.downloading.total)) * 100)}%</span>
                : <button className="sl-btn" onClick={() => void post('model', { id: m.id }).then(reload)}>下载</button>}
          </div>
        ))}
        <div className="sl-import">
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="电脑里已经有这些模型？填文件夹路径，按文件名和校验自动认" />
          <button className="sl-btn" onClick={async () => { setNote('在找……'); const r = await post('import', { dirs: [dir] }); setNote(r.ok ? (r.imported.length ? `导入了 ${r.imported.length} 个` : '没找到对得上的文件') : r.error); reload(); }}>导入</button>
        </div>
        {note ? <div className="sl-studio-sub">{note}</div> : null}
      </section>
    </>
  );
}

/** 学歌没准备好时，点「学这首」弹出来的提示：一键准备 */
export function useLearnReady(): boolean {
  const engine = getEngine();
  return !engine.state.learnMissing;
}
