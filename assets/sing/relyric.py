#!/usr/bin/env python3
"""给一首学好的歌补 / 换歌词：拿一份歌词文本（网易云的某一版，或者用户贴的），逐字对到她唱的干声上，写进 song.json。
网易云那版的行首时间对不上（翻唱改了节奏）、或者网易云根本没有这版歌词时用。

    python relyric.py <歌目录> --netease <歌曲 id>      # 用网易云这一版的歌词文本（不用它的时间）
    python relyric.py <歌目录> --text <文本文件>         # 一行一句；也可以是 LRC（时间会被忽略）
    加 --timing lrc：不听词，用这份 LRC 自己的时间，整体平移对到起唱点（和学歌时一样）。
                     语音识别听不懂的歌（拉丁文圣咏之类）、翻唱和原版节奏一样时用。

要歌目录里有 edit/dry.flac（学的时候留下的干声）和 recipe.json（找 whisper 模型）。原来的 song.json 备份成 song.json.bak。
最后一行 JSON 写到 stdout：对上了多少。
"""

import argparse
import json
import re
import sys
from pathlib import Path

import librosa
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lyrics as L  # noqa: E402


def lines_of(text: str) -> list[str]:
    out = []
    for raw in text.splitlines():
        words = re.sub(r"\[[^\]]*\]", "", raw).strip()
        if not words or re.match(r"^[^:：]{1,10}\s*[:：]", words):   # 作词、作曲、编曲这类署名行
            continue
        out.append(words)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("song"); ap.add_argument("--netease", type=int); ap.add_argument("--text"); ap.add_argument("--whisper")
    ap.add_argument("--timing", choices=["whisper", "lrc"], default="whisper")
    ap.add_argument("--span", type=float, default=3, help="--timing lrc：整体平移最多几秒（翻唱和原版节奏一样时很小）")
    ap.add_argument("--offset", type=float, help="--timing lrc：直接给整体平移（秒），不自动找")
    a = ap.parse_args()
    d = Path(a.song)
    if a.netease:
        lrc = L.get(f"{L.API}/song/lyric?id={a.netease}&lv=1&tv=-1").get("lrc", {}).get("lyric", "")
        source = {"netease": a.netease}
    elif a.text:
        lrc = Path(a.text).read_text(encoding="utf-8")
        source = {"text": True}
    else:
        sys.exit("要 --netease 或 --text")
    y16 = librosa.load(d / "edit" / "dry.flac", sr=L.SR, mono=True)[0]
    if a.timing == "lrc":
        timed_lines = [l for l in L.parse_lrc(lrc) if l[0] < len(y16) / L.SR]
        if len(timed_lines) < 2:
            sys.exit("这份歌词没有带时间")
        f = L.features(y16, L.SR)
        # 按乐句起点对（停 0.3 秒以上之后又开口的地方）：连着唱的长音（圣咏、慢歌）音节起音很少，按起音对会乱撞
        v = np.asarray(f["voiced"], bool)
        quiet, phrase = 0, []
        for i, x in enumerate(v):
            if x and quiet >= 30:
                phrase.append(i)
            quiet = 0 if x else quiet + 1
        if a.offset is not None:
            off, hit = a.offset, None
        else:
            off, hit = L.fit(timed_lines, {**f, "rises": np.array(phrase)}, a.span)
        timed_lines = [l for l in timed_lines if l[0] + off < len(y16) / L.SR - 1]  # 平移后落到歌外面的行不要
        lyr = L.timed(timed_lines, off, f)
        report = {"found": True, "method": "lrc-time", "offsetSec": off, "hit": hit, "lines": len(timed_lines)}
    else:
        texts = lines_of(lrc)
        if len(texts) < 2:
            sys.exit("歌词是空的")
        whisper = a.whisper or json.loads((d / "recipe.json").read_text(encoding="utf-8"))["whisperModel"]
        heard = L.heard_units(y16, whisper, L.guess_language(texts))
        lyr, report = L.align(texts, heard)
    report.update(source)
    song_file = d / "song.json"
    song = json.loads(song_file.read_text(encoding="utf-8"))
    bak = d / "song.json.bak"
    if not bak.exists():
        bak.write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8")
    song["lyrics"], song["lyricsFrom"] = lyr, report
    song_file.write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
