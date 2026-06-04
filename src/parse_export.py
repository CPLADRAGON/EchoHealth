"""
Stream-parse a large Apple Health export.xml into tidy parquet files.

Apple's export.xml can be hundreds of MB / millions of records, so we use
lxml's iterparse to process it element-by-element without loading it all into
memory. High-frequency quantity types (steps, distance, energy...) are
aggregated to daily resolution on the fly; sparse cardio/sleep/workout records
are kept at full resolution.

Outputs (in ./data):
  daily_activity.parquet  - per-day step/distance/energy/flights/exercise/stand
  daily_heart.parquet     - per-day heart-rate / HRV / VO2Max / respiratory
  sleep.parquet           - individual sleep-analysis segments
  workouts.parquet        - one row per workout
  meta.json               - summary metadata for the dashboard header
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime

import pandas as pd
from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXPORT = os.path.join(ROOT, "apple_health_export", "export.xml")
DATA_DIR = os.path.join(ROOT, "data")

PREFIX_Q = "HKQuantityTypeIdentifier"
PREFIX_C = "HKCategoryTypeIdentifier"

# Quantity types we SUM per day (cumulative metrics).
SUM_TYPES = {
    f"{PREFIX_Q}StepCount": "steps",
    f"{PREFIX_Q}DistanceWalkingRunning": "distance_km",
    f"{PREFIX_Q}ActiveEnergyBurned": "active_kcal",
    f"{PREFIX_Q}BasalEnergyBurned": "basal_kcal",
    f"{PREFIX_Q}FlightsClimbed": "flights",
    f"{PREFIX_Q}AppleExerciseTime": "exercise_min",
    f"{PREFIX_Q}AppleStandTime": "stand_min",
}

# Heart / cardio metrics: we keep daily min / mean / max where useful, else mean.
HEART_AGG = {
    f"{PREFIX_Q}HeartRate": ("hr", ("min", "mean", "max")),
    f"{PREFIX_Q}RestingHeartRate": ("resting_hr", ("mean",)),
    f"{PREFIX_Q}WalkingHeartRateAverage": ("walking_hr", ("mean",)),
    f"{PREFIX_Q}HeartRateVariabilitySDNN": ("hrv_sdnn", ("mean",)),
    f"{PREFIX_Q}VO2Max": ("vo2max", ("mean",)),
    f"{PREFIX_Q}RespiratoryRate": ("respiratory_rate", ("mean",)),
    f"{PREFIX_Q}HeartRateRecoveryOneMinute": ("hr_recovery", ("mean",)),
}

SLEEP_TYPE = f"{PREFIX_C}SleepAnalysis"


def parse_dt(s: str):
    """Apple dates look like '2023-01-04 08:13:00 -0500'."""
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        return None


def main():
    if not os.path.exists(EXPORT):
        raise SystemExit(f"export.xml not found at {EXPORT}")
    os.makedirs(DATA_DIR, exist_ok=True)

    # Accumulators -------------------------------------------------------
    # sum_acc[date][col] = running sum
    sum_acc: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    # heart_vals[date][col] = list of values (aggregated at the end)
    heart_vals: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    sleep_rows: list[dict] = []
    workout_rows: list[dict] = []

    record_count = 0
    min_date = max_date = None

    context = etree.iterparse(EXPORT, events=("end",), tag=("Record", "Workout"))
    for _, elem in context:
        tag = elem.tag
        if tag == "Record":
            record_count += 1
            rtype = elem.get("type")
            start = elem.get("startDate")
            day = start[:10] if start else None
            if day:
                if min_date is None or day < min_date:
                    min_date = day
                if max_date is None or day > max_date:
                    max_date = day

            if rtype in SUM_TYPES and day:
                val = elem.get("value")
                try:
                    sum_acc[day][SUM_TYPES[rtype]] += float(val)
                except (TypeError, ValueError):
                    pass
            elif rtype in HEART_AGG and day:
                col = HEART_AGG[rtype][0]
                val = elem.get("value")
                try:
                    heart_vals[day][col].append(float(val))
                except (TypeError, ValueError):
                    pass
            elif rtype == SLEEP_TYPE:
                s = parse_dt(elem.get("startDate"))
                e = parse_dt(elem.get("endDate"))
                if s and e:
                    sleep_rows.append({
                        "start": s.replace(tzinfo=None),
                        "end": e.replace(tzinfo=None),
                        "value": (elem.get("value") or "").replace(
                            "HKCategoryValueSleepAnalysis", ""),
                        "duration_hr": (e - s).total_seconds() / 3600.0,
                        "source": elem.get("sourceName"),
                    })
        else:  # Workout
            s = parse_dt(elem.get("startDate"))
            e = parse_dt(elem.get("endDate"))
            dist = elem.get("totalDistance")
            energy = elem.get("totalEnergyBurned")
            dur = elem.get("duration")
            workout_rows.append({
                "type": (elem.get("workoutActivityType") or "").replace(
                    "HKWorkoutActivityType", ""),
                "start": s.replace(tzinfo=None) if s else None,
                "end": e.replace(tzinfo=None) if e else None,
                "duration_min": float(dur) if dur else None,
                "distance_km": float(dist) if dist else None,
                "energy_kcal": float(energy) if energy else None,
                "source": elem.get("sourceName"),
            })

        # Free memory: clear the element and its now-useless previous siblings.
        elem.clear()
        while elem.getprevious() is not None:
            del elem.getparent()[0]

    del context

    # Build daily_activity ----------------------------------------------
    activity = pd.DataFrame.from_dict(sum_acc, orient="index")
    activity.index.name = "date"
    activity = activity.reset_index()
    activity["date"] = pd.to_datetime(activity["date"])
    activity = activity.sort_values("date").reset_index(drop=True)
    # distance comes in km already (unit km); ensure numeric cols exist
    for col in SUM_TYPES.values():
        if col not in activity:
            activity[col] = 0.0
    activity[list(SUM_TYPES.values())] = activity[list(SUM_TYPES.values())].fillna(0.0)
    activity.to_parquet(os.path.join(DATA_DIR, "daily_activity.parquet"), index=False)

    # Build daily_heart -------------------------------------------------
    heart_records = []
    for day, cols in heart_vals.items():
        row = {"date": day}
        for col, aggs in [(v[0], v[1]) for v in HEART_AGG.values()]:
            vals = cols.get(col)
            if not vals:
                continue
            if "min" in aggs:
                row[f"{col}_min"] = min(vals)
            if "max" in aggs:
                row[f"{col}_max"] = max(vals)
            if "mean" in aggs:
                # store mean under the plain column name
                row[col] = sum(vals) / len(vals)
        heart_records.append(row)
    heart = pd.DataFrame(heart_records)
    if not heart.empty:
        heart["date"] = pd.to_datetime(heart["date"])
        heart = heart.sort_values("date").reset_index(drop=True)
    heart.to_parquet(os.path.join(DATA_DIR, "daily_heart.parquet"), index=False)

    # Sleep & workouts --------------------------------------------------
    sleep = pd.DataFrame(sleep_rows)
    sleep.to_parquet(os.path.join(DATA_DIR, "sleep.parquet"), index=False)

    workouts = pd.DataFrame(workout_rows)
    workouts.to_parquet(os.path.join(DATA_DIR, "workouts.parquet"), index=False)

    # Meta --------------------------------------------------------------
    meta = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "record_count": record_count,
        "date_min": min_date,
        "date_max": max_date,
        "total_steps": int(activity["steps"].sum()) if "steps" in activity else 0,
        "total_distance_km": round(float(activity["distance_km"].sum()), 1)
        if "distance_km" in activity else 0,
        "active_days": int(len(activity)),
        "workout_count": int(len(workouts)),
        "sleep_segments": int(len(sleep)),
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print("Parsed", record_count, "records")
    print("Activity days:", len(activity), "| Heart days:", len(heart),
          "| Sleep segments:", len(sleep), "| Workouts:", len(workouts))
    print("Wrote parquet files to", DATA_DIR)


if __name__ == "__main__":
    main()
