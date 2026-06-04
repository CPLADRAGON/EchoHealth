"""
Parse the workout-routes/*.gpx files into:
  data/routes.parquet     - one summary row per route (distance, duration, gain)
  data/route_tracks.json  - down-sampled lat/lon polylines for the Folium map
"""
from __future__ import annotations

import glob
import json
import os
from datetime import datetime

import gpxpy
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ROUTES_DIR = os.path.join(ROOT, "apple_health_export", "workout-routes")
DATA_DIR = os.path.join(ROOT, "data")

# Keep at most this many points per route for the map (keeps HTML light).
MAX_POINTS = 300


def downsample(points, max_points=MAX_POINTS):
    if len(points) <= max_points:
        return points
    step = len(points) / max_points
    return [points[int(i * step)] for i in range(max_points)]


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    files = sorted(glob.glob(os.path.join(ROUTES_DIR, "*.gpx")))
    if not files:
        raise SystemExit(f"No GPX files found in {ROUTES_DIR}")

    summaries = []
    tracks = []

    for path in files:
        name = os.path.basename(path)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                gpx = gpxpy.parse(fh)
        except Exception as exc:  # noqa: BLE001
            print("Skipping", name, "->", exc)
            continue

        coords = []
        elevs = []
        times = []
        for track in gpx.tracks:
            for seg in track.segments:
                for pt in seg.points:
                    coords.append([pt.latitude, pt.longitude])
                    if pt.elevation is not None:
                        elevs.append(pt.elevation)
                    if pt.time is not None:
                        times.append(pt.time)

        if len(coords) < 2:
            continue

        dist_km = gpx.length_3d() / 1000.0 if gpx.length_3d() else gpx.length_2d() / 1000.0
        start_t = min(times) if times else None
        end_t = max(times) if times else None
        dur_min = (end_t - start_t).total_seconds() / 60.0 if start_t and end_t else None
        gain = 0.0
        for i in range(1, len(elevs)):
            d = elevs[i] - elevs[i - 1]
            if d > 0:
                gain += d
        pace = (dur_min / dist_km) if dur_min and dist_km else None

        # date from filename: route_2023-01-04_8.13am.gpx
        date_str = None
        try:
            date_str = name.split("_")[1]
        except IndexError:
            pass

        summaries.append({
            "file": name,
            "date": pd.to_datetime(date_str) if date_str else (
                start_t.replace(tzinfo=None) if start_t else None),
            "distance_km": round(dist_km, 3),
            "duration_min": round(dur_min, 1) if dur_min else None,
            "pace_min_per_km": round(pace, 2) if pace else None,
            "elev_gain_m": round(gain, 1),
            "n_points": len(coords),
        })
        tracks.append({
            "file": name,
            "date": date_str,
            "start_iso": start_t.isoformat() if start_t else None,
            "distance_km": round(dist_km, 2),
            "duration_min": round(dur_min, 1) if dur_min else None,
            "coords": downsample(coords),
        })

    routes = pd.DataFrame(summaries).sort_values("date").reset_index(drop=True)
    routes.to_parquet(os.path.join(DATA_DIR, "routes.parquet"), index=False)
    with open(os.path.join(DATA_DIR, "route_tracks.json"), "w", encoding="utf-8") as f:
        json.dump(tracks, f)

    print(f"Parsed {len(routes)} routes; total "
          f"{routes['distance_km'].sum():.1f} km")
    print("Wrote routes.parquet and route_tracks.json to", DATA_DIR)


if __name__ == "__main__":
    main()
