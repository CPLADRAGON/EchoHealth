"""
Build a self-contained interactive HTML dashboard from the parsed parquet files.

Run parse_export.py and parse_gpx.py first. Output: output/dashboard.html
"""
from __future__ import annotations

import json
import os

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, "data")
OUT_DIR = os.path.join(ROOT, "output")

# ---- palette / theme -------------------------------------------------
ACCENT = "#fa3c4c"      # Apple Health "Activity" red
BLUE = "#2e7fff"
GREEN = "#34c759"
PURPLE = "#8a5cf6"
ORANGE = "#ff9f0a"
GRID = "#e9edf2"
INK = "#1d1d1f"
MUTED = "#6e6e73"

PLOT_LAYOUT = dict(
    template="plotly_white",
    font=dict(family="-apple-system, Segoe UI, Roboto, sans-serif", color=INK, size=12),
    paper_bgcolor="white",
    plot_bgcolor="white",
)


def load(name):
    path = os.path.join(DATA_DIR, name)
    return pd.read_parquet(path) if os.path.exists(path) else pd.DataFrame()


def style(fig, height=340, rmargin=24, hover="x unified", legend=True, date_axis=False):
    """Apply consistent styling. Titles live in HTML card headers (not in the
    figure) so the chart title can never overlap the legend."""
    fig.update_layout(
        **PLOT_LAYOUT,
        height=height,
        margin=dict(l=55, r=rmargin, t=28, b=40),
        hovermode=hover,
        xaxis=dict(gridcolor=GRID, zeroline=False),
        yaxis=dict(gridcolor=GRID, zeroline=False),
    )
    if date_axis:
        # Label every year so long multi-year spans don't silently drop labels,
        # and add interactive range controls (zoom buttons + draggable slider).
        fig.update_xaxes(
            dtick="M12", tickformat="%Y", ticklabelmode="period",
            tickangle=0, ticks="outside", ticklen=4,
            rangeselector=dict(
                buttons=[
                    dict(count=1, label="1Y", step="year", stepmode="backward"),
                    dict(count=2, label="2Y", step="year", stepmode="backward"),
                    dict(count=1, label="YTD", step="year", stepmode="todate"),
                    dict(step="all", label="All"),
                ],
                x=0, xanchor="left", y=1.0, yanchor="bottom",
                bgcolor="#f3f4f6", activecolor=ACCENT,
                font=dict(size=10, color=INK), bordercolor=GRID, borderwidth=1,
            ),
            rangeslider=dict(visible=True, thickness=0.06, bgcolor="#f7f8fa"),
        )
        # The slider + buttons need extra vertical room.
        fig.update_layout(height=height + 56,
                           margin=dict(l=55, r=rmargin, t=40, b=30))
    if legend:
        fig.update_layout(legend=dict(
            orientation="h", yanchor="bottom", y=1.0, xanchor="right", x=1.0,
            bgcolor="rgba(255,255,255,0)", font=dict(size=11)))
    else:
        fig.update_layout(showlegend=False)
    return fig


def div(fig, first=False):
    return fig.to_html(
        full_html=False,
        include_plotlyjs="inline" if first else False,
        config={"displayModeBar": False, "responsive": True},
    )


def arrow(delta, good_when_down=False):
    """Return a coloured up/down marker for a change value."""
    if abs(delta) < 1e-9:
        return "\u2192"
    up = delta > 0
    good = (not up) if good_when_down else up
    sym = "\u2191" if up else "\u2193"
    color = GREEN if good else ACCENT
    return f'<b style="color:{color}">{sym}</b>'


# ====================================================================== #
#  ACTIVITY
# ====================================================================== #
def fig_steps(act):
    d = act[["date", "steps"]].copy()
    d["roll"] = d["steps"].rolling(30, min_periods=7).mean()
    fig = go.Figure()
    fig.add_bar(x=d["date"], y=d["steps"], name="Daily steps",
                marker_color="rgba(250,60,76,0.18)", hovertemplate="%{y:,.0f}")
    fig.add_scatter(x=d["date"], y=d["roll"], name="30-day avg",
                    line=dict(color=ACCENT, width=2.5), hovertemplate="%{y:,.0f}")
    avg = d["steps"].mean()
    pct10k = (d["steps"] >= 10000).mean() * 100
    best = d.loc[d["steps"].idxmax()]
    last90 = d[d["date"] >= d["date"].max() - pd.Timedelta(days=90)]["steps"].mean()
    if avg >= 10000:
        verdict, tip = ("in the <b>active</b> band (10k+/day)",
                        "You're hitting the goal \u2014 keep the streak going.")
    elif avg >= 7500:
        verdict, tip = ("<b>moderately active</b> (7,500\u201310,000)",
                        "One extra short walk a day would tip you past the 10k goal.")
    elif avg >= 5000:
        verdict, tip = ("<b>lightly active</b> (5,000\u20137,500)",
                        "A 20\u201330 min daily walk would lift you toward 7,500+.")
    else:
        verdict, tip = ("in the <b>sedentary</b> band (under 5,000)",
                        "Short, frequent walks are the easiest way to raise this.")
    insight = (f"You average <b>{avg:,.0f}</b> steps/day \u2014 {verdict}. You clear "
               f"10,000 on <b>{pct10k:.0f}%</b> of days; the last 90 days run "
               f"<b>{last90:,.0f}</b>/day {arrow(last90 - avg)}. {tip}")
    return style(fig, 380, date_axis=True), insight


