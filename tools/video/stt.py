#!/usr/bin/env python3
"""Transcribe clips (Vietnamese by default) with faster-whisper; prints JSON [{file, language, prob, text}]."""
import json, sys
from faster_whisper import WhisperModel

files = [a for a in sys.argv[1:] if not a.startswith("--")]
lang = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--lang=")), "vi")
model = WhisperModel("small", device="cpu", compute_type="int8")
out = []
for f in files:
    segs, info = model.transcribe(f, language=None if lang == "auto" else lang, vad_filter=True)
    out.append({"file": f, "language": info.language, "prob": round(info.language_probability, 2), "text": " ".join(s.text.strip() for s in segs)})
print(json.dumps(out, ensure_ascii=False))
