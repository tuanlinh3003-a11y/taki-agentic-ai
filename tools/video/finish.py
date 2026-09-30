#!/usr/bin/env python3
"""Post-production for Flow clips: normalise -> concat -> burn Vietnamese subtitles, hook title and CTA.

The local ffmpeg build has no libass/drawtext, so text is rendered to transparent PNGs with Pillow and
composited with ffmpeg's `overlay` filter (always available).

Usage:
  finish.py --clips s01.mp4 s02.mp4 ... --script script.json --out final.mp4 [--title "..."] [--cta "..."]
script.json: [{"canh": 1, "loi_thoai": "..."}, ...]  (one entry per clip, same order)
Prints a JSON report on stdout.
"""
import argparse, json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1080, 1920, 30
# Font đóng gói kèm repo đứng đầu → phụ đề giống hệt trên mọi máy (macOS/Linux/Windows).
FONT_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "BeVietnamPro-Bold.ttf"),
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(json.dumps({"ok": False, "error": r.stderr[-1500:], "cmd": " ".join(cmd[:6])}))
    return r.stdout


def probe(path):
    j = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path]))
    streams = j.get("streams", [])
    return {
        "duration": float(j["format"]["duration"]),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        "width": next((s.get("width") for s in streams if s.get("codec_type") == "video"), None),
        "height": next((s.get("height") for s in streams if s.get("codec_type") == "video"), None),
    }


def font(size):
    for f in FONT_CANDIDATES:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = f"{cur} {w}".strip()
        if draw.textlength(t, font=fnt) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def text_png(path, text, size, y_frac, box=False, color=(255, 255, 255)):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fnt = font(size)
    lines = wrap(d, text, fnt, W - 140)[:3]
    lh = int(size * 1.25)
    top = int(H * y_frac) - (lh * len(lines)) // 2
    if box:
        bw = max(d.textlength(l, font=fnt) for l in lines) + 60
        d.rounded_rectangle([(W - bw) / 2, top - 24, (W + bw) / 2, top + lh * len(lines) + 12], radius=24, fill=(0, 0, 0, 150))
    for i, line in enumerate(lines):
        tw = d.textlength(line, font=fnt)
        d.text(((W - tw) / 2, top + i * lh), line, font=fnt, fill=color + (255,), stroke_width=0 if box else 6, stroke_fill=(0, 0, 0, 255))
    img.save(path)


def chunks(text, max_words=8):
    words = text.split()
    out, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) >= max_words or w.endswith((".", "!", "?", ",")) and len(cur) >= 4:
            out.append(" ".join(cur)); cur = []
    if cur:
        out.append(" ".join(cur))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", nargs="+", required=True)
    ap.add_argument("--script", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--cta", default="")
    a = ap.parse_args()

    script = json.load(open(a.script, encoding="utf-8"))
    tmp = tempfile.mkdtemp(prefix="finish_")
    info = [probe(c) for c in a.clips]

    # 1) normalise every clip (size/fps/audio) so concat is safe
    norm = []
    for i, (c, p) in enumerate(zip(a.clips, info)):
        o = os.path.join(tmp, f"n{i:02d}.mp4")
        vf = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps={FPS},setsar=1"
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", c]
        if not p["has_audio"]:
            cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest"]
        cmd += ["-vf", vf, "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", o]
        run(cmd)
        norm.append(o)

    # 2) concat
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as f:
        f.writelines(f"file '{n}'\n" for n in norm)
    merged = os.path.join(tmp, "merged.mp4")
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", merged])

    # 3) text overlays: subtitles per scene (split evenly by words), hook title 0-3s, CTA on last scene
    overlays, t0 = [], 0.0
    for i, p in enumerate(info):
        line = (script[i]["loi_thoai"] if i < len(script) else "").strip()
        parts = chunks(line) if line else []
        total_words = sum(len(x.split()) for x in parts) or 1
        t = t0
        for k, part in enumerate(parts):
            dur = p["duration"] * len(part.split()) / total_words
            png = os.path.join(tmp, f"s{i:02d}_{k:02d}.png")
            text_png(png, part, 64, 0.72)
            overlays.append((png, t, t + dur))
            t += dur
        t0 += p["duration"]
    if a.title:
        png = os.path.join(tmp, "title.png"); text_png(png, a.title, 70, 0.14, box=True, color=(255, 214, 0))
        overlays.append((png, 0, min(3.0, t0)))
    if a.cta and info:
        png = os.path.join(tmp, "cta.png"); text_png(png, a.cta, 66, 0.14, box=True)
        overlays.append((png, t0 - info[-1]["duration"], t0))

    cmd = ["ffmpeg", "-y", "-v", "error", "-i", merged]
    for png, _, _ in overlays:
        cmd += ["-i", png]
    graph, last = [], "[0:v]"
    for idx, (_, s, e) in enumerate(overlays, start=1):
        out = f"[v{idx}]"
        graph.append(f"{last}[{idx}:v]overlay=0:0:enable='between(t,{s:.2f},{e:.2f})'{out}")
        last = out
    if graph:
        cmd += ["-filter_complex", ";".join(graph), "-map", last, "-map", "0:a"]
    cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "copy", "-movflags", "+faststart", a.out]
    run(cmd)

    final = probe(a.out)
    print(json.dumps({"ok": True, "out": a.out, "duration": round(final["duration"], 2), "width": final["width"], "height": final["height"],
                      "has_audio": final["has_audio"], "scenes": len(a.clips), "overlays": len(overlays)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
