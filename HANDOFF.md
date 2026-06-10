# EchoHealth — Session Handoff

Snapshot for continuing work (e.g. in Copilot CLI). The chat history doesn't
transfer between tools, but the repo + this note do. Read this, then
`git log --oneline -20` and `README.md`.

Last commit at handoff: `afc67db` (cache-busting fix).

## Quick start

```powershell
cd "C:\Users\wangbo\Desktop\Work\Personal Repo\Apple_Health"
git pull
node --test          # run the parser test suite (should be 22 passing)
cd web; python -m http.server 8000   # local preview (no AI chat without the deployed proxy)
```

Deploy: push to `main` → Vercel auto-deploys (~1 min). Repo:
github.com/CPLADRAGON/EchoHealth. Live: echo-health-lemon.vercel.app.

## Architecture (web/ static app, no build step)

- `web/index.html` — markup + head only (~8 KB after the Tier 1 split).
- `web/styles.css` — all CSS (token-based theming, `[data-theme="dark"]`).
- `web/parser.js` — pure parse/aggregation core. DOM-free, dependency-free,
  loaded before app.js, and unit-tested in Node. Browser-only streaming/unzip
  wrapper (`parseHealthExport`) lives in app.js and calls into this.
- `web/app.js` — all app logic (UI, charts, map, recap, AI client, i18n dict).
- `web/api/chat.js` — Vercel serverless proxy to Gemini (key server-side only;
  only summary stats sent, never raw records).
- `web/service-worker.js` + `manifest.webmanifest` + icons — PWA shell.
- `web/vercel.json` — clean URLs + security headers (CSP etc.).
- `tests/parser.test.js` — Node test runner, `.github/workflows/ci.yml` runs it.

### Conventions (important)
- Heavy libs lazy-loaded on demand: Plotly (charts), Leaflet (map), jsPDF (PDF).
  fflate (zip) loads up front. No WebGL traces (use SVG `scatter`/`pie`).
- All user-facing strings go through the `I18N` dict in app.js (`en` + `zh`);
  re-render on language toggle. No emoji.
- File-derived strings are escaped via `esc()` before any `innerHTML`.
- **Cache-busting**: local asset URLs are versioned (`app.js?v=N`,
  `parser.js?v=N`, `styles.css?v=N` in index.html). **When you change app.js,
  parser.js, or styles.css, bump that `?v=` number AND the `CACHE` const in
  service-worker.js** (currently `v8`). Skipping this causes stale-cache bugs
  like the `routePathKm` error fixed in `afc67db`.
- When you change `web/parser.js`, add/update a test in `tests/parser.test.js`.
- Period filter: `filterResultByYear` in app.js re-slices every series by year;
  new series must be added there too. Snapshots/recap use the full all-time
  result, not the filtered view.

## What's shipped (recent arc)

Tier 0 hardening (parser extraction + 22 tests + CI, CSP headers, esc() XSS
fix, README), Tier 1 (file split), Tier 2 features (workout-type donut),
then SEO/OG tags + share image, clickable route popups (distance/duration/
pace), in-page marketing hero, and grouped chart sections with a sticky
jump-nav. Full feature set also includes: 14 charts, streaks/records,
correlations panel, GPS routes map, AI assistant, report export (PNG/PDF),
year-in-review recap carousel, year filter, dark mode, PWA install.

## Open ideas (not yet built)

Ranked by my recommendation:
1. **Anomaly / change detection** — "resting HR jumped ~6 bpm in March",
   "sleep dropped for 3 weeks in Q2". Flag notable shifts in the daily series.
   On-device, high wow. Good fit for the test suite.
2. **AI auto-narrative** — on load, the assistant proactively writes a
   3-sentence "here's your year" instead of waiting for a question.
3. **Sample/demo mode** — a "Try with sample data" button loading a bundled
   synthetic export, so people see the dashboard without their own 800 MB file.
   Biggest activation/funnel win if going public.
4. **Recap auto-play** — Stories-style timed advance with progress rings.
5. **Smarter correlations** — add lag (does poor sleep precede high RHR?), let
   the AI cite patterns by name.
6. **Hour-level heatmap** — needs intra-day step retention (parser change).
7. **Accessibility audit** — WCAG AA contrast pass on accent red (#fa3c4c),
   keyboard nav across the newer sections.
8. **More parser tests** for messy real-world exports (locale decimal commas,
   missing attributes, malformed dates).

Dropped earlier by user decision: on-device longitudinal history (weak appeal).

## Known caveats / honest notes

- `_fitnessAge` uses invented normative slopes — labeled "estimate", not
  clinical. Don't let it grow load-bearing.
- `naiveMs` ignores timezones (documented tradeoff); can shift a late-night
  workout to the adjacent day, slightly affecting streaks/weekday chart.
- Rate limiter in chat.js is per-instance in-memory (best-effort on Vercel
  serverless); would need shared KV to be exact.
- gstack skills (e.g. /autoplan) are BLOCKED on this machine: the gstack `bin/`
  tooling and `codex` CLI aren't installed. Installing Copilot CLI doesn't add
  them.
- Recent route popups + grouped nav were validated via tests + static analysis
  + local load, but not exercised with a real export containing GPS routes /
  workout types. Worth a manual smoke test.
