/* =====================================================================
   EchoHealth — pure parsing core

   Extracted from index.html so it can be unit-tested in Node while still
   loading in the browser as a classic <script> (top-level declarations are
   shared with the main inline script via the global lexical environment).

   This file is DOM-free and dependency-free. The browser-only streaming +
   unzip wrapper (parseHealthExport) stays in index.html; it calls into the
   functions defined here.

   Replaces the former Pyodide/Python pipeline. A multi-year iPhone export is
   ~800MB, which made iOS Safari OOM booting the Python WASM runtime. This
   parser scans complete <Record>/<Workout> opening tags, aggregates, and
   discards processed text, so peak memory stays tiny regardless of file size.
   ===================================================================== */
const SUM_TYPES = {
  "HKQuantityTypeIdentifierStepCount": "steps",
  "HKQuantityTypeIdentifierDistanceWalkingRunning": "distance",
  "HKQuantityTypeIdentifierActiveEnergyBurned": "energy",
  "HKQuantityTypeIdentifierFlightsClimbed": "flights",
};
const RHR_TYPE = "HKQuantityTypeIdentifierRestingHeartRate";
const HRV_TYPE = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";
const WEIGHT_TYPE = "HKQuantityTypeIdentifierBodyMass";
const VO2_TYPE = "HKQuantityTypeIdentifierVO2Max";
const BP_SYS_TYPE = "HKQuantityTypeIdentifierBloodPressureSystolic";
const BP_DIA_TYPE = "HKQuantityTypeIdentifierBloodPressureDiastolic";

// Matches an opening <Record ...> or <Workout ...> tag. The [\s/>] guard
// after the name avoids matching siblings like <WorkoutEvent>/<WorkoutStatistics>.
const TAG_RE = /<(?:Record|Workout)[\s/>][^>]*>/g;
const RE_TYPE  = /\btype="([^"]*)"/;
const RE_START = /\bstartDate="([^"]*)"/;
const RE_END   = /\bendDate="([^"]*)"/;
const RE_VALUE = /\bvalue="([^"]*)"/;
const RE_UNIT  = /\bunit="([^"]*)"/;
const RE_WTYPE = /\bworkoutActivityType="([^"]*)"/;
const RE_WDUR  = /\bduration="([^"]*)"/;
const RE_WDURU = /\bdurationUnit="([^"]*)"/;
function av(tag, re){ const m = re.exec(tag); return m ? m[1] : null; }

// "YYYY-MM-DD HH:MM:SS ..." -> epoch ms, ignoring the timezone suffix.
// Both start and end carry the same offset, so durations are correct.
function naiveMs(s){
  return Date.UTC(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10),
                  +s.slice(11,13), +s.slice(14,16), +s.slice(17,19));
}
function newAgg(){
  return {
    day_steps: new Map(), day_dist: new Map(),
    day_energy: new Map(), day_flights: new Map(),
    rhr: new Map(), hrv: new Map(), sleep_night: new Map(),
    sleep_stage: new Map(), sleep_bound: new Map(),
    weight: new Map(), vo2: new Map(), bp_sys: new Map(), bp_dia: new Map(),
    weight_unit: null, sex: null, meScanned: false,
    workouts_month: new Map(), workout_total: 0, rec: 0,
    workout_types: new Map(),
    dmin: null, dmax: null,
  };
}
function pushList(map, k, v){ const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); }

// The <Me ...> element (once, near the top of export.xml) carries biological
// sex, which lets us pick the right VO2max→fitness-age curve. Best-effort.
const ME_RE = /<Me\b[^>]*>/;
function scanMe(A, text){
  if (A.meScanned) return;
  const m = ME_RE.exec(text);
  if (!m) return;
  A.meScanned = true;
  const s = /HKCharacteristicTypeIdentifierBiologicalSex="([^"]*)"/.exec(m[0]);
  if (s){
    if (/Male/i.test(s[1])) A.sex = "male";
    else if (/Female/i.test(s[1])) A.sex = "female";
  }
}

