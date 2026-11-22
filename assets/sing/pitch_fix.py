#!/usr/bin/env python3
"""修干声的音高，给 RVC 用。只修一种错：几个人差一个八度一起唱时，RMVPE 会被拉到低八度，她就跟着唱低、听着哑。
只升不降，每一帧最多比 RMVPE 原始测量高一个八度。单独成进程，用 RVC 环境的 Python（要用 Applio 的 RMVPE）。

    python pitch_fix.py --applio <Applio 目录> --dry dry.wav --vocals vocals.wav --back back.wav --out plan.npy

plan.npy：10 ms 一帧的音高（Hz，0 = 没音高），对齐干声；rvc_convert.py --f0-npy 用它代替 RVC 自己测的。
最后一行 JSON 写到 stdout：每一层改了多少。

几层按顺序：
  第二声部  和声轨比整条人声低多少 dB。八度错误只出在有第二个声部的地方：低 45 dB 以上 = 只有一个人在唱，三层都不升。
            （蜂与你：真错误处 4–31 dB；主人确认是对的地方 61–75 dB）
            而且干声里得是高八度的人占上风：低八度的人自己唱主唱、和声在他上面时（对唱、Don't Cry 的高八度伴唱），
            干声的奇数次谐波是满的，这些音也算没有第二声部（low_is_lead）。
  窗口规则  音符内乱跳：0.5 秒里八度跳 ≥2 次、窗口里出现过高一个八度的帧 → 这个音下面那层升上去（一个音要么整个升，要么不动）。
  重复对照  整个音落错八度：整首按 2.5 秒的窗口找重复（整条人声的音级特征，subsequence DTW），
            这一段比最像的几处（代价不超过最像那处的 2 倍）对应位置低一个八度左右、持续 ≥150 ms → 升。
  末层填平  前面几层修完还剩的短时掉八度（≤150 ms、比前后都低 9–15 个半音）→ 升。
  不拆断    总检查：升上去的一片，紧挨着的帧没升、而原始测量在交界处是连着的（差不到 2 个半音）→ 这一升凭空造出八度跳，整片恢复。
"""

import argparse
import json
import os
import sys

import librosa
import numpy as np
from scipy.ndimage import minimum_filter1d

BACK_DB = 45.0
ODD_DB = 0.0  # 奇/偶谐波 ≥ 0 dB = 低八度的人就是主唱。蜂与你修对的片 -29…-1 dB；我想要占据你、Don't Cry 跟着上方和声升错的片 +2…+16
st = lambda x: np.where(x > 0, 69 + 12 * np.log2(np.where(x > 0, x, 1) / 440), np.nan)


def rmvpe_f0(applio: str, x: np.ndarray) -> np.ndarray:
    os.chdir(applio); sys.path.insert(0, applio)
    from rvc.lib.predictors.f0 import RMVPE  # noqa: E402
    s = np.quantile(np.abs(x), 0.999)
    return RMVPE(device="cuda", sample_rate=16000, hop_size=160).get_f0(x / s if s > 0 else x, filter_radius=0.03)


def back_level(vocals: np.ndarray, back: np.ndarray, n: int) -> np.ndarray:
    db = lambda y: 20 * np.log10(librosa.feature.rms(y=y, frame_length=640, hop_length=160)[0] + 1e-9)
    v, b = db(vocals), db(back)
    m = min(len(v), len(b))
    out = np.full(n, -99.0)
    out[:min(n, m)] = (b[:m] - v[:m])[:n]
    return out


def low_is_lead(dry: np.ndarray, raw: np.ndarray) -> np.ndarray:
    """干声里低八度那个人是不是本来就是主唱：按 RMVPE 测到的音高 f 算奇数次谐波（f,3f,5f,7f）比偶数次（2f,4f,6f,8f）强多少 dB，
    每个音（音高连着的一串帧，相邻差不到 7 个半音）取中位数，≥ ODD_DB 的整个音标出来。
    干声里只有高八度的人时奇数次几乎没能量；低八度的人自己唱主唱时奇数次是满的。"""
    n = len(raw)
    S = np.abs(librosa.stft(dry, n_fft=2048, hop_length=160)) ** 2
    m = min(n, S.shape[1])
    oe = np.full(n, np.nan)
    v = np.flatnonzero(raw[:m] > 0)
    if len(v):
        bins = np.round(raw[v, None] * np.arange(1, 9) / (16000 / 2048)).astype(int)
        e = sum(S[np.clip(bins + d, 0, S.shape[0] - 1), v[:, None]] for d in (-1, 0, 1))
        oe[v] = 10 * np.log10((e[:, 0::2].sum(1) + 1e-12) / (e[:, 1::2].sum(1) + 1e-12))
    s = st(raw)
    out = np.zeros(n, bool)
    j = 0
    while j < n:
        if np.isnan(s[j]):
            j += 1; continue
        e_ = j
        while e_ + 1 < n and not np.isnan(s[e_ + 1]) and abs(s[e_ + 1] - s[e_]) < 7:
            e_ += 1
        out[j:e_ + 1] = np.nanmedian(oe[j:e_ + 1]) >= ODD_DB if np.any(~np.isnan(oe[j:e_ + 1])) else False
        j = e_ + 1
    return out