def fig_steps_heatmap(act):
    d = act.copy()
    d["year"] = d["date"].dt.year
    d["doy"] = d["date"].dt.dayofyear
    pivot = d.pivot_table(index="year", columns="doy", values="steps", aggfunc="sum")
    fig = px.imshow(
        pivot, color_continuous_scale="Reds", aspect="auto",
        labels=dict(x="Day of year", y="Year", color="Steps"))
    fig.update_xaxes(showticklabels=False)
    by_year = d.groupby("year")["steps"].mean()
    top_year = by_year.idxmax()
    this_year = int(by_year.index.max())
    side = "above" if by_year.loc[this_year] >= by_year.mean() else "below"
    insight = (f"Each row is a year; darker = more steps. <b>{top_year}</b> was your "
               f"most active at <b>{by_year.max():,.0f}</b>/day. {this_year} so far "
               f"averages <b>{by_year.loc[this_year]:,.0f}</b>/day \u2014 {side} your "
               f"all-time average of <b>{by_year.mean():,.0f}</b>.")
    return style(fig, 360, rmargin=70, hover="closest", legend=False), insight


def fig_monthly_distance(act):
    d = act.set_index("date").resample("MS")["distance_km"].sum().reset_index()
    fig = go.Figure()
    fig.add_bar(x=d["date"], y=d["distance_km"], marker_color=BLUE,
                hovertemplate="%{x|%b %Y}<br>%{y:.1f} km<extra></extra>")
    total = d["distance_km"].sum()
    busiest = d.loc[d["distance_km"].idxmax()]
    last6 = d.tail(6)["distance_km"].mean()
    prev6 = d.tail(12).head(6)["distance_km"].mean() if len(d) >= 12 else last6
    insight = (f"You've covered <b>{total:,.0f} km</b> on foot \u2014 about "
               f"<b>{total/40075*100:.1f}%</b> of Earth's circumference. The last 6 months "
               f"average <b>{last6:.0f} km</b>/month {arrow(last6 - prev6)} vs the prior six. "
               f"Peak: <b>{busiest['date']:%b %Y}</b> ({busiest['distance_km']:.0f} km).")
    return style(fig, 340, hover="closest", legend=False, date_axis=True), insight


def fig_energy(act):
    d = act.set_index("date").resample("MS")[["active_kcal", "basal_kcal"]].sum().reset_index()
    fig = go.Figure()
    fig.add_bar(x=d["date"], y=d["active_kcal"], name="Active", marker_color=ORANGE)
    fig.add_bar(x=d["date"], y=d["basal_kcal"], name="Resting", marker_color="#ffd8a8")
    fig.update_layout(barmode="stack")
    recent = act[act["date"] >= act["date"].max() - pd.Timedelta(days=90)]
    avg_active = recent["active_kcal"].mean() if not recent.empty else 0
    avg_basal = recent["basal_kcal"].mean() if not recent.empty else 0
    ratio = (avg_active / avg_basal * 100) if avg_basal else 0
    insight = (f"Active energy (orange) is what your movement adds on top of the resting "
               f"baseline. Over the last 90 days you burned <b>{avg_active:,.0f}</b> active "
               f"kcal/day \u2014 about <b>{ratio:.0f}%</b> on top of your "
               f"<b>{avg_basal:,.0f}</b> resting burn. A sustained 400\u2013600 active "
               f"kcal/day reflects a consistently active lifestyle.")
    return style(fig, 340, hover="closest", date_axis=True), insight