function handleTag(A, tag){
  if (tag.charCodeAt(1) === 87 /* 'W' -> Workout */){
    const start = av(tag, RE_START);
    if (start){
      const mo = start.slice(0,7);
      A.workouts_month.set(mo, (A.workouts_month.get(mo) || 0) + 1);
      A.workout_total++;
      // per-activity-type tally, keyed by month so the period filter can
      // re-aggregate. Stores count + total minutes per (month, type).
      const wt = av(tag, RE_WTYPE) || "Other";
      let mins = 0;
      const dur = parseFloat(av(tag, RE_WDUR));
      if (!isNaN(dur)){
        const u = (av(tag, RE_WDURU) || "min").toLowerCase();
        mins = u.indexOf("sec") !== -1 ? dur/60 : (u.indexOf("hr") !== -1 || u.indexOf("hour") !== -1 ? dur*60 : dur);
      } else {
        const e = av(tag, RE_END);
        if (e) mins = Math.max(0, (naiveMs(e) - naiveMs(start)) / 60000);
      }
      let byType = A.workout_types.get(mo);
      if (!byType){ byType = new Map(); A.workout_types.set(mo, byType); }
      let agg = byType.get(wt);
      if (!agg){ agg = { count: 0, minutes: 0 }; byType.set(wt, agg); }
      agg.count++; agg.minutes += mins;
    }
    return;
  }
  A.rec++;
  const rtype = av(tag, RE_TYPE);
  const start = av(tag, RE_START);
  const day = start ? start.slice(0,10) : null;
  if (day){
    if (A.dmin === null || day < A.dmin) A.dmin = day;
    if (A.dmax === null || day > A.dmax) A.dmax = day;
  }
  const col = SUM_TYPES[rtype];
  if (col && day){
    const v = parseFloat(av(tag, RE_VALUE));
    if (!isNaN(v)){
      if (col === "steps") A.day_steps.set(day, (A.day_steps.get(day) || 0) + v);
      else if (col === "distance") A.day_dist.set(day, (A.day_dist.get(day) || 0) + v);
      else if (col === "energy") A.day_energy.set(day, (A.day_energy.get(day) || 0) + v);
      else if (col === "flights") A.day_flights.set(day, (A.day_flights.get(day) || 0) + v);
    }
  } else if (rtype === RHR_TYPE && day){
    const v = parseFloat(av(tag, RE_VALUE)); if (!isNaN(v)) pushList(A.rhr, day, v);
  } else if (rtype === HRV_TYPE && day){
    const v = parseFloat(av(tag, RE_VALUE)); if (!isNaN(v)) pushList(A.hrv, day, v);
  } else if (rtype === WEIGHT_TYPE && day){
    const v = parseFloat(av(tag, RE_VALUE));
    if (!isNaN(v)){ pushList(A.weight, day, v); if (!A.weight_unit) A.weight_unit = av(tag, RE_UNIT); }
  } else if (rtype === VO2_TYPE && day){
    const v = parseFloat(av(tag, RE_VALUE)); if (!isNaN(v)) pushList(A.vo2, day, v);
  } else if (rtype === BP_SYS_TYPE && day){
    const v = parseFloat(av(tag, RE_VALUE)); if (!isNaN(v)) pushList(A.bp_sys, day, v);
  } else if (rtype === BP_DIA_TYPE && day){
    const v = parseFloat(av(tag, RE_VALUE)); if (!isNaN(v)) pushList(A.bp_dia, day, v);
  } else if (rtype === SLEEP_TYPE){
    const val = av(tag, RE_VALUE) || "";
    if (val.indexOf("Asleep") !== -1){
      const s = av(tag, RE_START), e = av(tag, RE_END);
      if (s && e){
        const hrs = (naiveMs(e) - naiveMs(s)) / 3600000;
        if (hrs > 0 && hrs < 24){
          const night = e.slice(0,10);
          A.sleep_night.set(night, (A.sleep_night.get(night) || 0) + hrs);
          // per-stage hours (newer exports split sleep into Core/Deep/REM)
          let st = "unspec";
          if (val.indexOf("Core") !== -1) st = "core";
          else if (val.indexOf("Deep") !== -1) st = "deep";
          else if (val.indexOf("REM") !== -1) st = "rem";
          let sg = A.sleep_stage.get(night);
          if (!sg){ sg = {core:0, deep:0, rem:0, unspec:0}; A.sleep_stage.set(night, sg); }
          sg[st] += hrs;
          // earliest onset / latest wake clock times for the consistency score
          const onMs = naiveMs(s), wkMs = naiveMs(e);
          const onClk = (+s.slice(11,13))*60 + (+s.slice(14,16));
          const wkClk = (+e.slice(11,13))*60 + (+e.slice(14,16));
          let bd = A.sleep_bound.get(night);
          if (!bd){ A.sleep_bound.set(night, {onMs, onClk, wkMs, wkClk}); }
          else {
            if (onMs < bd.onMs){ bd.onMs = onMs; bd.onClk = onClk; }
            if (wkMs > bd.wkMs){ bd.wkMs = wkMs; bd.wkClk = wkClk; }
          }
        }
      }
    }
  }
}

