"""
Build an interactive Folium (Leaflet) map overlaying every GPS workout route,
coloured and grouped by workout type (Running / Walking / Cycling / Hiking...).

Reads data/route_tracks.json and data/workouts.parquet.
Output: output/routes_map.html
"""
from __future__ import annotations

import json
import os
from datetime import datetime

import folium
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, "data")
OUT_DIR = os.path.join(ROOT, "output")

# Distinct, colourblind-friendly hues per workout type.
TYPE_COLORS = {
    "Running": "#fa3c4c",
    "Walking": "#2e7fff",
    "Cycling": "#34c759",
    "Hiking": "#ff9f0a",
    "Other": "#8a5cf6",
}


# Workout activity types that produce an outdoor GPS track.
GPS_TYPES = ("Running", "Walking", "Cycling", "Hiking")


def load_workouts():
    path = os.path.join(DATA_DIR, "workouts.parquet")
    if not os.path.exists(path):
        return pd.DataFrame()
    w = pd.read_parquet(path).dropna(subset=["start"]).copy()
    w["start"] = pd.to_datetime(w["start"])
    # Keep only GPS-capable activities; these are what routes belong to.
    mask = w["type"].astype(str).str.contains("|".join(GPS_TYPES), case=False)
    w = w[mask].copy()
    return w.sort_values("start").reset_index(drop=True)


def match_type(start_iso, workouts):
    """Match a route to its workout.

    GPX track times are UTC; Apple stores workout start times in local wall-clock
    time. The two therefore differ by a whole-hour timezone offset plus a few
    minutes of start jitter. We find the workout whose time difference is closest
    to a whole hour (within a plausible -12..+14 offset), which is timezone- and
    DST-agnostic and needs no hard-coded offset.
    """
    if not start_iso or workouts.empty:
        return "Other"
    try:
        t = datetime.fromisoformat(start_iso).replace(tzinfo=None)
    except ValueError:
        return "Other"
    diff_sec = (workouts["start"] - t).dt.total_seconds()
    hours = (diff_sec / 3600).round()
    # Minutes away from the nearest whole-hour offset (the start jitter).
    rem_min = ((diff_sec - hours * 3600).abs()) / 60.0
    plausible = hours.between(-12, 14)
    rem_min = rem_min.where(plausible)
    if rem_min.notna().any():
        idx = rem_min.idxmin()
        if rem_min.loc[idx] <= 20:
            raw = str(workouts.loc[idx, "type"])
            for key in TYPE_COLORS:
                if key.lower() in raw.lower():
                    return key
    return "Other"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    tracks_path = os.path.join(DATA_DIR, "route_tracks.json")
    if not os.path.exists(tracks_path):
        raise SystemExit("route_tracks.json not found. Run parse_gpx.py first.")

    with open(tracks_path, "r", encoding="utf-8") as f:
        tracks = json.load(f)
    tracks = [t for t in tracks if t.get("coords")]
    if not tracks:
        raise SystemExit("No route coordinates to map.")

    workouts = load_workouts()
    for t in tracks:
        t["wtype"] = match_type(t.get("start_iso"), workouts)

    # Center the map on the mean of all start points.
    starts = [t["coords"][0] for t in tracks]
    center = [sum(p[0] for p in starts) / len(starts),
              sum(p[1] for p in starts) / len(starts)]

    fmap = folium.Map(location=center, zoom_start=12, tiles="CartoDB positron",
                      control_scale=True)

    # One toggleable layer per workout type so users can isolate run vs walk.
    counts = {}
    for t in tracks:
        counts[t["wtype"]] = counts.get(t["wtype"], 0) + 1

    layers = {}
    for wtype in sorted(counts, key=lambda k: -counts[k]):
        layers[wtype] = folium.FeatureGroup(
            name=f'<span style="color:{TYPE_COLORS.get(wtype, "#888")}">&#9679;</span> '
                 f'{wtype} ({counts[wtype]})').add_to(fmap)

    for t in tracks:
        color = TYPE_COLORS.get(t["wtype"], "#888")
        popup = folium.Popup(
            f"<b>{t['wtype']}</b><br>{t.get('date','')}<br>"
            f"{t.get('distance_km','?')} km &middot; {t.get('duration_min','?')} min",
            max_width=220)
        folium.PolyLine(
            t["coords"], color=color, weight=3, opacity=0.6, popup=popup,
        ).add_to(layers[t["wtype"]])

    # Highlight start/end markers for the longest route.
    longest = max(tracks, key=lambda t: t.get("distance_km") or 0)
    folium.Marker(longest["coords"][0], tooltip="Start (longest route)",
                  icon=folium.Icon(color="green", icon="play")).add_to(fmap)
    folium.Marker(longest["coords"][-1], tooltip="End (longest route)",
                  icon=folium.Icon(color="red", icon="stop")).add_to(fmap)

    folium.LayerControl(collapsed=False).add_to(fmap)

    # A compact legend pinned to the corner.
    legend_rows = "".join(
        f'<div style="margin:2px 0"><span style="display:inline-block;width:12px;'
        f'height:12px;background:{TYPE_COLORS.get(k, "#888")};border-radius:2px;'
        f'margin-right:6px"></span>{k} &middot; {counts[k]}</div>'
        for k in sorted(counts, key=lambda k: -counts[k]))
    total_km = sum(t.get("distance_km") or 0 for t in tracks)
    legend_html = f"""
    <div style="position:fixed; bottom:24px; left:24px; z-index:9999;
         background:white; padding:12px 14px; border-radius:12px;
         box-shadow:0 2px 12px rgba(0,0,0,.15); font:13px -apple-system,Segoe UI,sans-serif;">
      <div style="font-weight:700; margin-bottom:6px">Workout routes</div>
      {legend_rows}
      <div style="margin-top:6px; color:#6e6e73">{len(tracks)} routes &middot; {total_km:.0f} km</div>
    </div>"""
    fmap.get_root().html.add_child(folium.Element(legend_html))

    # Fit bounds to all points.
    all_pts = [p for t in tracks for p in t["coords"]]
    lats = [p[0] for p in all_pts]
    lons = [p[1] for p in all_pts]
    fmap.fit_bounds([[min(lats), min(lons)], [max(lats), max(lons)]])

    out = os.path.join(OUT_DIR, "routes_map.html")
    fmap.save(out)
    print("Wrote", out, f"({len(tracks)} routes)")
    print("By type:", counts)


if __name__ == "__main__":
    main()