# ====================================================================== #
#  HEART / CARDIO
# ====================================================================== #
def fig_resting_hr(heart):
    if "resting_hr" not in heart:
        return None
    d = heart[["date", "resting_hr"]].dropna().copy()
    d["roll"] = d["resting_hr"].rolling(14, min_periods=3).mean()
    fig = go.Figure()
    fig.add_scatter(x=d["date"], y=d["resting_hr"], name="Resting HR",
                    mode="markers", marker=dict(size=4, color="rgba(46,127,255,0.35)"))
    fig.add_scatter(x=d["date"], y=d["roll"], name="14-day avg",
                    line=dict(color=BLUE, width=2.5))
    fig.update_yaxes(title="bpm")
    recent = d["resting_hr"].tail(30).mean()
    base = d["resting_hr"].head(30).mean()
    delta = recent - base
    trend = arrow(delta, good_when_down=True)
    if recent < 60:
        cat, tip = ("the <b>athlete/excellent</b> zone (under 60)",
                    "Keep up your aerobic base to hold it here.")
    elif recent < 70:
        cat, tip = ("<b>good</b> (60\u201370 bpm)",
                    "Regular cardio can nudge it lower still.")
    elif recent < 80:
        cat, tip = ("<b>average</b> (70\u201380 bpm)",
                    "More aerobic exercise and better sleep typically bring this down.")
    else:
        cat, tip = ("<b>elevated</b> (above 80)",
                    "Consistently >80 can reflect stress, poor sleep or low fitness \u2014 worth watching.")
    insight = (f"Resting heart rate now averages <b>{recent:.0f} bpm</b> {trend} vs "
               f"<b>{base:.0f}</b> earlier \u2014 that's in {cat}. A lower resting rate "
               f"generally signals better cardiovascular fitness. {tip}")
    return style(fig, 360, hover="closest", date_axis=True), insight


def fig_hr_range(heart):
    cols = {"hr_min", "hr", "hr_max"}
    if not cols.issubset(heart.columns):
        return None
    d = heart[["date", "hr_min", "hr", "hr_max"]].dropna(subset=["hr"]).copy()
    d = d[d["date"] >= d["date"].max() - pd.Timedelta(days=365)]
    fig = go.Figure()
    fig.add_scatter(x=d["date"], y=d["hr_max"], name="Max", line=dict(color="rgba(250,60,76,0)"))
    fig.add_scatter(x=d["date"], y=d["hr_min"], name="Min", fill="tonexty",
                    fillcolor="rgba(250,60,76,0.12)", line=dict(color="rgba(250,60,76,0)"))
    fig.add_scatter(x=d["date"], y=d["hr"], name="Avg", line=dict(color=ACCENT, width=2))
    fig.update_yaxes(title="bpm")
    insight = (f"Over the last year your heart rate spanned <b>{d['hr_min'].min():.0f}</b> to "
               f"<b>{d['hr_max'].max():.0f} bpm</b>, averaging <b>{d['hr'].mean():.0f}</b>. "
               f"The shaded band is each day's min\u2013max spread: the high spikes are "
               f"workouts, while the lower edge tracks your resting baseline \u2014 a falling "
               f"lower edge over time is a good fitness sign.")
    return style(fig, 360), insight


def fig_hrv(heart):
    if "hrv_sdnn" not in heart:
        return None
    d = heart[["date", "hrv_sdnn"]].dropna().copy()
    if d.empty:
        return None
    d["roll"] = d["hrv_sdnn"].rolling(14, min_periods=3).mean()
    fig = go.Figure()
    fig.add_scatter(x=d["date"], y=d["hrv_sdnn"], mode="markers", name="HRV (SDNN)",
                    marker=dict(size=4, color="rgba(138,92,246,0.35)"))
    fig.add_scatter(x=d["date"], y=d["roll"], name="14-day avg",
                    line=dict(color=PURPLE, width=2.5))
    fig.update_yaxes(title="ms")
    avg = d["hrv_sdnn"].mean()
    recent = d["hrv_sdnn"].tail(30).mean()
    base = d["hrv_sdnn"].head(30).mean()
    if avg >= 70:
        cat = "<b>high</b> \u2014 typically strong recovery and aerobic fitness"
    elif avg >= 40:
        cat = "<b>moderate</b> \u2014 a healthy everyday range for most adults"
    else:
        cat = "<b>on the lower side</b> \u2014 common with stress, fatigue or poor sleep"
    insight = (f"HRV (SDNN) averages <b>{avg:.0f} ms</b>, which is {cat}. Recent nights "
               f"run <b>{recent:.0f} ms</b> {arrow(recent - base)} vs your earlier baseline. "
               f"Good sleep, hydration and easy training days tend to raise HRV; alcohol "
               f"and overtraining lower it.")
    return style(fig, 360, hover="closest", date_axis=True), insight


def fig_vo2max(heart):
    if "vo2max" not in heart:
        return None
    d = heart[["date", "vo2max"]].dropna().copy()
    if d.empty:
        return None
    fig = go.Figure()
    fig.add_scatter(x=d["date"], y=d["vo2max"], name="VO2Max",
                    line=dict(color=GREEN, width=2.5), mode="lines+markers",
                    marker=dict(size=4))
    fig.update_yaxes(title="mL/kg\u00b7min")
    latest = d["vo2max"].iloc[-1]
    delta = latest - d["vo2max"].iloc[0]
    if latest >= 45:
        cat = "<b>excellent</b> aerobic capacity"
    elif latest >= 38:
        cat = "<b>good</b> \u2014 above average for most adults"
    elif latest >= 32:
        cat = "<b>fair</b>"
    else:
        cat = "<b>below average</b>"
    insight = (f"Estimated VO\u2082 max is <b>{latest:.1f} mL/kg\u00b7min</b> {arrow(delta)} "
               f"since tracking began \u2014 {cat}. It's Apple's headline cardio-fitness "
               f"number (exact bands depend on age and sex). Zone-2 cardio and interval "
               f"sessions are the most reliable ways to raise it.")
    return style(fig, 360, hover="closest", date_axis=True), insight