function finalize(A){
  const sdays = [...A.day_steps.keys()].sort();
  const svals = sdays.map(d => Math.round(A.day_steps.get(d)));
  const roll = []; const win = []; let s = 0;
  for (const v of svals){
    win.push(v); s += v;
    if (win.length > 30) s -= win.shift();
    roll.push(Math.round(s / win.length));
  }
  const mdist = new Map();
  for (const [d, v] of A.day_dist){ const m = d.slice(0,7); mdist.set(m, (mdist.get(m) || 0) + v); }
  const md_x = [...mdist.keys()].sort();
  const md_y = md_x.map(m => Math.round(mdist.get(m) * 10) / 10);

  const avg = a => a.reduce((p,c)=>p+c,0) / a.length;
  const rhr_x = [...A.rhr.keys()].sort();
  const rhr_y = rhr_x.map(d => Math.round(avg(A.rhr.get(d))));
  const hrv_x = [...A.hrv.keys()].sort();
  const hrv_y = hrv_x.map(d => Math.round(avg(A.hrv.get(d)) * 10) / 10);
  const sl_x = [...A.sleep_night.keys()].sort();
  const sl_y = sl_x.map(d => Math.round(A.sleep_night.get(d) * 100) / 100);
  // per-stage hours, aligned with sl_x (only meaningful when stages exist)
  let hasStages = false;
  const st_core=[], st_deep=[], st_rem=[], st_unspec=[];
  for (const d of sl_x){
    const sg = A.sleep_stage.get(d) || {core:0,deep:0,rem:0,unspec:0};
    if (sg.core || sg.deep || sg.rem) hasStages = true;
    st_core.push(Math.round(sg.core*100)/100);
    st_deep.push(Math.round(sg.deep*100)/100);
    st_rem.push(Math.round(sg.rem*100)/100);
    st_unspec.push(Math.round(sg.unspec*100)/100);
  }
  // bed/wake clock times for the consistency score
  const clk_on=[], clk_wk=[];
  for (const d of sl_x){ const bd = A.sleep_bound.get(d); if (bd){ clk_on.push(bd.onClk); clk_wk.push(bd.wkClk); } }
  const sleep_consistency = _sleepConsistency(clk_on, clk_wk);

  const wm_x = [...A.workouts_month.keys()].sort();
  const wm_y = wm_x.map(m => A.workouts_month.get(m));

  // workout types: sorted by count desc, with friendly names + total minutes
  const wt_list = aggWorkoutTypes(A.workout_types, null);
  // month-keyed raw tally (friendly-named) so the period filter can re-aggregate
  const wt_month = [];
  for (const [mo, types] of A.workout_types){
    const arr = [];
    for (const [raw, agg] of types) arr.push({ type: workoutTypeName(raw), count: agg.count, minutes: agg.minutes });
    wt_month.push({ month: mo, types: arr });
  }

  // weight + VO2 max: per-day averages (line series)
  const wt_x = [...A.weight.keys()].sort();
  const wt_y = wt_x.map(d => Math.round(avg(A.weight.get(d)) * 10) / 10);
  const vo_x = [...A.vo2.keys()].sort();
  const vo_y = vo_x.map(d => Math.round(avg(A.vo2.get(d)) * 10) / 10);

  // blood pressure: per-day averages, aligned on days that have both readings
  const bp_x = [], bp_sys = [], bp_dia = [];
  for (const d of [...A.bp_sys.keys()].sort()){
    if (A.bp_dia.has(d)){
      bp_x.push(d);
      bp_sys.push(Math.round(avg(A.bp_sys.get(d))));
      bp_dia.push(Math.round(avg(A.bp_dia.get(d))));
    }
  }

  // flights climbed + active energy: monthly sums (bar series)
  const fmon = new Map();
  for (const [d, v] of A.day_flights){ const m = d.slice(0,7); fmon.set(m, (fmon.get(m) || 0) + v); }
  const fl_x = [...fmon.keys()].sort();
  const fl_y = fl_x.map(m => Math.round(fmon.get(m)));
  const emon = new Map();
  for (const [d, v] of A.day_energy){ const m = d.slice(0,7); emon.set(m, (emon.get(m) || 0) + v); }
  const en_x = [...emon.keys()].sort();
  const en_y = en_x.map(m => Math.round(emon.get(m)));

  let totalSteps = 0; for (const v of A.day_steps.values()) totalSteps += v;
  let totalDist = 0;  for (const v of A.day_dist.values())  totalDist += v;
  const avg_rhr = rhr_y.length ? Math.round(avg(rhr_y)) : null;
  const latest_vo2 = vo_y.length ? vo_y[vo_y.length-1] : null;
  const fitness_age = _fitnessAge(latest_vo2, A.sex);

  return {
    meta: {
      date_min: A.dmin, date_max: A.dmax, records: A.rec,
      total_steps: Math.round(totalSteps),
      total_distance: Math.round(totalDist * 10) / 10,
      active_days: A.day_steps.size,
      workouts: A.workout_total,
      avg_resting_hr: avg_rhr,
      latest_vo2, fitness_age, sex: A.sex,
      weight_unit: A.weight_unit || "kg",
      sleep_consistency,
    },
    steps_daily: { x: sdays, y: svals, roll },
    monthly_distance: { x: md_x, y: md_y },
    resting_hr: { x: rhr_x, y: rhr_y },
    hrv: { x: hrv_x, y: hrv_y },
    sleep: { x: sl_x, y: sl_y },
    sleep_stages: hasStages ? { x: sl_x, core: st_core, deep: st_deep, rem: st_rem, unspec: st_unspec }
                            : { x: [], core: [], deep: [], rem: [], unspec: [] },
    sleep_clock: { x: sl_x, on: clk_on, wk: clk_wk },
    workouts_month: { x: wm_x, y: wm_y },
    workout_types: wt_list,
    workout_types_month: wt_month,
    weight: { x: wt_x, y: wt_y },
    vo2max: { x: vo_x, y: vo_y },
    blood_pressure: { x: bp_x, sys: bp_sys, dia: bp_dia },
    flights_month: { x: fl_x, y: fl_y },
    energy_month: { x: en_x, y: en_y },
  };
}

