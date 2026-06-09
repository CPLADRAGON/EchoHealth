# EchoHealth — Feature Roadmap Design Spec

Date: 2026-06-09
Status: Draft for review
Author: pairing session

## Context

EchoHealth is a single self-contained `web/index.html` (plus a thin `web/api/chat.js`
Gemini proxy). Everything runs client-side: a streaming pure-JS parser reads the
Apple Health `export.zip`/`export.xml`, aggregates into series, and renders KPIs,
six Plotly charts, per-chart insights, a Streaks & records panel, a Leaflet routes
map, an AI assistant, a printable report, and a year-in-review share card. It has a
year/period filter, EN/中文 i18n, and light/dark themes.

Competitive research (GitHub `apple-health` topic + consumer apps like Strava,
Gyroscope, Exist.io, Bearable, Oura) shows EchoHealth's differentiator is being
**zero-install, 100% on-device, nothing-uploaded** while still offering a polished
dashboard + AI + maps + share cards. No public competitor occupies that exact niche.

This spec covers six research-inspired features, all of which must preserve the
core constraints below.

## Cross-cutting constraints (apply to every feature)

- **On-device only.** No new network calls except the existing chat proxy. New
  libraries must be lazy-loaded from CDN like Plotly/Leaflet/jsPDF.
- **No emoji.** Apple-style design tokens (CSS variables) only.
- **Bilingual.** Every user-facing string gets `en` + `zh` i18n keys; re-renders on
  language toggle.
- **Theme-aware.** New UI uses tokens so light/dark both work; charts read
  `--chart-*` tokens at draw time.
- **Period-aware.** New panels recompute when the year filter changes (wire into
  `applyPeriod()` and the `filterResultByYear()` slicer).
- **Share/report integration.** Where it makes sense, surface new visuals on the
  share card / report (which intentionally render light).
- **Privacy.** AI summary continues to send only derived stats, never raw records.

## Current parser data inventory (what's already captured)

| Series | Source type | Notes |
|---|---|---|
| `day_steps` | StepCount | daily sum |
| `day_dist` | DistanceWalkingRunning | daily sum (km) |
| `rhr` | RestingHeartRate | per-day list → daily avg |
| `hrv` | HeartRateVariabilitySDNN | per-day list → daily avg |
| `sleep_night` | SleepAnalysis (value contains "Asleep") | summed hours/night, **stages merged** |
| `workouts_month` | Workout | **count only** — no type/duration/distance |
| `energy` | ActiveEnergyBurned | mapped in `SUM_TYPES` but **never stored** (latent bug) |

Not yet parsed: BodyMass, VO2Max, BloodPressure(Systolic/Diastolic), FlightsClimbed,
MindfulSession, sleep stage values, workout `workoutActivityType`/duration.

---

## Feature 1 — Correlations / cross-metric insights  *(highest differentiation)*

**What:** A panel that surfaces relationships between daily metrics, e.g.
"You sleep ~40 min more on days you walk >10k steps" or "Resting HR trends up the
week after low-sleep stretches." Pearson correlation across day-aligned pairs.

**Data:** Already available — `day_steps`, `sleep_night`, `rhr`, `hrv`, `day_dist`.
Align by date key; require a minimum overlap (e.g. ≥30 shared days) to show a pair.

**Approach:**
- Add `computeCorrelations(r)`: for each candidate pair, inner-join on date, compute
  Pearson r, keep pairs with |r| ≥ 0.2 and n ≥ 30.
- Render as a "Patterns" card list with a plain-language sentence per finding plus
  the r value and sample size. Strong "correlation ≠ causation, not medical advice"
  disclaimer.
- Optionally a small scatter (Plotly) for the top pair.
- Feed the top 2–3 findings into the AI summary so the assistant can discuss them.

**Effort:** Medium. **Risk:** statistical over-claiming → mitigate with conservative
thresholds + explicit disclaimer and neutral wording ("tends to", "associated with").

## Feature 2 — PWA: installable + offline  *(cheap, high perceived quality)*

**What:** Add-to-home-screen install + offline load. Reinforces "runs locally."

**Approach:**
- Add `manifest.webmanifest` (name, icons, theme/background colors, display
  standalone) and link it.
- Add a minimal `service-worker.js` that precaches the app shell (the single HTML;
  CDN libs are runtime-cached or left network-first). App already works offline once
  loaded except CDN scripts — SW makes the shell reliable.
- Provide app icons (generate simple EchoHealth mark, light + maskable).
- Respect privacy: SW caches only static assets, never user data.

**Effort:** Low–Medium. **Risk:** SW cache staleness → use versioned cache + skipWaiting
prompt. CDN libs offline: document that AI/maps need network; core dashboard works.

## Feature 3 — More metrics (weight, VO₂ max / fitness age, BP, flights)  *(broader appeal)*

**What:** Parse and surface additional common metrics when present; auto-hide when
absent. VO₂ max → a shareable "fitness age"-style highlight.

**Data:** New parser aggregators for BodyMass, VO2Max, BloodPressureSystolic +
Diastolic (paired), FlightsClimbed (daily sum). Also fix the latent `energy` storage
so Active Energy can be shown.