# ====================================================================== #
#  SLEEP
# ====================================================================== #
def build_nights(sleep):
    if sleep.empty:
        return pd.DataFrame()
    s = sleep.copy()
    s["start"] = pd.to_datetime(s["start"])
    s["end"] = pd.to_datetime(s["end"])
    # Assign each segment to a "night" = date of (start - 12h) so an evening
    # bedtime and the following morning fall on the same night.
    s["night"] = (s["start"] - pd.Timedelta(hours=12)).dt.date
    asleep = s[s["value"].str.startswith("Asleep")]
    if asleep.empty:  # older exports only have "InBed"/"Asleep"
        asleep = s[s["value"].isin(["Asleep", "InBed"])]
    nights = asleep.groupby("night").agg(
        asleep_hr=("duration_hr", "sum"),
        bedtime=("start", "min"),
        wake=("end", "max"),
    ).reset_index()
    nights["night"] = pd.to_datetime(nights["night"])
    # bedtime hour expressed on a -6..+12 scale centred on midnight
    bt = nights["bedtime"].dt.hour + nights["bedtime"].dt.minute / 60.0
    nights["bedtime_hr"] = bt.where(bt < 18, bt - 24)
    return nights


def fig_sleep_duration(nights):
    if nights.empty:
        return None
    d = nights.copy()
    d["roll"] = d["asleep_hr"].rolling(14, min_periods=3).mean()
    fig = go.Figure()
    fig.add_bar(x=d["night"], y=d["asleep_hr"], name="Asleep",
                marker_color="rgba(138,92,246,0.25)", hovertemplate="%{y:.1f} h")
    fig.add_scatter(x=d["night"], y=d["roll"], name="14-night avg",
                    line=dict(color=PURPLE, width=2.5))
    fig.add_hline(y=8, line_dash="dot", line_color=MUTED)
    fig.update_yaxes(title="hours asleep")
    avg = d["asleep_hr"].mean()
    pct7 = (d["asleep_hr"] >= 7).mean() * 100
    short = (d["asleep_hr"] < 6).mean() * 100
    if avg >= 7:
        cat, tip = ("meets the recommended <b>7\u20139 h</b> for adults",
                    "Protecting a consistent bedtime keeps it there.")
    elif avg >= 6:
        cat, tip = ("sits just below the recommended <b>7\u20139 h</b>",
                    "An earlier bedtime by 30\u201345 min would close most of the gap.")
    else:
        cat, tip = ("is below the healthy <b>7\u20139 h</b> range",
                    "Chronic short sleep hurts recovery and focus \u2014 worth prioritising.")
    insight = (f"You sleep <b>{avg:.1f} h</b>/night on average, which {cat}. You clear "
               f"7 h on <b>{pct7:.0f}%</b> of nights and fall under 6 h on "
               f"<b>{short:.0f}%</b>. The dotted line marks 8 h. {tip}")
    return style(fig, 380, date_axis=True), insight


def fig_bedtime(nights):
    if nights.empty:
        return None
    d = nights.dropna(subset=["bedtime_hr"]).copy()
    if d.empty:
        return None
    fig = go.Figure()
    fig.add_scatter(x=d["night"], y=d["bedtime_hr"], mode="markers",
                    marker=dict(size=4, color="rgba(46,127,255,0.4)"), name="Bedtime")
    fig.update_yaxes(title="bedtime (h, 0 = midnight)")
    med = d["bedtime_hr"].median()
    std = d["bedtime_hr"].std()
    hh = int(med) % 24
    mm = int(abs(med - int(med)) * 60)
    label = f"{hh:02d}:{mm:02d}"
    if std < 1.2:
        steady, tip = ("fairly consistent",
                       "A steady schedule like this supports better sleep quality.")
    else:
        steady, tip = ("quite variable",
                       "Tightening bedtime to within ~1 h nightly can improve sleep quality.")
    insight = (f"Your typical bedtime is around <b>{label}</b> and it's {steady} "
               f"(\u00b1{std:.1f} h). Each dot is one night; tighter scatter means a "
               f"steadier rhythm. {tip}")
    return style(fig, 340, hover="closest", legend=False, date_axis=True), insight