// Aggregate the month-keyed workout-type map into a flat, sorted list.
// monthMap: Map("YYYY-MM" -> Map(rawType -> {count,minutes})). When `year`
// is given, only months in that year are counted. Friendly names are merged
// (e.g. both strength-training identifiers fold into "Strength").
function aggWorkoutTypes(monthMap, year){
  const byName = new Map();
  for (const [mo, types] of monthMap){
    if (year && mo.slice(0,4) !== year) continue;
    for (const [raw, agg] of types){
      const name = workoutTypeName(raw);
      let cur = byName.get(name);
      if (!cur){ cur = { type: name, count: 0, minutes: 0 }; byName.set(name, cur); }
      cur.count += agg.count; cur.minutes += agg.minutes;
    }
  }
  return [...byName.values()]
    .map(o => ({ type: o.type, count: o.count, minutes: Math.round(o.minutes) }))
    .sort((a, b) => b.count - a.count || b.minutes - a.minutes);
}

// Map Apple's HKWorkoutActivityType* identifier to a short friendly name.
// Unknown/missing types fall back to a humanized version of the identifier.
function workoutTypeName(raw){
  if (!raw || raw === "Other") return "Other";
  const id = raw.replace(/^HKWorkoutActivityType/, "");
  const MAP = {
    Running: "Running", Walking: "Walking", Cycling: "Cycling",
    Swimming: "Swimming", Hiking: "Hiking", Yoga: "Yoga",
    FunctionalStrengthTraining: "Strength", TraditionalStrengthTraining: "Strength",
    HighIntensityIntervalTraining: "HIIT", Elliptical: "Elliptical",
    Rowing: "Rowing", CoreTraining: "Core", Pilates: "Pilates",
    Dance: "Dance", StairClimbing: "Stairs", Cooldown: "Cooldown",
    MixedCardio: "Cardio", CrossTraining: "Cross-training",
    Tennis: "Tennis", Basketball: "Basketball", Soccer: "Soccer",
    Badminton: "Badminton", TableTennis: "Table tennis",
    Golf: "Golf", Boxing: "Boxing", Climbing: "Climbing",
  };
  if (MAP[id]) return MAP[id];
  // humanize: "SomethingElse" -> "Something else"
  const spaced = id.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// Rough fitness-age estimate from VO2max: the age at which average VO2max
// matches this value. Sex-specific normative slope when known. Clamped and
// labelled as an estimate, not a medical value.
function _fitnessAge(vo2, sex){
  if (!(vo2 > 0)) return null;
  let base, rate;
  if (sex === "male"){ base = 48; rate = 0.40; }
  else if (sex === "female"){ base = 42; rate = 0.35; }
  else { base = 45; rate = 0.375; }
  let age = 20 + (base - vo2) / rate;
  return Math.max(18, Math.min(90, Math.round(age)));
}

// Circular standard deviation (minutes) of a list of clock minutes-of-day.
// Clock times wrap at midnight, so we average them as angles.
function _circStdevMin(arr){
  if (!arr || arr.length < 3) return null;
  let sc = 0, ss = 0;
  for (const mn of arr){ const a = mn/1440*2*Math.PI; sc += Math.cos(a); ss += Math.sin(a); }
  const n = arr.length;
  const R = Math.sqrt((sc/n)**2 + (ss/n)**2);
  if (R <= 1e-9) return 720;
  return Math.sqrt(-2*Math.log(R)) * 1440/(2*Math.PI);
}
// Sleep consistency: how regular bed/wake clock times are, mapped to 0–100.
// Lower variability in onset & wake times → higher score.
function _sleepConsistency(onArr, wkArr){
  const so = _circStdevMin(onArr), sw = _circStdevMin(wkArr);
  if (so == null || sw == null) return null;
  const avg = (so + sw) / 2;
  return Math.max(0, Math.min(100, Math.round(100 - avg/1.5)));
}

// ---- GPS route helpers (workout-routes/*.gpx inside export.zip) ----
const MAX_ROUTE_PTS = 300; // decimation target — invisible at map zoom, tiny in memory
const TRKPT_RE = /<trkpt\b[^>]*>/g;
const LAT_RE = /\blat="([-\d.]+)"/;
const LON_RE = /\blon="([-\d.]+)"/;

// Pull [lat, lon] pairs from GPX text (Apple writes lon before lat).
function extractRoutePoints(text){
  const pts = []; let m; TRKPT_RE.lastIndex = 0;
  while ((m = TRKPT_RE.exec(text)) !== null){
    const la = LAT_RE.exec(m[0]), lo = LON_RE.exec(m[0]);
    if (la && lo){
      const lat = +la[1], lon = +lo[1];
      if (!isNaN(lat) && !isNaN(lon)) pts.push([lat, lon]);
    }
  }
  return pts;
}
// Keep at most `max` points, always preserving the first and last.
function decimate(pts, max){
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  const out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
// "workout-routes/route_2022-10-13_11.49pm.gpx" -> "2022-10-13 11:49pm"
function routeLabel(fname){
  const base = fname.split("/").pop().replace(/\.gpx$/i, "");
  const m = base.match(/(\d{4}-\d{2}-\d{2})[_ ](\d{1,2}\.\d{2}\s*[ap]m)/i);
  return m ? (m[1] + " " + m[2].toLowerCase().replace(/\s+/g, "")) : base.replace(/^route[_ ]?/i, "");
}
// Sortable key (chronological) derived from the filename.
function routeSortKey(fname){
  const base = fname.split("/").pop();
  const m = base.match(/(\d{4}-\d{2}-\d{2})_(\d{1,2})\.(\d{2})\s*(am|pm)/i);
  if (m){
    let h = +m[2]; const ap = m[4].toLowerCase();
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return m[1] + " " + String(h).padStart(2, "0") + ":" + m[3];
  }
  return base;
}

// Node-only export hook. In the browser `module` is undefined, so this is
// skipped and every declaration above lives in the shared global lexical
// scope where the main inline script can reach it.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SUM_TYPES, RHR_TYPE, HRV_TYPE, SLEEP_TYPE, WEIGHT_TYPE, VO2_TYPE,
    BP_SYS_TYPE, BP_DIA_TYPE, TAG_RE, av, naiveMs, newAgg, pushList, scanMe,
    handleTag, finalize, _fitnessAge, _circStdevMin, _sleepConsistency,
    workoutTypeName, aggWorkoutTypes,
    MAX_ROUTE_PTS, extractRoutePoints, decimate, routeLabel, routeSortKey,
  };
}
