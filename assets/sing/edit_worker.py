#!/usr/bin/env python3
"""修音页的常驻进程：声音模型只加载一次，之后渲染一句不到一秒（5090 实测 5 秒的一句 0.3 秒）。
用 RVC 环境的 Python 跑，插件宿主端按需启动、闲了就关。

一行一个 JSON 进，一行一个 JSON 出：
    → {"id": 1, "cmd": "spec", "dir": "<歌>/edit", "layer": "vocals"}
    ← {"id": 1, "ok": true, "file": "<歌>/edit/spec-vocals.png"}

命令（dir 都是一首歌的 edit 目录，cfg 是学这首歌时的配置 recipe.json / sing.json 的路径）：
    info    {dir}                          帧数、时长；没有测到的音高（raw.npy）就现测一份
    warm    {dir, cfg, key}                打开修音页时在后台先加载声音模型、移好伴奏：第一句试听不用等
    spec    {dir, layer}                   频谱图 PNG：vocals 原人声（含和声）/ dry 主唱干声 / back 和声。纵轴按半音（MIDI 36–96，每半音 3 格）
    accomp  {dir, key}                     伴奏 + 和声，移到这个调（只移不到八度那部分，和学歌时一样），mp3
    phrase  {dir, cfg, start, end, f0, key}   只渲染这一句（前后各多 0.6 秒）她的声音 + 伴奏，wav
    save    {dir, cfg, f0, key}            整首重新转她的声音、重新混音，换掉 mix.mp3，song.json 记下新的调

f0：10 ms 一帧的音高（Hz，0 = 不唱），没移调之前的；key 是整首升几个半音（RVC 再移）。用 base64 的 float32 传。
"""

import base64
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import prepare as P  # noqa: E402  SR、backing_shift、shift_backing、mix_song、mouth_of

SR16 = 16000
HOP = 160            # 10 ms
PAD = 0.6            # 渲染一句时前后多带的秒数：RVC 需要一点上下文，边上才不发虚
VOICE_RMS_DB = -17.0  # 试听时她的音量（有声部分的 RMS）；整首保存走 loudnorm，和学歌时一样

_applio = {"dir": None, "core": None}
_plan = {"f0": None}
_cache: dict = {}


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def f0_of(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype=np.float32).astype(np.float64)


