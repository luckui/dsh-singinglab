#!/usr/bin/env python3
"""把一首歌做成歌曲包：分离、拆主唱、去混响、修音高、定调、RVC、节拍分析、混音。

一次处理一首，每步做完写一行 JSON 到 stdout，身体或人都能看进度：
    {"step": "separate", "state": "done", "sec": 22.1}

    python prepare.py --config sing.json --audio song.wav --out songs/<id> --title 歌名

中间文件留在 <out>/work，同一步已有结果就跳过；成功后删掉 work，只留 song.json、mix.mp3，
和修音页要用的 <out>/edit（干声、原人声、和声、伴奏、测到的和修过的音高；配置 keepEdit: false 就不留）。
配置见 sing.example.json。没配 karaoke、dereverb 就跳过这一步。
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

SR = 44100
TARGET_HZ = 351.0          # 她说话的中位音高
MOUTH_HZ = 25              # 张嘴曲线每秒多少个点
MIN_BARS = 4               # 段落最短多少小节
KEYS = range(-12, 20)      # 候选调，升降都试
# 她（plain200）唱每个音有多沙：沙帧（Praat HNR < 10 dB）占比，从 F#2（MIDI 42）起每个半音一格。
# 11-18 实测：Don't Cry、安眠药、24/7、我想要占据你等五首歌每首转 4–7 个调合起来；同一个音不管哪首歌哪个调都差不多沙。
# A#3–E5 干净，往下越低越沙，F5 往上崩。比表低按第一格、比表高按最后一格。换 RVC 模型要重测。
HOARSE_FROM = 42
HOARSE = (.68, .73, .68, .74, .57, .56, .39, .34, .24, .19, .24, .14, .16, .14, .14, .17, .10, .08, .07, .08, .05, .05,
          .05, .05, .04, .04, .04, .05, .03, .03, .04, .03, .04, .07, .06, .28, .56, .83, .97, .98, 1.0, .99, 1.0, 1.0)
EDGE = 5                   # 调只看主体：最高、最低各 5% 的音不算。个别极高极低的音不该把整首歌拖进沙的音区
NEAR = 0.01               # 和最好的分数差不到 1 个百分点的调算一样好，选离原调最近的


def emit(**event) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def run(cmd: list, cwd: str | None = None, env: dict | None = None) -> str:
    done = subprocess.run(cmd, cwd=cwd, env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "KMP_DUPLICATE_LIB_OK": "TRUE", **(env or {})},
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    if done.returncode != 0:
        raise RuntimeError(done.stdout[-800:])
    return done.stdout


def msst(cfg: dict, model: dict, source: Path, out: Path) -> Path:
    """跑一个 MSST 分离模型：入目录只放 source，返回出目录。"""
    inbox = out.with_name(out.name + "_in")
    shutil.rmtree(inbox, ignore_errors=True); shutil.rmtree(out, ignore_errors=True)
    inbox.mkdir(parents=True); out.mkdir(parents=True)
    shutil.copy(source, inbox / "a.wav")
    run([cfg["msstPython"], "inference.py", "--model_type", model["type"], "--config_path", model["config"], "--start_check_point", model["checkpoint"],
         "--input_folder", str(inbox), "--store_dir", str(out)], cwd=cfg["msstDir"])
    return out


def pick(folder: Path, *names: str) -> Path:
    for path in folder.rglob("*.wav"):
        if path.stem.lower() in names:
            return path
    raise RuntimeError(f"{folder} 里没有 {names}: {[p.name for p in folder.rglob('*.wav')]}")


def analyze_singing(vocal: np.ndarray) -> dict:
    """唱得稳不稳：稳定音占浊音的比例。只记录：快歌、电音人声分数也低，是不是歌由模型看标题判断。"""
    y = librosa.resample(vocal, orig_sr=SR, target_sr=16000)
    hop = 320
    f0 = librosa.yin(y, fmin=90, fmax=1000, sr=16000, frame_length=1024, hop_length=hop)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0][: len(f0)]
    voiced = rms > max(float(np.percentile(rms, 95)) * 0.1, 1e-4)
    midi = 69 + 12 * np.log2(np.maximum(f0, 1) / 440)
    stable = np.abs(np.diff(midi, prepend=midi[0])) < 0.5
    run_len = 0
    held = np.zeros(len(f0), dtype=bool)
    for i in range(len(f0)):                              # 同一个音连续 200ms 以上才算“唱住了”
        run_len = run_len + 1 if voiced[i] and stable[i] else 0
        if run_len >= 10:
            held[i - run_len + 1: i + 1] = True
    score = float(held.sum() / max(1, voiced.sum()))
    return {"score": round(score, 3), "vocalRatio": round(float(voiced.mean()), 3)}


def sung_f0(vocal: np.ndarray) -> np.ndarray:
    """没有修好的音高（没拆和声、修音高出错）时自己测：pyin，20 ms 一帧"""
    y = librosa.resample(vocal, orig_sr=SR, target_sr=16000)
    f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=1100, sr=16000, frame_length=1024, hop_length=320, fill_na=0.0)
    # 不按把握筛：低沉粗糙的低音把握普遍很低（升本后醒来：200 Hz 以下平均 0.12），筛掉就只剩高音
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=320)[0][: len(f0)]
    return f0[voiced & (rms > max(float(np.percentile(rms, 95)) * 0.1, 1e-4))]


def choose_key(f0: np.ndarray) -> tuple[int, float, dict]:
    """每个候选调：主体（去掉最高最低各 EDGE%）的每个音查 HOARSE 表，分数 = 平均沙，越低越好。
    差不到 NEAR 的算一样好，选离原调最近的。返回 调、原唱中位音高、每个调的分数。"""
    sung = f0[f0 > 0]
    if not len(sung):
        return 0, TARGET_HZ, {}
    notes = 12 * np.log2(sung / 440) + 69
    lo, hi = np.percentile(notes, [EDGE, 100 - EDGE])
    notes = np.round(notes[(notes >= lo) & (notes <= hi)]).astype(int)
    table = np.array(HOARSE)
    scores = {k: float(table[np.clip(notes + k - HOARSE_FROM, 0, len(table) - 1)].mean()) for k in KEYS}
    best = min(scores.values())
    key = min((k for k in KEYS if scores[k] <= best + NEAR), key=abs)
    return key, float(np.median(sung)), {str(k): round(v, 3) for k, v in scores.items()}


def backing_shift(key: int) -> int:
    """伴奏只移不到八度的那部分，挑移得少的方向（+17 → +5，+19 → -5，-3 → -3）：差整八度她照样在调上"""
    return (key + 6) % 12 - 6


def shift_backing(path: Path, key: int) -> None:
    """不是八度时伴奏跟着移：Rubber Band，听感比原版薄一点，所以排在八度后面"""
    from pedalboard import Pedalboard, PitchShift
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    sf.write(path, Pedalboard([PitchShift(semitones=key)])(y.T, sr).T, sr, subtype="PCM_16")


def rvc(cfg: dict, source: Path, out: Path, key: int, plan: Path | None) -> None:
    run([cfg["rvcPython"], str(Path(__file__).with_name("rvc_convert.py")), "--applio", cfg["applioDir"], "--model", cfg["rvcModel"], "--index", cfg.get("rvcIndex", ""),
         "--input", str(source), "--output", str(out), "--key", str(key), "--index-rate", str(cfg.get("indexRate", 0.3)), "--protect", str(cfg.get("protect", 0.33)),
         *(["--f0-npy", str(plan)] if plan else [])])


def pitch_fix(cfg: dict, dry: Path, vocals: Path, back: Path, out: Path) -> dict:
    """干声音高里被和声拉低一个八度的地方升回去（pitch_fix.py），返回每一层改了多少。原始测量存在 out 旁边的 raw.npy"""
    text = run([cfg["rvcPython"], str(Path(__file__).with_name("pitch_fix.py")), "--applio", cfg["applioDir"],
                "--dry", str(dry), "--vocals", str(vocals), "--back", str(back), "--out", str(out), "--raw-out", str(out.with_name("raw.npy"))])
    return json.loads([line for line in text.splitlines() if line.startswith("{")][-1])


def beats_of(inst: np.ndarray) -> dict:
    y = librosa.resample(inst, orig_sr=SR, target_sr=22050)
    tempo, frames = librosa.beat.beat_track(y=y, sr=22050, units="time")
    beats = [round(float(t), 3) for t in frames]
    return {"bpm": round(float(np.atleast_1d(tempo)[0]), 1), "beats": beats, "downbeats": beats[::4]}


def sections_of(mix: np.ndarray, downbeats: list[float]) -> list[dict]:
    """按小节算响度分三档：响度先按 4 小节平滑，短于 MIN_BARS 的段并进前一段，舞台不会一直闪。"""
    if len(downbeats) < 2:
        return []
    edges = [0.0, *downbeats, len(mix) / SR]
    energy = np.array([math.sqrt(float(np.mean(mix[int(a * SR):max(int(a * SR) + 1, int(b * SR))] ** 2))) for a, b in zip(edges, edges[1:])])
    energy = np.convolve(np.pad(energy, 2, mode="edge"), np.ones(5) / 5, "valid")
    low, high = np.percentile(energy, 25), np.percentile(energy, 70)
    kinds = ["chorus" if e >= high else "quiet" if e <= low else "verse" for e in energy]
    runs: list[dict] = []
    for i, kind in enumerate(kinds):
        if runs and runs[-1]["kind"] == kind:
            runs[-1]["bars"] += 1
        else:
            runs.append({"kind": kind, "start": i, "bars": 1})
    merged: list[dict] = []
    for run_ in runs:
        if merged and (run_["bars"] < MIN_BARS or merged[-1]["kind"] == run_["kind"]):
            merged[-1]["bars"] += run_["bars"]
        else:
            merged.append(run_)
    return [{"startSec": round(edges[m["start"]], 3), "endSec": round(edges[m["start"] + m["bars"]], 3), "kind": m["kind"]} for m in merged]


def mix_song(cover: Path, inst: Path, back: Path | None, out: Path) -> None:
    """她的声音 + 伴奏 + 和声 → mix.mp3（伴奏、和声要已经移好调）"""
    inputs = ["-i", str(cover), "-i", str(inst)]
    graph = "[0:a]aresample=44100,loudnorm=I=-16:TP=-2:LRA=11,aformat=channel_layouts=stereo[v];[1:a]volume=0.6[b];"
    if back and back.exists():
        inputs += ["-i", str(back)]
        graph += "[2:a]volume=0.4[h];[v][b][h]amix=inputs=3:duration=longest:normalize=0,alimiter=limit=0.95[m]"
    else:
        graph += "[v][b]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[m]"
    run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[m]", "-c:a", "libmp3lame", "-q:a", "2", str(out)])


def keep_edit(work: Path, out: Path, key: int, scores: dict) -> None:
    """修音页要用的：学歌每一步的分轨（原曲、伴奏、人声、主唱、和声、干声，看频谱、对比着听）、没移调的伴奏、测到的和修过的音高。干声无损（重新转她的声音用）"""
    edit = out / "edit"; edit.mkdir(parents=True, exist_ok=True)
    mp3 = lambda src, dst: run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-c:a", "libmp3lame", "-q:a", "2", str(dst)])
    run(["ffmpeg", "-v", "error", "-y", "-i", str(work / "dry.wav"), "-ac", "1", "-c:a", "flac", str(edit / "dry.flac")])
    mp3(work / "mix.wav", edit / "orig.mp3")        # 原曲（B 站取下来的，截到最长时长）
    mp3(work / "vocals.wav", edit / "vocals.mp3")    # 去掉伴奏：人声（含和声）
    mp3(work / "inst.wav", edit / "inst.mp3")        # 伴奏
    if (work / "lead.wav").exists():
        mp3(work / "lead.wav", edit / "lead.mp3")    # 去掉和声：主唱（还没去混响）
    if (work / "back.wav").exists():
        mp3(work / "back.wav", edit / "back.mp3")
    for name in ("raw.npy", "pitch.npy"):
        if (work / name).exists():
            shutil.copy(work / name, edit / ("plan.npy" if name == "pitch.npy" else name))
    (edit / "edit.json").write_text(json.dumps({"format": 1, "autoKey": key, "key": key, "keyScores": scores, "ops": []}, ensure_ascii=False), encoding="utf-8")


def mouth_of(vocal: np.ndarray) -> list[float]:
    hop = SR // MOUTH_HZ
    rms = librosa.feature.rms(y=vocal, frame_length=hop * 2, hop_length=hop)[0]
    top = float(np.percentile(rms, 95)) or 1.0
    return [round(float(v), 2) for v in np.clip(rms / top, 0, 1)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True); ap.add_argument("--audio", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--title", default=""); ap.add_argument("--artist", default=""); ap.add_argument("--source", default=""); ap.add_argument("--who", default="")
    ap.add_argument("--max-sec", type=float, default=360); ap.add_argument("--key", type=int)
    ap.add_argument("--meta", help="JSON 文件：title、artist、source、who（远程学歌用，避开命令行转义）")
    a = ap.parse_args()
    if a.meta:
        for k, v in json.loads(Path(a.meta).read_text(encoding="utf-8")).items():
            setattr(a, k, v)
    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    out = Path(a.out); work = out / "work"; work.mkdir(parents=True, exist_ok=True)
    times: dict[str, float] = {}

    def step(name: str, target: Path, fn) -> Path:
        if target.exists():
            emit(step=name, state="cached"); return target
        emit(step=name, state="start")
        t = time.time(); fn()
        times[name] = round(time.time() - t, 1)
        emit(step=name, state="done", sec=times[name]); return target

    mix_path = work / "mix.wav"
    step("load", mix_path, lambda: run(["ffmpeg", "-v", "error", "-y", "-i", a.audio, "-t", str(a.max_sec), "-ac", "2", "-ar", str(SR), str(mix_path)]))

    voc_path = work / "vocals.wav"
    step("separate", voc_path, lambda: shutil.copy(pick(msst(cfg, cfg["separator"], mix_path, work / "sep"), "vocals"), voc_path))
    vocal = librosa.load(voc_path, sr=SR, mono=True)[0]
    gate = analyze_singing(vocal)
    emit(step="gate", state="done", **gate)

    lead_path, back_path = work / "lead.wav", work / "back.wav"
    if cfg.get("karaoke"):
        def karaoke() -> None:
            done = msst(cfg, cfg["karaoke"], voc_path, work / "kar")
            shutil.copy(pick(done, "instrumental", "other"), back_path)
            shutil.copy(pick(done, "vocals"), lead_path)
        step("karaoke", lead_path, karaoke)
    else:
        shutil.copy(voc_path, lead_path)

    dry_path = work / "dry.wav"
    if cfg.get("dereverb"):
        step("dereverb", dry_path, lambda: shutil.copy(pick(msst(cfg, cfg["dereverb"], lead_path, work / "drv"), "noreverb"), dry_path))
    else:
        shutil.copy(lead_path, dry_path)

    dry = librosa.load(dry_path, sr=SR, mono=True)[0]
    # 歌词：网易云按歌名找，语音识别核对是不是这首，对齐到干声，给舞台的文字 PV 用。找不到、对不上都只是没字幕，不影响学歌
    t = time.time()
    try:
        import lyrics as lyric_finder
        if not cfg.get("whisperModel"):
            raise RuntimeError("sing.json 没配 whisperModel，核对不了是不是这首歌的词")
        y16 = librosa.resample(dry, orig_sr=SR, target_sr=lyric_finder.SR)
        lines, found = lyric_finder.pick(a.title, lyric_finder.features(y16, lyric_finder.SR), lyric_finder.transcribe(y16, cfg["whisperModel"]))
    except Exception as err:
        lines, found = [], {"found": False, "reason": f"{type(err).__name__}: {err}"[:200]}
    times["lyrics"] = round(time.time() - t, 1)
    emit(step="lyrics", state="done", lines=len(lines), **found)
    # 修音高要和声轨判断有没有第二个声部，没拆主唱和声就不修
    plan_path, fixed = work / "pitch.npy", {}
    if back_path.exists() and cfg.get("pitchFix", True):
        try:
            step("pitch", plan_path, lambda: fixed.update(pitch_fix(cfg, dry_path, voc_path, back_path, plan_path)))
        except RuntimeError as err:  # 修音高出错就按测到的音高唱，不能让整首歌学不成
            plan_path.unlink(missing_ok=True)
            fixed = {"error": str(err)[-300:]}
            emit(step="pitch", state="skipped", reason=fixed["error"])
        if fixed and "error" not in fixed:
            emit(step="pitch", state="report", **fixed)
    # 定调放在修音高后面：用修好的音高算她每个调要唱的音；没有就自己测
    if a.key is not None:
        key, median, scores = a.key, 0.0, {}
    elif plan_path.exists():
        key, median, scores = choose_key(np.load(plan_path))
    else:
        key, median, scores = choose_key(sung_f0(dry))
    emit(step="key", state="done", key=key, medianHz=round(median), score=scores.get(str(key)))
    # 学崩了就不往下做：报一句原因（插件原样交给她），非 0 退出，不写 song.json
    import quality
    checked = quality.measure(work, np.load(plan_path) if plan_path.exists() else None)
    broken = quality.verdict(checked, sf.info(str(mix_path)).duration)
    if broken:
        emit(step="quality", state="failed", reason=broken, **checked)
        sys.exit(1)
    emit(step="quality", state="done", **checked)
    cv_path = work / "cover.wav"
    step("rvc", cv_path, lambda: rvc(cfg, dry_path, cv_path, key, plan_path if plan_path.exists() else None))

    mix, _ = sf.read(mix_path, dtype="float32"); voc, _ = sf.read(voc_path, dtype="float32")
    n = min(len(mix), len(voc))
    inst_path = work / "inst.wav"
    sf.write(inst_path, mix[:n] - voc[:n], SR, subtype="PCM_16")
    # 移调之前把修音页要的存下来（伴奏、和声都是原调的）
    if cfg.get("keepEdit", True):
        keep_edit(work, out, key, scores)
    if backing_shift(key):
        shift_backing(inst_path, backing_shift(key))
        if back_path.exists():
            shift_backing(back_path, backing_shift(key))
    t = time.time()
    mono = mix[:n].mean(1)
    rhythm = beats_of((mix[:n] - voc[:n]).mean(1))
    sections = sections_of(mono, rhythm["downbeats"])
    mouth = mouth_of(librosa.load(cv_path, sr=SR, mono=True)[0])
    times["analyze"] = round(time.time() - t, 1); emit(step="analyze", state="done", sec=times["analyze"], bpm=rhythm["bpm"])

    t = time.time()
    mix_song(cv_path, inst_path, back_path, out / "mix.mp3")
    times["mix"] = round(time.time() - t, 1); emit(step="mix", state="done", sec=times["mix"])

    song = {"format": 1, "title": a.title, "artist": a.artist, "source": a.source, "who": a.who, "durationSec": round(n / SR, 2), "keyShift": key, "keyScores": scores, "quality": checked, "pitchFix": fixed, "model": Path(cfg["rvcModel"]).stem,
            **rhythm, "sections": sections, "lyrics": lines, "lyricsFrom": found, "mouthHz": MOUTH_HZ, "mouth": mouth, "singingScore": gate["score"], "timings": times}
    (out / "song.json").write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8")
    if not cfg.get("keepWork"):
        shutil.rmtree(work, ignore_errors=True)
    emit(step="done", state="done", total=round(sum(times.values()), 1), out=str(out))


if __name__ == "__main__":
    main()