def window_rule(raw: np.ndarray, back_rel: np.ndarray) -> np.ndarray:
    n, W = len(raw), 25
    s = st(raw)
    jump = np.zeros(n, bool)
    jump[1:] = ~np.isnan(s[1:]) & ~np.isnan(s[:-1]) & (np.abs(s[1:] - s[:-1]) >= 9) & (np.abs(s[1:] - s[:-1]) <= 15)
    cj = np.concatenate([[0], np.cumsum(jump)])
    up = np.zeros(n, bool)
    for t in np.flatnonzero(~np.isnan(s)):
        a, b = max(0, t - W), min(n, t + W + 1)
        if cj[b] - cj[a] >= 2 and np.any((s[a:b] - s[t] >= 9) & (s[a:b] - s[t] <= 15)):
            up[t] = True
    # 按音名切音（八度不算）：一个音要么升、要么不升。标记过、上面那层占 ≥5%、有第二个声部 → 下面那层全升
    fold = lambda x: (x + 6) % 12 - 6
    j = 0
    while j < n:
        if np.isnan(s[j]):
            j += 1; continue
        e = j
        while e + 1 < n and not np.isnan(s[e + 1]) and abs(fold(s[e + 1] - s[e])) < 1.5:
            e += 1
        seg = s[j:e + 1]
        top = np.nanpercentile(seg, 95)
        upper, lower = (top - seg) <= 3, (top - seg) >= 9
        up[j:e + 1] = lower if up[j:e + 1].any() and upper.mean() >= 0.05 and lower.any() and np.median(back_rel[j:e + 1]) >= -BACK_DB else False
        j = e + 1
    fixed = raw.copy()
    fixed[up] = raw[up] * 2
    return fixed