**Approach:**
- Extend `newAgg()` + `handleTag()` + `finalize()` with the new series.
- Add KPI cards / charts gated on presence (consistent with current "only render if
  data" pattern).
- VO₂ max highlight card; flights as a daily/monthly bar; weight as a trend line;
  BP as paired sys/dia line. All period-aware.
- Add the most useful ones to the AI summary + share card.

**Effort:** Medium (parser + several render blocks + i18n). **Risk:** unit/locale
variance (kg vs lb, mmHg) → read `unit="…"` attribute where needed; keep raw unit.

## Feature 4 — Animated multi-slide recap (Strava-style)  *(virality)*

**What:** Turn the static share card into a few tap-through "story" panels
(totals → best day → longest route → streaks → outro) in the preview modal.

**Approach:**
- Reuse `buildShareCard` canvas primitives; render N slides into an array of canvases.
- Lightweight in-modal carousel: prev/next + dots, keyboard arrows, swipe on touch.
- "Save current slide" + optional "save all" (zip via existing fflate, or sequential
  downloads). Keep the single-card path as the default.

**Effort:** Medium. **Risk:** modal complexity / a11y → reuse existing dialog focus
patterns; ensure Esc/close still work.

## Feature 5 — Sleep stages + consistency score  *(deepen most-engaged metric)*

**What:** Stacked sleep chart (Core/Deep/REM/Awake) when stage data exists, plus a
sleep-consistency score (regularity of sleep/wake times).

**Data:** Newer exports encode stages in the SleepAnalysis `value`
(`AsleepCore`/`AsleepDeep`/`AsleepREM`/`AsleepUnspecified`/`Awake`/`InBed`). Current
code merges all "Asleep*" into one number — needs to split by value. Consistency uses
sleep start/end clock times per night.

**Approach:**
- Extend sleep aggregation to keep per-stage hours per night and bed/wake clock times.
- Stacked bar chart for stages (gated on stage data; fall back to current total-hours
  chart for older exports).
- Consistency score: stdev of sleep-onset and wake times → 0–100; show as a record/KPI.

**Effort:** Medium–High (parser change is the crux). **Risk:** older exports lack
stages → must gracefully fall back to today's behavior.

## Feature 6 — Weekday / hour activity heatmap  *(proven engagement)*

**What:** "You're most active on Saturdays / least on Tuesdays." A 7-row
(day-of-week) heatmap of average steps, optionally a 7×24 day×hour grid if hourly
data is retained (currently steps are aggregated daily, so day-of-week is the
realistic v1).

**Data:** Derive day-of-week from existing `day_steps` date keys. (Hour-level would
require retaining intra-day step buckets — larger parser change; defer.)

**Approach:**
- `computeWeekday(r)`: average steps per weekday (Mon–Sun), normalize, render as a
  canvas/Plotly heatmap or 7 mini-bars.
- Period-aware; optional inclusion on the share card.

**Effort:** Low–Medium. **Risk:** weekday-only is less wow than day×hour → frame as
"weekly rhythm"; consider hourly as a later enhancement.

---

## Recommended sequence

1. **Feature 1 — Correlations** (biggest differentiator, data ready)
2. **Feature 6 — Weekday rhythm** (cheap, complements correlations)
3. **Feature 3 — More metrics** (broadens appeal; fixes latent energy bug)
4. **Feature 5 — Sleep stages** (parser-deep; high value for engaged users)
5. **Feature 2 — PWA** (polish/retention; independent of data work)
6. **Feature 4 — Animated recap** (virality capstone; benefits from 1/3/6 visuals)

Rationale: front-load the on-device, data-ready, high-differentiation items; group the
two parser-extension features (3, 5); finish with the independent polish (PWA) and the
capstone (recap) that showcases everything built before it.

## Open questions

1. Correlations: show the scatter plot for the top pair, or keep it text-only for v1?
2. More metrics: which subset first — VO₂ max "fitness age" only, or the full set?
3. PWA icons: generate a simple EchoHealth wordmark/glyph, or do you have a logo?
4. Recap: single-slide "save all" as a zip, or sequential downloads?

## Resolved decisions (2026-06-09)

1. **Correlations** — text-only findings for v1, plus **one** scatter (Plotly) for the
   single strongest pair only. Conservative thresholds (|r| ≥ 0.2, n ≥ 30) + explicit
   "correlation ≠ causation / not medical advice" disclaimer.
2. **More metrics** — **full set**: BodyMass (weight trend), VO₂ max (+ "fitness age"
   highlight), BloodPressure (paired systolic/diastolic), FlightsClimbed. Also fix the
   latent Active Energy storage bug.
3. **PWA icon** — generate an **"echo-pulse" mark**: rounded-square tile in accent red
   `#fa3c4c`, white ECG/heartbeat pulse line with a soft trailing "echo" wave at lower
   opacity. Deliver `icon-192`, `icon-512`, a **maskable** variant, and a 180px
   `apple-touch-icon`, all from one SVG.
4. **Recap "Save all"** — **sequential downloads** (no zip). Plus a "Save current slide"
   action.
5. **PWA install reminder** — dismissible, bilingual, theme-aware banner. Uses
   `beforeinstallprompt` for a real Install button on Android/Chrome; on iOS Safari
   shows "Tap Share, then Add to Home Screen" guidance. Remembers dismissal
   (localStorage) and hides when already installed (`display-mode: standalone`).

## Out of scope (for now)

- Multi-source data (Garmin/Oura/Whoop imports).
- Server-side storage or accounts.
- Hour-level heatmap (needs intra-day step retention).
- Workout-type donut (needs `workoutActivityType` parsing — easy add later).
