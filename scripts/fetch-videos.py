#!/usr/bin/env python3
"""Fetch the latest videos for the Hindi news channels via yt-dlp and write videos.json.

No API key needed. yt-dlp reads each channel's /videos page (newest first)
and extracts full metadata (id, title, publish timestamp, duration).
Run from the repo root:  python3 scripts/fetch-videos.py
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

CHANNELS = [
    {"name": "DW हिन्दी", "handle": "@dwhindi", "id": "UCc7pPNFBvIhI4iV7m8plJuA"},
    {"name": "The Lallantop", "handle": "@TheLallantop", "id": "UCx8Z14PpntdaxCt2hakbQLQ"},
    {"name": "BBC News Hindi", "handle": "@BBCHindi", "id": "UCN7B-QD0Qgn2boVH5Q0pOWg"},
    {"name": "Jansatta", "handle": "@jansatta", "id": "UCICJyUwBYgUOE35F8klEoYw"},
    {"name": "Khabargaon", "handle": "@KhabarGaon", "id": "UClhHB0_iXbn8Cc0x5YzcvIg"},
]
PER_CHANNEL = 15


def fetch(ch):
    cmd = [
        "python3", "-m", "yt_dlp",
        "--dump-single-json", "--skip-download",
        "--playlist-items", f"1-{PER_CHANNEL}",
        f"https://www.youtube.com/{ch['handle']}/videos",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        print(f"!! {ch['name']}: timed out", file=sys.stderr)
        return ch, []
    if r.returncode != 0:
        print(f"!! {ch['name']} failed: {r.stderr[-300:]}", file=sys.stderr)
        return ch, []
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        print(f"!! {ch['name']}: bad JSON", file=sys.stderr)
        return ch, []
    out = []
    for e in d.get("entries") or []:
        if not e or not e.get("id") or not e.get("title") or not e.get("timestamp"):
            continue
        if e.get("live_status") == "is_upcoming":
            continue
        if e.get("availability") == "private":
            continue
        if "#shorts" in e["title"].lower():
            continue
        out.append({
            "id": e["id"],
            "title": e["title"],
            "channel": ch["name"],
            "published": datetime.fromtimestamp(
                e["timestamp"], tz=timezone.utc
            ).isoformat().replace("+00:00", "Z"),
            "ts": e["timestamp"],
            "dur": e.get("duration"),
        })
    print(f"{ch['name']}: {len(out)} videos")
    return ch, out


def main():
    videos = []
    with ThreadPoolExecutor(max_workers=5) as ex:
        for ch, vs in ex.map(fetch, CHANNELS):
            videos.extend(vs)
    videos.sort(key=lambda v: v["ts"], reverse=True)
    now = datetime.now(timezone.utc)
    data = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "channels": [
            {"name": c["name"], "handle": c["handle"], "id": c["id"]}
            for c in CHANNELS
        ],
        "videos": videos,
    }
    with open("videos.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"total {len(videos)} videos -> videos.json")


if __name__ == "__main__":
    main()
