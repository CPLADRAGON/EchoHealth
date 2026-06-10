/* =====================================================================
   EchoHealth — sample / demo export generator

   Builds a realistic synthetic Apple Health export (export.zip with an
   export.xml plus a few GPX workout routes) entirely in the browser, so a
   first-time visitor can see the full dashboard without their own — often
   ~800 MB — export. The output is fed through the exact same parse pipeline a
   real upload uses (parseHealthExport), so this also doubles as an end-to-end
   smoke path for the parser.

   Deterministic-ish synthetic data with a few intentionally injected shifts
   (a sedentary month, a resting-HR bump with matching HRV dip, a multi-week
   sleep dip) so the anomaly panel, correlations and heatmap all light up.

   Exposes a single global: window.buildSampleFile() -> File("export.zip").
   ===================================================================== */
(function(){
  "use strict";
  if (typeof window === "undefined") return;

  function rng(seed){ let s = seed >>> 0; return function(){ s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  let R = rng(20240611);
  function noise(scale){ return (R() + R() - 1) * scale; }
  function pad(n){ return n < 10 ? "0" + n : "" + n; }
  const DAY = 86400000;

  function dayMs(ms){ const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function monthStr(ms){ const d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1); }
  function fmtAt(ms, hh, mm){ const d = new Date(ms);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
      " " + pad(hh) + ":" + pad(mm) + ":00 +0000"; }
  function fmtFull(ms){ const d = new Date(ms);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
      " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + " +0000"; }
  function isoT(ms){ return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"); }

  const T = {
    steps:   "HKQuantityTypeIdentifierStepCount",
    dist:    "HKQuantityTypeIdentifierDistanceWalkingRunning",
    energy:  "HKQuantityTypeIdentifierActiveEnergyBurned",
    flights: "HKQuantityTypeIdentifierFlightsClimbed",
    rhr:     "HKQuantityTypeIdentifierRestingHeartRate",
    hrv:     "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
    weight:  "HKQuantityTypeIdentifierBodyMass",
    vo2:     "HKQuantityTypeIdentifierVO2Max",
    bps:     "HKQuantityTypeIdentifierBloodPressureSystolic",
    bpd:     "HKQuantityTypeIdentifierBloodPressureDiastolic",
    sleep:   "HKCategoryTypeIdentifierSleepAnalysis",
  };

  function buildSampleXml(){
    const end = dayMs(Date.now());
    const NDAYS = 430;
    const start = end - (NDAYS - 1) * DAY;

    const sedentaryMonth = monthStr(end - 120 * DAY);   // steps drop ~45%
    const rhrBumpMonth   = monthStr(end - 90 * DAY);    // resting HR up, HRV down
    const sleepDipCenter = dayMs(end - 180 * DAY);      // ~3-week sleep dip
    const sleepDipFrom = sleepDipCenter - 10 * DAY, sleepDipTo = sleepDipCenter + 10 * DAY;

    const L = [];
    function pt(type, ms, hh, mm, value, unit){
      const ts = fmtAt(ms, hh, mm);
      L.push('<Record type="' + type + '" sourceName="Sample" startDate="' + ts + '" endDate="' + ts +
        '" value="' + value + '"' + (unit ? ' unit="' + unit + '"' : '') + '/>');
    }
    function span(type, sMs, eMs, value){
      L.push('<Record type="' + type + '" sourceName="Sample" startDate="' + fmtFull(sMs) +
        '" endDate="' + fmtFull(eMs) + '" value="' + value + '"/>');
    }

    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<!DOCTYPE HealthData>');
    L.push('<HealthData locale="en_US">');
    L.push('<ExportDate value="' + fmtAt(end, 9, 0) + '"/>');
    L.push('<Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale" ' +
      'HKCharacteristicTypeIdentifierBloodType="HKBloodTypeNotSet" ' +
      'HKCharacteristicTypeIdentifierDateOfBirth="1990-05-01"/>');

    for (let i = 0; i < NDAYS; i++){
      const ms = start + i * DAY;
      const d = new Date(ms);
      const dow = d.getUTCDay();
      const weekend = (dow === 0 || dow === 6);
      const mo = monthStr(ms);
      const season = Math.sin((i / 365) * 2 * Math.PI);

      // steps + derived activity
      let steps = (weekend ? 10800 : 8400) + season * 900 + noise(2200);
      if (mo === sedentaryMonth) steps *= 0.55;
      steps = Math.max(1200, Math.round(steps));
      pt(T.steps, ms, 12, 0, steps);
      pt(T.dist, ms, 12, 0, Math.max(0.3, Math.round((steps / 1380) * 100) / 100), "km");
      pt(T.energy, ms, 12, 0, Math.round(steps * 0.045 + 180 + noise(80)), "kcal");
      pt(T.flights, ms, 12, 0, Math.max(0, Math.round(9 + noise(7))), "count");

      // resting HR (with injected bump) — skip ~10% of days
      if (R() > 0.10){
        let rhr = 56 + season * 1.5 + noise(3);
        if (mo === rhrBumpMonth) rhr += 8;
        pt(T.rhr, ms, 7, 30, Math.round(rhr), "count/min");
      }
      // HRV (dips during the same stressed month) — skip ~15%
      if (R() > 0.15){
        let hrv = 48 - season * 2 + noise(8);
        if (mo === rhrBumpMonth) hrv -= 12;
        pt(T.hrv, ms, 7, 32, Math.max(12, Math.round(hrv)), "ms");
      }

      // sleep: three stage blocks just after midnight, ending on this day
      let H = 7.3 + noise(0.7);
      if (ms >= sleepDipFrom && ms <= sleepDipTo) H = 5.5 + noise(0.4);
      H = Math.max(3.5, Math.min(9.5, H));
      let c = ms + 10 * 60000;
      const coreMs = H * 0.60 * 3600000, deepMs = H * 0.18 * 3600000, remMs = H * 0.22 * 3600000;
      span(T.sleep, c, c + coreMs, "HKCategoryValueSleepAnalysisAsleepCore"); c += coreMs;
      span(T.sleep, c, c + deepMs, "HKCategoryValueSleepAnalysisAsleepDeep"); c += deepMs;
      span(T.sleep, c, c + remMs, "HKCategoryValueSleepAnalysisAsleepREM");

      // weight (slow downward trend) every 3 days
      if (i % 3 === 0) pt(T.weight, ms, 7, 0, Math.round((78 - (i / NDAYS) * 4 + noise(0.5)) * 10) / 10, "kg");
      // VO2 max once a month
      if (d.getUTCDate() === 1) pt(T.vo2, ms, 8, 0, Math.round((41 + (i / NDAYS) * 3 + noise(0.6)) * 10) / 10, "mL/min\u00b7kg");
      // blood pressure weekly
      if (i % 7 === 0){
        pt(T.bps, ms, 8, 0, Math.round(120 + noise(6)), "mmHg");
        pt(T.bpd, ms, 8, 1, Math.round(78 + noise(4)), "mmHg");
      }

      // workouts: a few per week, weighted activity mix
      if (R() < (weekend ? 0.6 : 0.4)){
        const types = ["HKWorkoutActivityTypeRunning", "HKWorkoutActivityTypeWalking",
          "HKWorkoutActivityTypeFunctionalStrengthTraining", "HKWorkoutActivityTypeCycling",
          "HKWorkoutActivityTypeYoga", "HKWorkoutActivityTypeHighIntensityIntervalTraining"];
        const wt = types[Math.floor(R() * types.length)];
        const dur = Math.round(25 + R() * 40);
        const sMs = ms + (17 * 60 + Math.floor(R() * 60)) * 60000;
        L.push('<Workout workoutActivityType="' + wt + '" duration="' + dur +
          '" durationUnit="min" sourceName="Sample" startDate="' + fmtFull(sMs) +
          '" endDate="' + fmtFull(sMs + dur * 60000) + '"/>');
      }
    }
    L.push('</HealthData>');
    return L.join("\n");
  }

  // A short GPX loop near a center point, ~45 timestamped track points.
  function buildGpx(def){
    const N = 45;
    const h24 = def.ap === "pm" ? (def.h12 === 12 ? 12 : def.h12 + 12) : (def.h12 === 12 ? 0 : def.h12);
    const startMs = def.day + (h24 * 60 + def.m) * 60000;
    let s = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Sample"><trk><name>Sample</name><trkseg>';
    for (let i = 0; i < N; i++){
      const ang = (i / N) * 2 * Math.PI;
      const lat = def.lat + Math.sin(ang) * 0.006 + noise(0.0003);
      const lon = def.lon + Math.cos(ang) * 0.008 + noise(0.0003);
      s += '<trkpt lat="' + lat.toFixed(6) + '" lon="' + lon.toFixed(6) + '"><ele>20</ele><time>' +
        isoT(startMs + i * 35000) + '</time></trkpt>';
    }
    return s + '</trkseg></trk></gpx>';
  }

  function buildRoutes(){
    const end = dayMs(Date.now());
    const defs = [
      { day: end - 20 * DAY, h12: 7, m: 5,  ap: "am", lat: 37.7694, lon: -122.4862 },
      { day: end - 55 * DAY, h12: 6, m: 40, ap: "am", lat: 37.8078, lon: -122.4750 },
      { day: end - 95 * DAY, h12: 6, m: 15, ap: "pm", lat: 37.7599, lon: -122.4148 },
    ];
    const out = [];
    for (const def of defs){
      const d = new Date(def.day);
      const name = "apple_health_export/workout-routes/route_" +
        d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
        "_" + def.h12 + "." + pad(def.m) + def.ap + ".gpx";
      out.push({ name: name, gpx: buildGpx(def) });
    }
    return out;
  }

  function buildSampleFile(){
    if (typeof fflate === "undefined" || !fflate.zipSync) throw new Error("FFLATE_MISSING");
    R = rng(20240611); // reset so each call produces the same demo dataset
    const enc = new TextEncoder();
    const files = { "apple_health_export/export.xml": enc.encode(buildSampleXml()) };
    for (const r of buildRoutes()) files[r.name] = enc.encode(r.gpx);
    const zipped = fflate.zipSync(files, { level: 6 });
    return new File([zipped], "export.zip", { type: "application/zip" });
  }

  window.buildSampleFile = buildSampleFile;
})();
