#!/usr/bin/env python3
"""用 Applio 把一条干声转成目标音色。单独成进程，用的是用户 RVC 环境的 Python。
--f0-npy 给 pitch_fix.py 修好的音高（10 ms 一帧，对齐输入）：有音高的帧用它，没有的用 RVC 自己测的。"""

import argparse
import os
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--applio", required=True); ap.add_argument("--model", required=True); ap.add_argument("--index", default="")
ap.add_argument("--input", required=True); ap.add_argument("--output", required=True)
ap.add_argument("--key", type=int, default=0); ap.add_argument("--index-rate", type=float, default=0.3); ap.add_argument("--protect", type=float, default=0.33)
ap.add_argument("--f0-npy", default="")
args = ap.parse_args()
sys.argv = sys.argv[:1]
os.chdir(args.applio)
sys.path.insert(0, args.applio)
import core  # noqa: E402

if args.f0_npy:
    import numpy as np
    from rvc.lib.predictors import f0 as f0mod

    plan = np.load(args.f0_npy)
    measure = f0mod.RMVPE.get_f0

    def planned(self, x, *a, **k):
        own = measure(self, x, *a, **k)
        pad = max(0, (len(own) - len(plan)) // 2)  # 流水线两头各补了一样长
        full = np.zeros(len(own))
        m = min(len(plan), len(own) - pad)
        full[pad:pad + m] = plan[:m]
        return np.where(full > 0, full, own)

    f0mod.RMVPE.get_f0 = planned

core.run_infer_script(pitch=args.key, index_rate=args.index_rate if args.index else 0, volume_envelope=0.25, protect=args.protect, f0_method="rmvpe",
                      input_path=args.input, output_path=args.output, pth_path=args.model, index_path=args.index, f0_autotune=False, f0_autotune_strength=1.0,
                      proposed_pitch=False, proposed_pitch_threshold=155.0, export_format="WAV", embedder_model="contentvec")
