#!/usr/bin/env python3
"""学歌学崩了没有：只用学歌过程中已经有的音轨，量三个信号。

    voiceDb    分离出的人声比原曲低多少 dB（整首的能量比）。分离几乎没找到人声时很低。
    leadLost   人声在唱的时候，拆和声后主唱轨比人声低 10 dB 以上的比例 = 主唱被当成和声拆走了多少。
    pitchCover 人声在唱的时候，干声上 RMVPE 测得到音高的比例。合唱、喊、噪音多时很低，她就没有音可以跟。

“人声在唱” = 人声轨这一帧（100 ms）比它自己最响的 5% 低不到 30 dB。
单独跑：python quality.py <work 目录> [plan.npy 或 f0.npy]   打印一行 JSON。
"""

import json
import sys
from pathlib import Path

import librosa
import numpy as np

HOP = 1600  # 16 kHz 下 100 ms


def level_db(path: Path) -> np.ndarray:
    y = librosa.load(path, sr=16000, mono=True)[0]
    return 20 * np.log10(librosa.feature.rms(y=y, frame_length=HOP, hop_length=HOP)[0] + 1e-9)


def measure(work: Path, f0: np.ndarray | None) -> dict:
    mix, voc = level_db(work / "mix.wav"), level_db(work / "vocals.wav")
    n = min(len(mix), len(voc))
    mix, voc = mix[:n], voc[:n]
    power = lambda d: 10 * np.log10(np.mean(10 ** (d / 10)))
    sing = voc > np.percentile(voc, 95) - 30
    out = {"voiceDb": round(float(power(voc) - power(mix)), 1), "singingSec": round(float(sing.sum()) / 10, 1)}
    if (work / "lead.wav").exists():
        lead = level_db(work / "lead.wav")[:n]
        out["leadLost"] = round(float(np.mean((lead - voc[:len(lead)])[sing[:len(lead)]] < -10)), 3)
    if f0 is not None:
        voiced = f0 > 0  # 10 ms 一帧 → 每 10 帧并成 100 ms，过半有音高算这一格测到了
        m = min(len(voiced) // 10, n)
        cover = voiced[:m * 10].reshape(m, 10).mean(1) > 0.5
        out["pitchCover"] = round(float(cover[sing[:m]].mean()), 3) if sing[:m].any() else 0.0
    return out


# 学崩门槛（11-18 实验机上 40 多个学歌目录实测）：
#   манго нектар 学崩：人声只占整首 21%（其余正常的歌 ≥ 56%），voiceDb -15、leadLost 0.54
#   红军最强大（整条合唱）拆主唱：leadLost 1.00、pitchCover 0.08；正常的歌 leadLost ≤ 0.29（换模型拆过的有 0.54）、pitchCover ≥ 0.65
#   voiceDb 不用：安眠药人声轻，-12.1 dB 也是好好的
MIN_SING_SHARE = 0.35
MAX_LEAD_LOST = 0.6
MIN_PITCH_COVER = 0.3


def verdict(m: dict, duration_sec: float) -> str | None:
    """学崩了就返回一句直白的原因（交给她说），没崩返回 None"""
    share = m["singingSec"] / max(duration_sec, 1)
    if share < MIN_SING_SHARE:
        return f"人声和伴奏没分开，分出来的人声只占整首的 {share:.0%}，学出来大部分是走样的"
    if m.get("leadLost", 0) > MAX_LEAD_LOST:
        return "拆主唱时几乎整首都被当成了和声（多半是合唱或叠唱），没有主唱可以学"
    if m.get("pitchCover", 1) < MIN_PITCH_COVER:
        return "干声里大部分时候测不出音高（多半是合唱、喊叫或噪音太多），没有音可以跟"
    return None


if __name__ == "__main__":
    f0 = np.load(sys.argv[2]) if len(sys.argv) > 2 else None
    print(json.dumps(measure(Path(sys.argv[1]), f0)))
