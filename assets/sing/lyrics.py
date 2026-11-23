"""歌词：按歌名在网易云搜几版，先核对词是不是她唱的这首，再挑「行首最对得上这份干声起唱」的那一版，对齐到我们的音频，算出每个字的起唱时间。

规则（都只看这首歌自己的干声）：
- 候选：歌名去掉括号里的说明去搜，取前 12 个，歌名对不上的不要，取不到逐行时间的不要；「歌名 - 歌手」这种标题行去掉。
- 核对词：语音识别听干声前两分半，听出来的词（中日文相邻两字、英文相邻两词）在这版歌词里占不到 MIN_TEXT 的，是同名的别的歌，不要。
- 对时间：整体平移歌词（±20 秒，步长 0.05 秒），看有多少行的行首落在人声起音 ±0.15 秒内；取最好的平移，这个比例就是分数。
- 选用：词对上的版本里时间分数最高的那版；分数不到 MIN_HIT 就当没找到，宁可不出字幕也不出错位、错歌的字幕。
- 每行：行首吸到 ±0.6 秒内最近的音节起音；行尾是下一行之前最后有人声的地方。
- 每个字：行内有人声的时间排成一条轴，字均匀落在上面，再吸到 ±0.12 秒内最近的音节起音。中日文一字一个，英文一词一个。
出任何错都返回空，学歌照常完成。
"""

import json
import re
import urllib.parse
import urllib.request

import librosa
import numpy as np

API = "https://music.163.com/api"
SR = 16000
HOP = 160                  # 10 毫秒一帧
CANDIDATES = 12
MIN_HIT = 0.5              # 至少一半的行首对得上起音才用
# 听出来的词至少有几成在这份歌词里：曲库实测，对的歌中日文 8%–83%、英文 24%–84%，同名别的歌中日文 ≤1%、英文 ≤6%
MIN_TEXT = {"cjk": 0.05, "latin": 0.15}


def get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


def bare(title: str) -> str:
    """歌名去掉括号里的说明、首尾符号，用来搜和比"""
    t = re.sub(r"[（(【\[《「『].*?[）)】\]》」』]", "", title)
    return re.sub(r"\s+", " ", t).strip(" -_~·").lower()


def same_name(want: str, got: str) -> bool:
    a, b = bare(want), bare(got)
    return bool(a and b) and (a in b or b in a)


def parse_lrc(text: str) -> list[list]:
    """[[秒, 这一行]]，去掉作词、编曲这类署名行和空行"""
    lines = []
    for raw in text.splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        words = re.sub(r"\[[^\]]*\]", "", raw).strip()
        if not stamps or not words or re.match(r"^[^:：]{1,10}\s*[:：]", words):
            continue
        for m, s in stamps:                       # 一行前面挂好几个时间的是重复段落
            lines.append([int(m) * 60 + float(s), words])
    return sorted(lines)


def tokens(text: str) -> list[str]:
    """中日文一个字一个单位，英文、数字一个词一个单位（带着后面的空格，排版时好拼回去）"""
    # 词：连着的字母（含带长音符号的拉丁字母）、数字；中日文和标点一个字一个
    return re.findall(r"(?:[^\W_぀-ヿ㐀-鿿]|['’])+\s*|[^\s]\s*", text)


def features(dry: np.ndarray, sr: int) -> dict:
    y = librosa.resample(dry, orig_sr=sr, target_sr=SR) if sr != SR else dry
    rms = librosa.feature.rms(y=y, frame_length=640, hop_length=HOP)[0]
    voiced = rms > .1 * (np.percentile(rms, 95) or 1)
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    peaks = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=HOP, units="time", backtrack=True)
    return {"voiced": voiced, "rises": np.flatnonzero(voiced[1:] & ~voiced[:-1]) + 1, "peaks": np.asarray(peaks, float)}