def applio(cfg: dict):
    """Applio 只导入一次；RMVPE 的测音高换成「有给定音高就用给定的」"""
    if _applio["core"] is None:
        d = cfg["applioDir"]
        os.chdir(d); sys.path.insert(0, d)
        import core  # noqa: E402
        from rvc.lib.predictors import f0 as f0mod  # noqa: E402
        measure = f0mod.RMVPE.get_f0

        def planned(self, x, *a, **k):
            own = measure(self, x, *a, **k)
            plan = _plan["f0"]
            if plan is None:
                return own
            pad = max(0, (len(own) - len(plan)) // 2)  # 流水线两头各补了一样长
            full = np.zeros(len(own))
            m = min(len(plan), len(own) - pad)
            full[pad:pad + m] = plan[:m]
            return np.where(full > 0, full, own)

        f0mod.RMVPE.get_f0 = planned
        _applio.update(dir=d, core=core)
    return _applio["core"]


def voice(cfg: dict):
    core = applio(cfg)
    vc = core.import_voice_converter()
    vc.get_vc(cfg["rvcModel"], 0)  # 同一个模型不会重复加载
    if not vc.hubert_model:
        vc.load_hubert("contentvec", None)
        vc.last_embedder_model = "contentvec"
    return vc


def render(cfg: dict, y16: np.ndarray, plan: np.ndarray, key: int) -> tuple[np.ndarray, int]:
    """一段干声（16 kHz）按给定音高转成她的声音"""
    vc = voice(cfg)
    s = np.abs(y16).max() / 0.95
    x = (y16 / s if s > 1 else y16).astype(np.float32)
    index = cfg.get("rvcIndex", "") or ""
    _plan["f0"] = plan
    try:
        out = vc.vc.pipeline(model=vc.hubert_model, net_g=vc.net_g, sid=0, audio=x, pitch=int(key), f0_method="rmvpe", file_index=index,
                             index_rate=float(cfg.get("indexRate", 0.3)) if index else 0, pitch_guidance=vc.use_f0, volume_envelope=0.25,
                             version=vc.version, protect=float(cfg.get("protect", 0.33)), f0_autotune=False, f0_autotune_strength=1.0,
                             proposed_pitch=False, proposed_pitch_threshold=155.0)
    finally:
        _plan["f0"] = None
    out = np.asarray(out)
    if out.dtype == np.int16:
        out = out.astype(np.float32) / 32768.0
    return out.astype(np.float32), int(vc.tgt_sr)


def dry16(d: Path) -> np.ndarray:
    k = ("dry16", str(d))
    if k not in _cache:
        _cache[k] = librosa.load(d / "dry.flac", sr=SR16, mono=True)[0].astype(np.float32)
    return _cache[k]


def info(d: Path, cfg_path: str | None = None) -> dict:
    y = dry16(d)
    raw = d / "raw.npy"
    if not raw.exists():
        # 没拆和声的配方没有 pitch_fix 那一步：这里现测一份（和 pitch_fix.py 一样用 RMVPE）
        cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8")) if cfg_path else None
        if cfg:
            applio(cfg)
        from rvc.lib.predictors.f0 import RMVPE  # noqa: E402
        import torch  # noqa: E402
        s = np.quantile(np.abs(y), 0.999)
        f = RMVPE(device="cuda" if torch.cuda.is_available() else "cpu", sample_rate=SR16, hop_size=HOP).get_f0(y / s if s > 0 else y, filter_radius=0.03)
        np.save(raw, f)
    return {"frames": int(len(np.load(raw))), "durationSec": round(len(y) / SR16, 3)}


LAYERS = {"vocals": "vocals.mp3", "dry": "dry.flac", "back": "back.mp3"}


def spec(d: Path, layer: str) -> dict:
    out = d / f"spec-{layer}.png"
    if not out.exists():
        src = d / LAYERS[layer]
        if not src.exists():
            raise RuntimeError(f"这首没有「{layer}」这一轨")
        y = librosa.load(src, sr=SR16, mono=True)[0]
        C = np.abs(librosa.cqt(y, sr=SR16, hop_length=HOP, fmin=librosa.midi_to_hz(36), n_bins=180, bins_per_octave=36))
        db = librosa.amplitude_to_db(C, ref=np.max)
        v = np.clip((db + 72) / 72, 0, 1)[::-1]  # 高音在上
        from matplotlib import colormaps  # noqa: E402
        from PIL import Image  # noqa: E402
        rgba = (colormaps["magma"](v) * 255).astype(np.uint8)
        rgba[..., 3] = (np.power(v, 0.9) * 255).astype(np.uint8)  # 安静的地方透明，叠在深色底上
        tmp = out.with_suffix(".tmp.png")
        Image.fromarray(rgba, "RGBA").save(tmp, optimize=True)
        tmp.replace(out)
    return {"file": str(out), "bins": 180, "midiLow": 36, "binsPerSemitone": 3}


def load44(path: Path) -> np.ndarray:
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    if sr != P.SR:
        y = librosa.resample(y.T, orig_sr=sr, target_sr=P.SR).T
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    return y


def _get_acc(d: Path, bs: int, key: int) -> np.ndarray:
    k = ("acc", str(d), bs)
    if k not in _cache:
        inst = load44(d / "inst.mp3") * 0.6
        if (d / "back.mp3").exists():
            back = load44(d / "back.mp3") * 0.4
            n = max(len(inst), len(back))
            inst = np.pad(inst, ((0, n - len(inst)), (0, 0))) + np.pad(back, ((0, n - len(back)), (0, 0)))
        if bs:
            from pedalboard import Pedalboard, PitchShift  # noqa: E402
            inst = Pedalboard([PitchShift(semitones=bs)])(inst.T, P.SR).T
        for old in [x for x in _cache if x[0] == "acc" and x[1] == str(d)]:
            del _cache[old]  # 一首歌只留一个调的伴奏在内存里
        _cache[k] = inst.astype(np.float32)
    return _cache[k]


def accomp(d: Path, key: int) -> dict:
    bs = P.backing_shift(int(key))
    out = d / f"accomp{bs:+d}.mp3"
    if not out.exists():
        y = _get_acc(d, bs, key)
        tmp = d / f"accomp{bs:+d}.tmp.wav"
        sf.write(tmp, np.clip(y, -1, 1), P.SR, subtype="PCM_16")
        P.run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp), "-c:a", "libmp3lame", "-q:a", "3", str(out)])
        tmp.unlink(missing_ok=True)
    return {"file": str(out), "shift": bs}


def to44(y: np.ndarray, sr: int) -> np.ndarray:
    return librosa.resample(y, orig_sr=sr, target_sr=P.SR) if sr != P.SR else y


