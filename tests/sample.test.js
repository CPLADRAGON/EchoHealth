// End-to-end smoke test for the demo generator (web/sample.js) + parser.
// Shims the few browser globals sample.js needs, builds the synthetic export,
// then runs its export.xml through the real parser and asserts the dashboard
// data (incl. the injected anomalies and GPS routes) comes out as expected.

const test = require("node:test");
const assert = require("node:assert");

// --- browser shims (must be set before requiring sample.js) ---
global.window = global.window || {};
global.TextEncoder = require("node:util").TextEncoder;
global.File = class { constructor(parts, name){ this.parts = parts; this.name = name; } };
const _captured = {};
global.fflate = { zipSync: (files) => { Object.assign(_captured, files); return new Uint8Array([0]); } };

require("../web/sample.js");
const P = require("../web/parser.js");
const dec = new TextDecoder();

function parseXml(xml){
  const A = P.newAgg();
  P.scanMe(A, xml);
  const re = new RegExp(P.TAG_RE.source, "g");
  let m;
  while ((m = re.exec(xml)) !== null) P.handleTag(A, m[0]);
  return P.finalize(A);
}

test("sample: generator builds a parseable multi-metric export", () => {
  const file = global.window.buildSampleFile();
  assert.strictEqual(file.name, "export.zip");
  const xml = dec.decode(_captured["apple_health_export/export.xml"]);
  const r = parseXml(xml);

  assert.ok(r.meta.records > 3000, "expected a few thousand records, got " + r.meta.records);
  assert.ok(r.steps_daily.x.length > 380, "expected ~430 step days");
  assert.ok(r.sleep.x.length > 380, "expected ~430 sleep nights");
  assert.ok(r.resting_hr.x.length > 300, "expected most days to have RHR");
  assert.ok(r.hrv.x.length > 280, "expected most days to have HRV");
  assert.ok(r.meta.workouts > 50, "expected plenty of workouts");
  assert.ok(r.workout_types.length >= 4, "expected several workout types");
  assert.strictEqual(r.meta.sex, "male");
  assert.ok(r.sleep_stages.x.length > 380, "expected per-night sleep stages");
});

test("sample: injected shifts are detected by detectAnomalies", () => {
  const xml = dec.decode(_captured["apple_health_export/export.xml"]);
  const r = parseXml(xml);

  const rhr = P.detectAnomalies(r.resting_hr, { z: 2, minMonths: 6 });
  assert.ok(rhr.some(a => a.dir === "up"), "expected an upward resting-HR shift");

  const sleep = P.detectAnomalies(r.sleep, { z: 2, minMonths: 6 });
  assert.ok(sleep.some(a => a.dir === "down"), "expected a downward sleep shift");

  const steps = P.detectAnomalies(r.steps_daily, { z: 2, minMonths: 6 });
  assert.ok(steps.some(a => a.dir === "down"), "expected a sedentary (down) step month");
});

test("sample: same-day and lagged correlations have enough overlap", () => {
  const xml = dec.decode(_captured["apple_health_export/export.xml"]);
  const r = parseXml(xml);
  assert.ok(P.correlate(r.steps_daily, r.resting_hr, 0).n > 250, "same-day overlap");
  assert.ok(P.correlate(r.sleep, r.resting_hr, 1).n > 250, "next-day overlap");
});

test("sample: GPS routes are valid GPX with distance + duration", () => {
  global.window.buildSampleFile();
  const keys = Object.keys(_captured).filter(k => k.endsWith(".gpx"));
  assert.strictEqual(keys.length, 3, "expected 3 sample routes");
  for (const k of keys){
    const gpx = dec.decode(_captured[k]);
    const pts = P.extractRoutePoints(gpx);
    assert.ok(pts.length >= 2, "route has points");
    assert.ok(P.routePathKm(pts) > 0, "route has positive distance");
    assert.ok(P.routeDurationSec(gpx) > 0, "route has a timed duration");
    assert.ok(/route_\d{4}-\d{2}-\d{2}_\d{1,2}\.\d{2}(am|pm)\.gpx$/.test(k), "route filename is parseable: " + k);
  }
});