# ====================================================================== #
#  WORKOUTS
# ====================================================================== #
def fig_workouts_per_month(workouts):
    if workouts.empty:
        return None
    d = workouts.dropna(subset=["start"]).copy()
    d["month"] = pd.to_datetime(d["start"]).dt.to_period("M").dt.to_timestamp()
    g = d.groupby("month").size().reset_index(name="count")
    fig = go.Figure()
    fig.add_bar(x=g["month"], y=g["count"], marker_color=ACCENT,
                hovertemplate="%{x|%b %Y}<br>%{y} workouts<extra></extra>")
    busiest = g.loc[g["count"].idxmax()]
    per_week = g["count"].mean() / 4.3
    rhythm = ("2\u20133+ sessions a week is a solid, sustainable rhythm."
              if per_week >= 2 else
              "Aiming for 2\u20133 sessions a week would build more consistency.")
    insight = (f"<b>{len(d):,}</b> recorded workouts, averaging "
               f"<b>{g['count'].mean():.1f}</b>/month (~<b>{per_week:.1f}</b>/week). "
               f"Busiest month: <b>{busiest['month']:%b %Y}</b> with "
               f"<b>{busiest['count']}</b>. {rhythm}")
    return style(fig, 340, hover="closest", legend=False, date_axis=True), insight


def fig_workout_types(workouts):
    if workouts.empty:
        return None
    g = workouts.groupby("type").agg(
        count=("type", "size"),
        km=("distance_km", "sum"),
    ).reset_index().sort_values("count", ascending=True).tail(12)
    fig = go.Figure()
    fig.add_bar(y=g["type"], x=g["count"], orientation="h", marker_color=BLUE,
                hovertemplate="%{x} workouts")
    top = g.iloc[-1]
    n_types = len(g)
    insight = (f"<b>{top['type']}</b> is your go-to activity with <b>{top['count']}</b> "
               f"sessions, across <b>{n_types}</b> activity types. A blend of cardio and "
               f"strength gives the best all-round health return \u2014 if one type dominates, "
               f"adding a complementary activity helps balance your training load.")
    return style(fig, 360, hover="closest", legend=False), insight


def fig_route_distance(routes):
    if routes.empty:
        return None
    d = routes.dropna(subset=["date"]).copy()
    fig = go.Figure()
    fig.add_scatter(x=d["date"], y=d["distance_km"], mode="markers",
                    marker=dict(size=8, color=d["pace_min_per_km"],
                                colorscale="Viridis_r", showscale=True,
                                colorbar=dict(title="pace<br>min/km", x=1.02)),
                    name="Route", hovertemplate="%{x|%b %d, %Y}<br>%{y:.1f} km<extra></extra>")
    fig.update_yaxes(title="distance (km)")
    longest = d.loc[d["distance_km"].idxmax()]
    avg_pace = d["pace_min_per_km"].dropna().mean()
    insight = (f"<b>{len(d)}</b> GPS-tracked routes totalling "
               f"<b>{d['distance_km'].sum():.0f} km</b>, averaging "
               f"<b>{avg_pace:.1f} min/km</b>; longest single route was "
               f"<b>{longest['distance_km']:.1f} km</b>. Greener dots = faster pace. "
               f"Mixing easy long routes with a few faster ones improves both endurance "
               f"and speed.")
    return style(fig, 380, rmargin=70, hover="closest", legend=False, date_axis=True), insight


# ====================================================================== #
#  RECOVERY  (derived readiness score + illness early-warning)
# ====================================================================== #
def compute_recovery(heart, nights):
    """Blend resting HR, HRV and sleep into a daily 0-100 readiness score and
    flag possible illness-onset days. Heuristic wellness signal, not medical
    advice. Each metric is compared to its own trailing 60-day personal
    baseline (z-score), so the score is relative to *you*, not a population."""
    if heart.empty or "resting_hr" not in heart or "hrv_sdnn" not in heart:
        return pd.DataFrame()

    d = heart[["date", "resting_hr", "hrv_sdnn"]].copy()
    d["date"] = pd.to_datetime(d["date"])
    if not nights.empty:
        sl = nights[["night", "asleep_hr"]].rename(
            columns={"night": "date", "asleep_hr": "sleep_hr"})
        sl["date"] = pd.to_datetime(sl["date"])
        d = d.merge(sl, on="date", how="left")
    else:
        d["sleep_hr"] = pd.NA

    d = d.sort_values("date").reset_index(drop=True)
    # Need both core signals present to score a day.
    d = d.dropna(subset=["resting_hr", "hrv_sdnn"])
    if len(d) < 30:
        return pd.DataFrame()

    def z(col):
        mean = d[col].rolling(60, min_periods=14).mean()
        std = d[col].rolling(60, min_periods=14).std()
        return ((d[col] - mean) / std).clip(-3, 3), mean

    z_hrv, _ = z("hrv_sdnn")              # higher HRV = better
    z_rhr, rhr_base = z("resting_hr")     # lower resting HR = better
    d["rhr_delta"] = d["resting_hr"] - rhr_base
    d["hrv_z"] = z_hrv
    if d["sleep_hr"].notna().sum() >= 14:
        z_sleep, _ = z("sleep_hr")        # more sleep = better (vs your norm)
    else:
        z_sleep = pd.Series(0.0, index=d.index)
    z_sleep = z_sleep.fillna(0.0)

    # Weighted blend: HRV is the primary readiness driver.
    composite = 0.5 * z_hrv + 0.3 * (-z_rhr) + 0.2 * z_sleep
    d["readiness"] = (50 + 20 * composite).clip(0, 100)
    d["readiness_roll"] = d["readiness"].rolling(7, min_periods=3).mean()

    # Illness early-warning: resting HR clearly above baseline AND HRV
    # suppressed vs baseline on the same day (a documented pre-symptom pattern).
    d["flag"] = (d["rhr_delta"] > 5) & (d["hrv_z"] < -1)
    return d.dropna(subset=["readiness"]).reset_index(drop=True)