def phrase(d: Path, cfg_path: str, start: float, end: float, f0: np.ndarray, key: int) -> dict:
    cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    y = dry16(d)
    dur = len(y) / SR16
    a, b = max(0.0, start - PAD), min(dur, end + PAD)
    t = time.time()
    voc, sr = render(cfg, y[int(a * SR16):int(b * SR16)], f0[int(a * 100):int(b * 100)], key)
    voc = to44(voc, sr)
    took = time.time() - t
    active = voc[np.abs(voc) > 0.01]
    if len(active):
        voc = voc * (10 ** (VOICE_RMS_DB / 20) / max(float(np.sqrt(np.mean(active ** 2))), 1e-4))
    acc = _get_acc(d, P.backing_shift(int(key)), key)[int(a * P.SR):int(b * P.SR)]
    n = min(len(acc), len(voc))
    mix = acc[:n] + voc[:n, None]
    peak = float(np.abs(mix).max())
    if peak > 0.95:
        mix *= 0.95 / peak
    fade = int(0.02 * P.SR)
    ramp = np.linspace(0, 1, fade)[:, None]
    mix[:fade] *= ramp; mix[-fade:] *= ramp[::-1]
    out = d / "phrase.wav"
    sf.write(out, mix, P.SR, subtype="PCM_16")
    return {"file": str(out), "start": round(a, 3), "end": round(a + n / P.SR, 3), "renderSec": round(took, 2)}


def warm(d: Path, cfg_path: str, key: int) -> dict:
    voice(json.loads(Path(cfg_path).read_text(encoding="utf-8")))
    _get_acc(d, P.backing_shift(int(key)), key)
    dry16(d)
    return {}


def save(d: Path, cfg_path: str, f0: np.ndarray, key: int) -> dict:
    """整首重新转她的声音，和试听用的同一份伴奏（已经移好调、按学歌时的音量混好和声）混在一起。
    中间文件放本机临时目录：歌库常在 Windows 盘上（WSL 里读写很慢）"""
    cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    song_dir = d.parent
    t = time.time()
    voc, sr = render(cfg, dry16(d), f0, key)
    work = Path(tempfile.mkdtemp(prefix="singinglab-save-"))
    try:
        cover = work / "cover.wav"
        sf.write(cover, voc, sr, subtype="PCM_16")
        acc = work / "acc.wav"
        sf.write(acc, np.clip(_get_acc(d, P.backing_shift(int(key)), key), -1, 1), P.SR, subtype="PCM_16")
        tmp = work / "mix.mp3"
        graph = ("[0:a]aresample=44100,loudnorm=I=-16:TP=-2:LRA=11,aformat=channel_layouts=stereo[v];"
                 "[v][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[m]")  # 和 prepare.mix_song 一样，伴奏 0.6、和声 0.4 已经乘过了
        P.run(["ffmpeg", "-v", "error", "-y", "-i", str(cover), "-i", str(acc), "-filter_complex", graph, "-map", "[m]", "-c:a", "libmp3lame", "-q:a", "2", str(tmp)])
        shutil.copy(tmp, song_dir / "mix.mp3.new")
        (song_dir / "mix.mp3.new").replace(song_dir / "mix.mp3")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    song_file = song_dir / "song.json"
    song = json.loads(song_file.read_text(encoding="utf-8"))
    song["keyShift"] = int(key)
    song["mouth"] = P.mouth_of(to44(voc, sr))
    song["editedAt"] = int(time.time() * 1000)
    song_file.write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8")
    return {"sec": round(time.time() - t, 1), "editedAt": song["editedAt"]}


def handle(msg: dict) -> dict:
    cmd, d = msg["cmd"], Path(msg.get("dir", "."))
    if cmd == "hello":
        import torch  # noqa: E402
        return {"device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"}
    if cmd == "info":
        return info(d, msg.get("cfg"))
    if cmd == "spec":
        return spec(d, msg["layer"])
    if cmd == "warm":
        return warm(d, msg["cfg"], int(msg.get("key", 0)))
    if cmd == "accomp":
        return accomp(d, int(msg.get("key", 0)))
    if cmd == "phrase":
        return phrase(d, msg["cfg"], float(msg["start"]), float(msg["end"]), f0_of(msg["f0"]), int(msg.get("key", 0)))
    if cmd == "save":
        return save(d, msg["cfg"], f0_of(msg["f0"]), int(msg.get("key", 0)))
    raise RuntimeError(f"不认识的命令 {cmd}")


def main() -> None:
    out = sys.stdout
    sys.stdout = sys.stderr  # Applio、librosa 打印的东西都去 stderr，stdout 只走回复
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        try:
            reply = {"id": msg.get("id"), "ok": True, **handle(msg)}
        except Exception as err:  # noqa: BLE001
            log(traceback.format_exc())
            reply = {"id": msg.get("id"), "ok": False, "error": f"{type(err).__name__}: {err}"[:400]}
        out.write(json.dumps(reply, ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