def fit(lines: list[list], f: dict, span: float = 20) -> tuple[float, float]:
    """最好的整体平移，和这时有几成行首落在起音 ±0.15 秒内。挑平移按离起音多近打软分，对得一样多时取最准的那个"""
    starts = np.array([s for s, _ in lines]) * 100; rises = f["rises"]
    if not len(rises):
        return 0.0, 0.0
    def dist(idx):
        j = np.clip(np.searchsorted(rises, idx), 1, len(rises) - 1)
        return np.minimum(np.abs(rises[j] - idx), np.abs(rises[j - 1] - idx))
    best, score = 0.0, -1.0
    for off in np.arange(-span, span, .05):
        d = dist(starts + off * 100)
        sc = float(np.clip(1 - d / 15, 0, 1).mean())
        if sc > score:
            best, score = float(off), sc
    return round(best, 2), round(float((dist(starts + best * 100) <= 15).mean()), 3)


def timed(lines: list[list], off: float, f: dict) -> list[dict]:
    voiced, peaks = f["voiced"], f["peaks"]
    fr = lambda t: max(0, int(round(t * 100)))
    out = []
    for i, (s, text) in enumerate(lines):
        s += off
        nxt = lines[i + 1][0] + off if i + 1 < len(lines) else len(voiced) / 100
        near = peaks[np.abs(peaks - s) < .6]
        if len(near):
            s = max(float(near[np.argmin(np.abs(near - s))]), out[-1]["end"] if out else 0.0)
        v = np.where(voiced[fr(s):fr(nxt - .05)])[0]
        e = s + (v[-1] + 1) / 100 if len(v) else min(nxt, s + 2)
        if e - s < .4 * (nxt - s):            # 干声里这句太轻（哼唱、和声），按歌词表的行长算
            e, v = nxt - .1, np.array([], int)
        axis = s + v / 100 if len(v) else np.linspace(s, e, 10)
        toks, at = tokens(text), []
        for k in range(len(toks)):
            t = float(axis[min(len(axis) - 1, int(k / len(toks) * len(axis)))])
            snap = peaks[(np.abs(peaks - t) < .12) & (peaks >= s - .01) & (peaks < e)]
            at.append(float(snap[np.argmin(np.abs(snap - t))]) if len(snap) else t)
        at = np.maximum.accumulate(at) if at else at
        out.append({"start": round(float(s), 3), "end": round(float(e), 3), "text": text, "tokens": toks, "at": [round(float(x), 3) for x in at]})
    return out


def units(text: str) -> tuple[set, set]:
    """（中日文相邻两个字，英文相邻两个词）：去标点、统一小写。常见单词谁都会撞上，所以英文看词对"""
    t = text.lower()
    words = re.findall(r"[^\W_぀-ヿ㐀-鿿]+", t)      # 拉丁、俄文、韩文……按词
    cjk = re.sub(r"[^぀-ヿ㐀-鿿]", "", t)
    return {cjk[i:i + 2] for i in range(len(cjk) - 1)}, {" ".join(words[i:i + 2]) for i in range(len(words) - 1)}


def text_score(heard: str, lyric: str) -> tuple[float, str]:
    """听到的词里有几成出现在这份歌词里；按听到的是中日文还是英文分开算"""
    hc, hl = units(heard)
    lc, ll = units(lyric)
    if len(hc) >= len(hl):
        return round(len(hc & lc) / max(1, len(hc)), 3), "cjk"
    return round(len(hl & ll) / max(1, len(hl)), 3), "latin"


def transcribe(y16k: np.ndarray, model_path: str, seconds: float = 150) -> str:
    """听前两分半唱了什么（只用来核对是不是这首歌，不用它的时间）"""
    from faster_whisper import WhisperModel
    model = WhisperModel(model_path, device="cuda", compute_type="float16")
    segs, _ = model.transcribe(y16k[:int(seconds * SR)].astype(np.float32), vad_filter=True, beam_size=1)
    return " ".join(s.text for s in segs)