def fig_readiness(rec):
    if rec.empty:
        return None
    fig = go.Figure()
    fig.add_hrect(y0=66, y1=100, fillcolor="rgba(52,199,89,0.06)", line_width=0)
    fig.add_hrect(y0=0, y1=33, fillcolor="rgba(250,60,76,0.05)", line_width=0)
    fig.add_scatter(x=rec["date"], y=rec["readiness"], name="Daily readiness",
                    mode="markers", marker=dict(size=3.5, color="rgba(52,199,89,0.30)"),
                    hovertemplate="%{y:.0f}")
    fig.add_scatter(x=rec["date"], y=rec["readiness_roll"], name="7-day avg",
                    line=dict(color=GREEN, width=2.5), hovertemplate="%{y:.0f}")
    flagged = rec[rec["flag"]]
    if not flagged.empty:
        fig.add_scatter(x=flagged["date"], y=flagged["readiness"], mode="markers",
                        name="Illness flag", marker=dict(size=7, color=ACCENT,
                        symbol="x"), hovertemplate="Flagged %{x|%b %d, %Y}")
        # Group consecutive flagged days into episodes; label the most recent few.
        episodes = (flagged["date"].diff() > pd.Timedelta(days=2)).cumsum()
        starts = flagged.groupby(episodes)["date"].min().sort_values()
        for dt in starts.tail(6):
            row = rec.loc[rec["date"] == dt].iloc[0]
            fig.add_annotation(x=dt, y=row["readiness"], text=f"{dt:%b %d}",
                               showarrow=True, arrowhead=0, arrowwidth=1,
                               arrowcolor=ACCENT, ax=0, ay=-22,
                               font=dict(size=9, color=ACCENT), yanchor="bottom")
    fig.update_yaxes(title="readiness", range=[0, 100])

    cur = rec["readiness_roll"].iloc[-1]
    base = rec["readiness_roll"].iloc[max(0, len(rec) - 38):max(1, len(rec) - 30)].mean()
    flags90 = int(rec[rec["date"] >= rec["date"].max() - pd.Timedelta(days=90)]["flag"].sum())
    if cur >= 66:
        cat, tip = ("<b>high</b> \u2014 your body looks well recovered",
                    "A good window for harder training.")
    elif cur >= 45:
        cat, tip = ("<b>moderate</b> \u2014 about your normal baseline",
                    "Train as planned, but listen to how you feel.")
    else:
        cat, tip = ("<b>low</b> \u2014 recovery signals are suppressed",
                    "Consider an easier day, more sleep and hydration.")
    insight = (f"Current readiness is <b>{cur:.0f}/100</b> {arrow(cur - base)} vs last "
               f"month \u2014 {cat}. It blends HRV (50%), resting HR (30%) and sleep "
               f"(20%), each scored against your own 60-day baseline. The red \u00d7 marks "
               f"<b>{flags90}</b> possible illness-onset day(s) in the last 90 "
               f"(elevated resting HR + suppressed HRV together). {tip} Directional "
               f"wellness signal only \u2014 not medical advice.")
    return style(fig, 380, hover="x unified", date_axis=True), insight


def fig_illness_signal(rec):
    if rec.empty:
        return None
    d = rec[rec["date"] >= rec["date"].max() - pd.Timedelta(days=365)].copy()
    if d.empty:
        return None
    fig = go.Figure()
    fig.add_hline(y=0, line_color=MUTED, line_width=1)
    fig.add_hline(y=5, line_dash="dot", line_color=ACCENT, line_width=1)
    colors = ["rgba(250,60,76,0.9)" if f else "rgba(46,127,255,0.30)" for f in d["flag"]]
    fig.add_bar(x=d["date"], y=d["rhr_delta"], name="Resting HR vs baseline",
                marker_color=colors, hovertemplate="%{y:+.1f} bpm")
    fig.update_yaxes(title="bpm above baseline")
    flags = int(d["flag"].sum())
    worst = d.loc[d["rhr_delta"].idxmax()] if not d.empty else None
    insight = (f"Each bar is the day's resting heart rate versus your rolling baseline. "
               f"Bars turn <b>red</b> when resting HR is &gt;5 bpm above normal "
               f"<i>and</i> HRV is suppressed \u2014 the combination that often precedes "
               f"feeling unwell. <b>{flags}</b> such day(s) in the last year"
               + (f", peaking at <b>+{worst['rhr_delta']:.0f} bpm</b> on "
                  f"{worst['date']:%b %d}" if worst is not None else "")
               + ". The dotted line is the +5 bpm alert threshold.")
    return style(fig, 380, date_axis=True, legend=False), insight