def find_repeats(C: np.ndarray, raw: np.ndarray, win=250, hop=125, max_cost=0.12) -> list[dict]:
    n = min(C.shape[1], len(raw))
    C, raw = C[:, :n], raw[:n]
    steps = np.array([[1, 1], [1, 2], [2, 1]])  # 两遍快慢最多差一倍
    res = []
    for a in range(0, n - win, hop):
        if (raw[a:a + win] > 0).mean() < 0.5:
            continue
        b, L = a + win, win
        cost = librosa.sequence.dtw(X=C[:, a:b], Y=C, metric="cosine", subseq=True, backtrack=False, step_sizes_sigma=steps)[-1] / L
        cand = []
        local = np.flatnonzero((cost == minimum_filter1d(cost, max(3, L // 2))) & (cost <= max_cost))
        for e in local[np.argsort(cost[local])]:
            lo = max(0, e - 2 * L)
            _, wp = librosa.sequence.dtw(X=C[:, a:b], Y=C[:, lo:e + 1], metric="cosine", subseq=True, step_sizes_sigma=steps)
            s0 = lo + wp[-1][1]
            if not 0.7 <= (e + 1 - s0) / L <= 1.4 or min(e + 1, b) - max(s0, a) > 0 or any(abs(s0 - c[0]) < L / 2 for c in cand):
                continue
            cand.append((int(s0), int(e + 1), round(float(cost[e]), 3)))
            if len(cand) >= 6:
                break
        if cand:
            res.append({"a": (a, b), "refs": sorted(cand)})
    return res


def repeat_rule(C: np.ndarray, src: np.ndarray, raw: np.ndarray, table: list[dict], back_rel: np.ndarray, pad=100, refx=2.0) -> np.ndarray:
    n = len(src)
    f = src.copy()
    for r in table:
        A = slice(*r["a"])
        best = min(c for _, _, c in r["refs"])
        refs = []
        for c0, c1, c in r["refs"]:
            if c > refx * max(best, 0.005):  # 只信最像的几处
                continue
            a, b = max(0, A.start - pad), min(n, A.stop + pad)
            c, d_ = max(0, c0 - pad), min(n, c1 + pad)
            _, path = librosa.sequence.dtw(X=C[:, a:b], Y=C[:, c:d_], metric="cosine")
            ref = np.full(b - a, np.nan)
            for p, q in path[::-1]:
                ref[p] = st(src[c + q: c + q + 1])[0]
            refs.append(ref[A.start - a:A.start - a + A.stop - A.start])
        ref = np.nanmedian(np.vstack(refs), axis=0) if len(refs) > 1 else refs[0]
        seg = st(src[A])
        low = ((ref - seg) >= 9) & ((ref - seg) <= 15)
        region = np.convolve(low.astype(float), np.ones(31) / 31, "same") > 0.5  # 0.3 秒里过半的帧都低一个八度
        k = 0
        while k < len(seg):
            if not region[k]:
                k += 1; continue
            e = k
            while e + 1 < len(seg) and region[e + 1]:
                e += 1
            if e - k + 1 >= 15 and np.median(back_rel[A.start + k:A.start + e + 1]) >= -BACK_DB:
                idx = A.start + k + np.flatnonzero(low[k:e + 1])
                f[idx] = src[idx] * 2
            k = e + 1
    # 一个音里升了的超过三分之一 → 整个音都升
    raised = f > src * 1.5
    j = 0
    while j < n:
        if src[j] <= 0:
            j += 1; continue
        e = j
        while e + 1 < n and src[e + 1] > 0 and abs(12 * np.log2(src[e + 1] / src[e])) < 0.7:
            e += 1
        if raised[j:e + 1].mean() > 1 / 3:
            f[j:e + 1] = src[j:e + 1] * 2
        j = e + 1
    return np.where(raw > 0, np.minimum(f, raw * 2), f)


def blip_rule(f: np.ndarray, raw: np.ndarray, back_rel: np.ndarray, short=15, near=10) -> tuple[np.ndarray, int]:
    s = st(f)
    voiced = ~np.isnan(s)
    n = len(s)
    g = f.copy()

    def side(a, step):
        got, i = [], a
        while 0 <= i < n and len(got) < 5:
            if voiced[i]:
                got.append(s[i])
            elif not got and abs(i - a) >= near:
                break
            i += step
        return np.median(got) if len(got) == 5 else np.nan

    count, j = 0, 0
    while j < n:
        if not voiced[j]:
            j += 1; continue
        e = j
        while e + 1 < n and voiced[e + 1] and abs(s[e + 1] - s[e]) < 7:
            e += 1
        if e - j + 1 <= short:
            left, right = side(j - 1, -1), side(e + 1, 1)
            lower = np.min([left, right])  # 两边都得有：缺一边是 NaN，这里就不填
            d = lower - np.max(s[j:e + 1])
            if not np.isnan(d) and 9 <= lower - np.median(s[j:e + 1]) <= 15 and d >= 7 and np.median(back_rel[j:e + 1]) >= -BACK_DB:
                g[j:e + 1] = np.minimum(f[j:e + 1] * 2, np.where(raw[j:e + 1] > 0, raw[j:e + 1] * 2, f[j:e + 1] * 2))
                count += 1
        j = e + 1
    return g, count


def edge_rule(f: np.ndarray, raw: np.ndarray, gapf=3, edge=2.0) -> tuple[np.ndarray, int]:
    f = f.copy()
    n = len(f)
    s = st(raw)
    raised = (raw > 0) & (f > raw * 1.5)
    count, j = 0, 0
    while j < n:
        if not raised[j]:
            j += 1; continue
        e = j
        while True:  # 一片：中间可以隔着不超过 gapf 帧没音高的
            k = e + 1
            while k < n and raw[k] <= 0 and k - e <= gapf:
                k += 1
            if k < n and k - e <= gapf + 1 and raised[k]:
                e = k
            else:
                break
        broken = False
        for at, step in ((j, -1), (e, 1)):
            k = at + step
            while 0 <= k < n and raw[k] <= 0 and abs(k - at) <= gapf:
                k += step
            if 0 <= k < n and raw[k] > 0 and not raised[k] and abs(s[k] - s[at]) < edge:
                broken = True
        if broken:
            f[j:e + 1] = np.where(raised[j:e + 1], raw[j:e + 1], f[j:e + 1])
            count += 1
        j = e + 1
    return f, count


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--applio", required=True); ap.add_argument("--dry", required=True); ap.add_argument("--vocals", required=True)
    ap.add_argument("--back", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    dry = librosa.load(a.dry, sr=16000, mono=True)[0].astype(np.float32)
    raw = rmvpe_f0(a.applio, dry)
    n = len(raw)
    vocals = librosa.load(a.vocals, sr=16000, mono=True)[0]
    back_rel = back_level(vocals, librosa.load(a.back, sr=16000, mono=True)[0], n)
    lead = low_is_lead(dry, raw)
    back_rel[lead] = -99.0  # 低八度那个人自己就是主唱：和声在他上面，不是把他拉低的那种错，这里不算有第二声部
    leadSec = round(float(lead.sum()) / 100, 2)
    C = librosa.feature.chroma_cqt(y=vocals, sr=16000, hop_length=160)
    C[:, C.sum(0) == 0] = 1 / 12  # 完全静音的帧音级特征全是 0，余弦距离算出 NaN，DTW 会报错（恋のうた、カワキヲアメク）
    win = window_rule(raw, back_rel)
    rep = repeat_rule(C, win, raw, find_repeats(C, raw), back_rel)
    blip, blips = blip_rule(rep, raw, back_rel)
    plan, undone = edge_rule(blip, raw)
    np.save(a.out, plan)
    up = lambda x: round(float(np.sum((raw > 0) & (x > raw * 1.5))) / 100, 2)
    print(json.dumps({"windowSec": up(win), "repeatSec": round(up(rep) - up(win), 2), "blips": blips, "undone": undone, "raisedSec": up(plan), "lowLeadSec": leadSec}), flush=True)


if __name__ == "__main__":
    main()