def pick(title: str, f: dict, heard: str, search=None, lyric=None) -> tuple[list[dict], dict]:
    """搜、核对、挑、对齐；返回 (lyrics, 报告)。heard 是这首歌里听出来的词。search / lyric 可替换成假的，测试用"""
    search = search or (lambda q: get(f"{API}/search/get?s={urllib.parse.quote(q)}&type=1&limit={CANDIDATES}").get("result", {}).get("songs", []))
    lyric = lyric or (lambda sid: get(f"{API}/song/lyric?id={sid}&lv=1&tv=-1").get("lrc", {}).get("lyric", ""))
    q = bare(title)
    if not q:
        return [], {"found": False, "reason": "没有歌名"}
    if not sum(map(len, units(heard))):
        return [], {"found": False, "reason": "人声里听不出词，没法核对是哪一版歌词"}
    named, best = [], None
    for c in search(q)[:CANDIDATES]:
        if not same_name(title, c.get("name", "")):
            continue
        lines = [l for l in parse_lrc(lyric(c["id"]) or "") if not (" - " in l[1] and q in bare(l[1]))]
        if len(lines) < 4:
            continue
        words, kind = text_score(heard, " ".join(w for _, w in lines))
        named.append(words)
        if words < MIN_TEXT[kind]:
            continue
        off, hit = fit(lines, f)
        if not best or hit > best[0]:
            best = (hit, off, lines, c, words)
    if not named:
        return [], {"found": False, "reason": "网易云没有对得上歌名、带时间的歌词"}
    if not best:
        return [], {"found": False, "reason": f"网易云同名的歌词和她唱的词对不上（最多重合 {round(max(named) * 100)}%）"}
    hit, off, lines, c, words = best
    report = {"found": hit >= MIN_HIT, "id": c["id"], "name": c.get("name"), "artist": "/".join(a.get("name", "") for a in c.get("artists", [])), "offsetSec": off, "hit": hit, "words": words}
    if hit < MIN_HIT:
        report["reason"] = f"词对上了，但这一版只有 {round(hit * 100)}% 的行对得上起唱，不用"
        return [], report
    return timed(lines, off, f), report


# ── 给定歌词文本，对到她唱的干声上（翻唱改了节奏也能对） ──────────────────────────────
# 网易云那版的行首时间对不上（翻唱改了节奏、换了编曲）、或者用户自己贴的歌词，走这条：
# 语音识别把干声里每个字（拉丁文每个字母）的时间听出来，歌词按顺序逐字对上去（最长公共子序列），
# 一句里对上的字定出这句的起止，对不上的字、整句没对上的句子按前后对上的时间插值。