# ====================================================================== #
#  ASSEMBLE
# ====================================================================== #
def kpi_card(label, value, sub=""):
    return f"""<div class="kpi"><div class="kpi-val">{value}</div>
    <div class="kpi-lbl">{label}</div><div class="kpi-sub">{sub}</div></div>"""


def section(title, subtitle, cards):
    blocks = "".join(c for c in cards if c)
    return f"""<section><h2>{title}</h2><p class="sub">{subtitle}</p>
    <div class="grid">{blocks}</div></section>"""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    act = load("daily_activity.parquet")
    heart = load("daily_heart.parquet")
    sleep = load("sleep.parquet")
    workouts = load("workouts.parquet")
    routes = load("routes.parquet")
    meta_path = os.path.join(DATA_DIR, "meta.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}

    if act.empty:
        raise SystemExit("No activity data found. Run parse_export.py first.")

    nights = build_nights(sleep)
    recovery = compute_recovery(heart, nights)

    # Build titled cards. The first chart carries the inline plotly.js bundle.
    first = [True]

    def C(title, result):
        """Wrap a (fig, insight) result in a titled card with an interpretation."""
        if result is None:
            return None
        fig, insight = result
        chart = div(fig, first=first[0])
        first[0] = False
        return (f'<div class="card"><div class="card-head">'
                f'<h3>{title}</h3><p class="insight">{insight}</p></div>'
                f'{chart}</div>')

    activity_figs = [
        C("Daily steps &amp; 30-day trend", fig_steps(act)),
        C("Steps calendar heatmap", fig_steps_heatmap(act)),
        C("Distance on foot, per month", fig_monthly_distance(act)),
        C("Energy burned, per month", fig_energy(act)),
    ]
    heart_figs = [
        C("Resting heart rate", fig_resting_hr(heart)),
        C("Heart-rate range (last 12 months)", fig_hr_range(heart)),
        C("Heart-rate variability (HRV)", fig_hrv(heart)),
        C("Cardio fitness (VO\u2082 max)", fig_vo2max(heart)),
    ]
    sleep_figs = [
        C("Sleep duration per night", fig_sleep_duration(nights)),
        C("Bedtime consistency", fig_bedtime(nights)),
    ]
    recovery_figs = [
        C("Daily readiness score", fig_readiness(recovery)),
        C("Illness early-warning signal", fig_illness_signal(recovery)),
    ]
    workout_figs = [
        C("Workouts per month", fig_workouts_per_month(workouts)),
        C("Workout types", fig_workout_types(workouts)),
        C("GPS route distance &amp; pace", fig_route_distance(routes)),
    ]

    # KPIs
    avg_steps = int(act["steps"].mean()) if len(act) else 0
    total_km = meta.get("total_distance_km", round(act["distance_km"].sum(), 0))
    span = f"{meta.get('date_min', '')} → {meta.get('date_max', '')}"
    if not recovery.empty:
        cur_ready = recovery["readiness_roll"].iloc[-1]
        readiness_kpi = kpi_card("Readiness", f"{cur_ready:.0f}/100", "7-day recovery")
    else:
        readiness_kpi = ""
    kpis = "".join([
        kpi_card("Total steps", f"{meta.get('total_steps', 0):,}", "all-time"),
        kpi_card("Avg steps / day", f"{avg_steps:,}", ""),
        kpi_card("Distance", f"{total_km:,.0f} km", "walk + run"),
        kpi_card("Tracked days", f"{meta.get('active_days', len(act)):,}", ""),
        kpi_card("Workouts", f"{meta.get('workout_count', 0):,}",
                 f"{len(routes)} with GPS"),
        readiness_kpi,
        kpi_card("Records parsed", f"{meta.get('record_count', 0):,}", ""),
    ])

    routes_link = ""
    if os.path.exists(os.path.join(OUT_DIR, "routes_map.html")):
        routes_link = '<a class="maplink" href="routes_map.html" target="_blank">Open interactive route map &rarr;</a>'

    html = f"""<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apple Health Dashboard</title>
<style>
:root {{ --ink:{INK}; --muted:{MUTED}; --accent:{ACCENT}; --parchment:#f5f5f7;
         --hairline:rgba(0,0,0,.10); --canvas:#fff; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; font-family:-apple-system,"SF Pro Text","SF Pro Display",Segoe UI,Roboto,sans-serif;
       color:var(--ink); background:var(--parchment); -webkit-font-smoothing:antialiased;
       text-rendering:optimizeLegibility; }}
header {{ background:var(--canvas); color:var(--ink); padding:46px 28px 34px;
          border-bottom:1px solid var(--hairline); }}
header .wrap {{ padding:0 20px; }}
header h1 {{ margin:0 0 6px; font-size:34px; font-weight:600; letter-spacing:-.6px; }}
header p {{ margin:0; color:var(--muted); font-size:17px; letter-spacing:-.2px; }}
.wrap {{ max-width:1180px; margin:0 auto; padding:0 20px 60px; }}
.kpis {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
         gap:14px; margin:28px auto; max-width:1180px; padding:0 20px; }}
.kpi {{ background:var(--canvas); border-radius:18px; padding:20px 22px;
        border:1px solid var(--hairline); }}
.kpi-val {{ font-size:28px; font-weight:600; letter-spacing:-.6px; }}
.kpi-lbl {{ color:var(--muted); font-size:13px; margin-top:4px; letter-spacing:-.1px; }}
.kpi-sub {{ color:#a1a1a6; font-size:11px; }}
nav {{ position:sticky; top:0; background:rgba(245,245,247,.8);
       backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); z-index:10;
       padding:12px 0; border-bottom:1px solid var(--hairline); }}
nav .navwrap {{ max-width:1180px; margin:0 auto; padding:0 20px; }}
nav a {{ color:var(--ink); text-decoration:none; margin-right:22px; font-size:14px;
         font-weight:400; opacity:.65; letter-spacing:-.2px; transition:opacity .15s,color .15s; }}
nav a:hover {{ opacity:1; color:var(--accent); }}
section {{ margin-top:52px; scroll-margin-top:64px; }}
section h2 {{ font-size:26px; margin:0 0 4px; font-weight:600; letter-spacing:-.5px; }}
section .sub {{ color:var(--muted); margin:0 0 20px; font-size:16px; letter-spacing:-.2px; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(480px,1fr)); gap:20px;
         align-items:start; }}
.card {{ background:var(--canvas); border-radius:18px; padding:20px 20px 10px;
         border:1px solid var(--hairline); overflow:hidden; }}
.card-head {{ margin-bottom:8px; }}
.card-head h3 {{ margin:0 0 8px; font-size:16px; font-weight:600; letter-spacing:-.3px; }}
.insight {{ margin:0; font-size:13px; line-height:1.55; color:#3a3a3c;
           background:var(--parchment); border-left:3px solid var(--accent);
           border-radius:0 10px 10px 0; padding:10px 14px; }}
.insight b {{ color:var(--ink); font-weight:600; }}
.maplink {{ display:inline-block; margin:22px 0; padding:14px 24px; background:var(--canvas);
            border:1px solid var(--hairline); border-radius:9999px; text-decoration:none;
            color:var(--accent); font-weight:600; font-size:15px; letter-spacing:-.2px;
            transition:background .15s; }}
.maplink:hover {{ background:var(--parchment); }}
footer {{ text-align:center; color:var(--muted); font-size:12px; padding:36px; }}
@media (max-width:560px) {{ .grid {{ grid-template-columns:1fr; }} header h1 {{ font-size:28px; }} }}
</style></head><body>
<header><div class="wrap">
  <h1>Apple Health Dashboard</h1>
  <p>{span} &nbsp;&middot;&nbsp; generated {meta.get('generated','')}</p>
</div></header>
<div class="kpis">{kpis}</div>
<nav><div class="navwrap"><a href="#activity">Activity</a><a href="#heart">Heart &amp; Cardio</a>
  <a href="#recovery">Recovery</a><a href="#sleep">Sleep</a><a href="#workouts">Workouts</a></div></nav>
<div class="wrap">
  <a name="activity"></a>{section("Activity", "Steps, distance and energy across the full history.", activity_figs)}
  <a name="heart"></a>{section("Heart &amp; Cardio", "Resting heart rate, variability and aerobic fitness.", heart_figs)}
  {('<a name="recovery"></a>' + section("Recovery", "A derived daily readiness score and illness early-warning, scored against your own baseline.", recovery_figs)) if recovery_figs and any(recovery_figs) else ""}
  <a name="sleep"></a>{section("Sleep", "Nightly sleep duration and bedtime consistency.", sleep_figs)}
  <a name="workouts"></a>{section("Workouts &amp; Routes", "Workout cadence, types and GPS-tracked routes.", workout_figs)}
  {routes_link}
</div>
<footer>Built from your Apple Health export · all processing local · no data leaves your machine</footer>
</body></html>"""

    out = os.path.join(OUT_DIR, "dashboard.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print("Wrote", out)


if __name__ == "__main__":
    main()