def _units(text: str) -> list[str]:
    """比对单位：中日文一个字，拉丁字母一个字母（去掉长音符号、统一小写）；听错一两个字母也还能对上大半"""
    import unicodedata
    t = unicodedata.normalize("NFKD", text.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.findall(r"[぀-ヿ㐀-鿿]|[a-z0-9]", t)


def heard_units(y16k: np.ndarray, model_path: str, language: str | None = None) -> list[tuple[str, float, float]]:
    """整首听一遍，带每个词的时间；一个词里的字平均分它的时间"""
    from faster_whisper import WhisperModel
    model = WhisperModel(model_path, device="cuda", compute_type="float16")
    # 不开 VAD：它把唱歌当成不是在说话，会切掉一大半
    segs, _ = model.transcribe(y16k.astype(np.float32), vad_filter=False, beam_size=5, word_timestamps=True,
                               language=language, condition_on_previous_text=False, no_speech_threshold=0.9)
    out = []
    for s in segs:
        for w in s.words or []:
            us = _units(w.word)
            d = (w.end - w.start) / max(1, len(us))
            out += [(u, w.start + k * d, w.start + (k + 1) * d) for k, u in enumerate(us)]
    return out


def guess_language(texts: list[str]) -> str | None:
    t = "".join(texts)
    if re.search(r"[぀-ヿ]", t):
        return "ja"
    if re.search(r"[㐀-鿿]", t):
        return "zh"
    if re.search(r"[āēīōūȳ]", t.lower()) or re.search(r"(?:quoniam|sapientiam|dominus|deus)", t.lower()):
        return "la"  # 拉丁文（长音符号、常见的词）：告诉它，不然会当成意大利语、英语去听
    return None  # 英文等：让它自己听


def align(texts: list[str], heard: list[tuple[str, float, float]]) -> tuple[list[dict], dict]:
    """歌词（一行一句）逐字对到听出来的时间上，返回和 pick() 一样格式的歌词，和对上了多少"""
    from difflib import SequenceMatcher
    lyr = []   # (单位, 第几行, 这行第几个 token)
    toks_per_line = [tokens(t) for t in texts]
    for li, toks in enumerate(toks_per_line):
        for ti, tok in enumerate(toks):
            lyr += [(u, li, ti) for u in _units(tok)]
    a, b = [u for u, _, _ in lyr], [u for u, _, _ in heard]
    when: dict[int, tuple[float, float]] = {}
    for m in SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(m.size):
            when[m.a + k] = (heard[m.b + k][1], heard[m.b + k][2])
    # 每个 token 的时间 = 它第一个对上的单位的时间；每行起止 = 对上的单位里最早、最晚
    tok_t: dict[tuple[int, int], float] = {}
    line_se: dict[int, list[float]] = {}
    for idx, (_, li, ti) in enumerate(lyr):
        if idx in when:
            tok_t.setdefault((li, ti), when[idx][0])
            se = line_se.setdefault(li, [when[idx][0], when[idx][1]])
            se[0], se[1] = min(se[0], when[idx][0]), max(se[1], when[idx][1])
    units_per_line = [len([1 for _, li2, _ in lyr if li2 == li]) for li in range(len(texts))]
    matched_per_line = [len([i for i, (_, li2, _) in enumerate(lyr) if li2 == li and i in when]) for li in range(len(texts))]
    # 对上不到三成的行不信它的时间（多半是零星撞上的字），按前后插值
    good = [li for li in range(len(texts)) if units_per_line[li] and matched_per_line[li] / units_per_line[li] >= 0.3 and li in line_se]
    starts = {li: line_se[li][0] for li in good}
    ends = {li: line_se[li][1] for li in good}
    out = []
    for li, text in enumerate(texts):
        if li not in starts:
            prev = max((g for g in good if g < li), default=None)
            nxt = min((g for g in good if g > li), default=None)
            s = ends[prev] + 0.2 if prev is not None else (starts[nxt] - 3 if nxt is not None else 0.0)
            e = starts[nxt] - 0.2 if nxt is not None else s + 3
            n_between = (nxt if nxt is not None else len(texts)) - (prev if prev is not None else -1) - 1
            k = li - (prev if prev is not None else -1) - 1
            span = max(0.5, e - s) / max(1, n_between)
            s, e = s + k * span, s + (k + 1) * span
        else:
            s, e = starts[li], ends[li]
        toks = toks_per_line[li]
        at = [tok_t.get((li, ti)) for ti in range(len(toks))]
        known = [(ti, t) for ti, t in enumerate(at) if t is not None and s - 0.05 <= t <= e + 0.05]
        filled = []
        for ti in range(len(toks)):
            left = max(((k2, t) for k2, t in known if k2 <= ti), default=None)
            right = min(((k2, t) for k2, t in known if k2 >= ti), default=None)
            if left and right and right[0] != left[0]:
                t = left[1] + (right[1] - left[1]) * (ti - left[0]) / (right[0] - left[0])
            elif left:
                t = left[1] if left[0] == ti else left[1] + (e - left[1]) * (ti - left[0]) / max(1, len(toks) - left[0])
            elif right:
                t = s + (right[1] - s) * ti / max(1, right[0])
            else:
                t = s + (e - s) * ti / max(1, len(toks))
            filled.append(t)
        filled = list(np.maximum.accumulate(filled)) if filled else []
        out.append({"start": round(float(s), 3), "end": round(float(max(e, s + 0.3)), 3), "text": text, "tokens": toks, "at": [round(float(x), 3) for x in filled]})
    # 行与行按时间排好、不倒退
    for i in range(1, len(out)):
        if out[i]["start"] < out[i - 1]["start"]:
            out[i]["start"] = out[i - 1]["end"]
            out[i]["end"] = max(out[i]["end"], out[i]["start"] + 0.3)
            out[i]["at"] = [max(x, out[i]["start"]) for x in out[i]["at"]]
    report = {"found": True, "method": "whisper-align", "lines": len(texts), "linesMatched": len(good),
              "unitsMatched": round(len(when) / max(1, len(lyr)), 3), "heardUnits": len(heard)}
    return out, report
