// Unit tests for the EchoHealth parsing core (web/parser.js).
// Run with:  node --test
// No dependencies — uses Node's built-in test runner + assert.

const test = require("node:test");
const assert = require("node:assert");
const P = require("../web/parser.js");

// Helper: feed an array of tag strings through handleTag, then finalize.
function run(tags, me) {
  const A = P.newAgg();
  if (me) P.scanMe(A, me);
  for (const tag of tags) P.handleTag(A, tag);
  return P.finalize(A);
}
const rec = (attrs) => `<Record ${attrs} />`;
const wo = (attrs) => `<Workout ${attrs} />`;

test("steps: daily sum + totals + active days", () => {
  const r = run([
    rec('type="HKQuantityTypeIdentifierStepCount" startDate="2024-01-01 08:00:00 +0000" value="1000"'),
    rec('type="HKQuantityTypeIdentifierStepCount" startDate="2024-01-01 18:00:00 +0000" value="500"'),
    rec('type="HKQuantityTypeIdentifierStepCount" startDate="2024-01-02 09:00:00 +0000" value="2000"'),
  ]);
  assert.deepStrictEqual(r.steps_daily.x, ["2024-01-01", "2024-01-02"]);
  assert.deepStrictEqual(r.steps_daily.y, [1500, 2000]);
  assert.strictEqual(r.meta.total_steps, 3500);
  assert.strictEqual(r.meta.active_days, 2);
  assert.strictEqual(r.meta.date_min, "2024-01-01");
  assert.strictEqual(r.meta.date_max, "2024-01-02");
});

test("distance: total + monthly rollup", () => {
  const r = run([
    rec('type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="2024-01-10 08:00:00 +0000" value="3.5"'),
    rec('type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="2024-02-10 08:00:00 +0000" value="2.5"'),
  ]);
  assert.strictEqual(r.meta.total_distance, 6);
  assert.deepStrictEqual(r.monthly_distance.x, ["2024-01", "2024-02"]);
  assert.deepStrictEqual(r.monthly_distance.y, [3.5, 2.5]);
});

test("resting HR: per-day average", () => {
  const r = run([
    rec('type="HKQuantityTypeIdentifierRestingHeartRate" startDate="2024-03-01 08:00:00 +0000" value="58"'),
    rec('type="HKQuantityTypeIdentifierRestingHeartRate" startDate="2024-03-01 20:00:00 +0000" value="62"'),
  ]);
  assert.deepStrictEqual(r.resting_hr.x, ["2024-03-01"]);
  assert.deepStrictEqual(r.resting_hr.y, [60]);
  assert.strictEqual(r.meta.avg_resting_hr, 60);
});

test("workouts: monthly count + total", () => {
  const r = run([
    wo('startDate="2024-01-05 08:00:00 +0000"'),
    wo('startDate="2024-01-20 08:00:00 +0000"'),
    wo('startDate="2024-02-02 08:00:00 +0000"'),
  ]);
  assert.strictEqual(r.meta.workouts, 3);
  assert.deepStrictEqual(r.workouts_month.x, ["2024-01", "2024-02"]);
  assert.deepStrictEqual(r.workouts_month.y, [2, 1]);
});

test("workout siblings are NOT counted as workouts", () => {
  // The TAG_RE [\s/>] guard must skip <WorkoutEvent>/<WorkoutStatistics>.
  const A = P.newAgg();
  let m; P.TAG_RE.lastIndex = 0;
  const xml = '<Workout startDate="2024-01-01 08:00:00 +0000"><WorkoutEvent type="x"/><WorkoutStatistics sum="5"/></Workout>';
  const tags = [];
  while ((m = P.TAG_RE.exec(xml)) !== null) tags.push(m[0]);
  for (const t of tags) P.handleTag(A, t);
  const r = P.finalize(A);
  assert.strictEqual(r.meta.workouts, 1, "only the <Workout> counts");
});

test("workout types: tally by activity type, sorted by count, with minutes", () => {
  const r = run([
    wo('workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2024-01-01 08:00:00 +0000" duration="30" durationUnit="min"'),
    wo('workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2024-01-03 08:00:00 +0000" duration="40" durationUnit="min"'),
    wo('workoutActivityType="HKWorkoutActivityTypeWalking" startDate="2024-01-02 08:00:00 +0000" duration="60" durationUnit="min"'),
  ]);
  assert.strictEqual(r.workout_types.length, 2);
  assert.deepStrictEqual(r.workout_types[0], { type: "Running", count: 2, minutes: 70 });
  assert.deepStrictEqual(r.workout_types[1], { type: "Walking", count: 1, minutes: 60 });
});

test("workout types: missing activity type → Other; duration from end-start when absent", () => {
  const r = run([
    wo('startDate="2024-01-01 08:00:00 +0000" endDate="2024-01-01 08:45:00 +0000"'),
  ]);
  assert.deepStrictEqual(r.workout_types, [{ type: "Other", count: 1, minutes: 45 }]);
});

test("workoutTypeName: maps known + humanizes unknown identifiers", () => {
  assert.strictEqual(P.workoutTypeName("HKWorkoutActivityTypeFunctionalStrengthTraining"), "Strength");
  assert.strictEqual(P.workoutTypeName("HKWorkoutActivityTypeHighIntensityIntervalTraining"), "HIIT");
  assert.strictEqual(P.workoutTypeName("HKWorkoutActivityTypeKickboxing"), "Kickboxing");
  assert.strictEqual(P.workoutTypeName(""), "Other");
});

test("workout types are period-scoped via workout_types_month", () => {
  const r = run([
    wo('workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2023-05-01 08:00:00 +0000" duration="30" durationUnit="min"'),
    wo('workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2024-05-01 08:00:00 +0000" duration="30" durationUnit="min"'),
    wo('workoutActivityType="HKWorkoutActivityTypeCycling" startDate="2024-06-01 08:00:00 +0000" duration="45" durationUnit="min"'),
  ]);
  // all-time: 2 running + 1 cycling
  assert.deepStrictEqual(r.workout_types.map(x => x.type), ["Running", "Cycling"]);
  assert.strictEqual(r.workout_types[0].count, 2);
  // rebuild the month->type map and scope to 2024 only
  const monthMap = new Map(r.workout_types_month.map(mt =>
    [mt.month, new Map(mt.types.map(ti => [ti.type, { count: ti.count, minutes: ti.minutes }]))]));
  const y2024 = P.aggWorkoutTypes(monthMap, "2024");
  assert.deepStrictEqual(y2024, [
    { type: "Cycling", count: 1, minutes: 45 },
    { type: "Running", count: 1, minutes: 30 },
  ]);
});

test("sleep stages: split + per-night total + consistency present", () => {
  const tags = [];
  // 3 consistent nights, each Core+Deep+REM, bed ~23:00 wake ~07:00
  const nights = [
    ["2024-01-01 23:00:00 +0000", "2024-01-02"],
    ["2024-01-02 23:10:00 +0000", "2024-01-03"],
    ["2024-01-03 22:50:00 +0000", "2024-01-04"],
  ];
  for (const [start, d] of nights) {
    tags.push(rec(`type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="${start}" endDate="${d} 02:00:00 +0000"`));
    tags.push(rec(`type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="${d} 02:00:00 +0000" endDate="${d} 03:30:00 +0000"`));
    tags.push(rec(`type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepREM" startDate="${d} 03:30:00 +0000" endDate="${d} 07:00:00 +0000"`));
  }
  const r = run(tags);
  assert.strictEqual(r.sleep.x.length, 3);
  assert.ok(r.sleep_stages.x.length === 3, "stage data present");
  assert.ok(r.sleep_stages.deep.every(v => v > 0), "deep hours recorded");
  assert.ok(r.meta.sleep_consistency >= 90, "consistent schedule scores high");
});

test("sleep: implausible durations (>=24h or <=0) are ignored", () => {
  const r = run([
    rec('type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2024-01-01 23:00:00 +0000" endDate="2024-01-03 23:00:00 +0000"'),
  ]);
  assert.strictEqual(r.sleep.x.length, 0, "48h sleep block rejected");
});

test("blood pressure: only days with BOTH readings", () => {
  const r = run([
    rec('type="HKQuantityTypeIdentifierBloodPressureSystolic" startDate="2024-01-01 08:00:00 +0000" value="120"'),
    rec('type="HKQuantityTypeIdentifierBloodPressureDiastolic" startDate="2024-01-01 08:00:00 +0000" value="80"'),
    rec('type="HKQuantityTypeIdentifierBloodPressureSystolic" startDate="2024-01-02 08:00:00 +0000" value="130"'),
    // no diastolic on the 2nd → that day dropped
  ]);
  assert.deepStrictEqual(r.blood_pressure.x, ["2024-01-01"]);
  assert.deepStrictEqual(r.blood_pressure.sys, [120]);
  assert.deepStrictEqual(r.blood_pressure.dia, [80]);
});

test("weight: unit captured from first reading", () => {
  const r = run([
    rec('type="HKQuantityTypeIdentifierBodyMass" unit="lb" startDate="2024-01-01 08:00:00 +0000" value="180"'),
  ]);
  assert.strictEqual(r.meta.weight_unit, "lb");
  assert.deepStrictEqual(r.weight.y, [180]);
});

test("flights + active energy: monthly sums", () => {
  const r = run([
    rec('type="HKQuantityTypeIdentifierFlightsClimbed" startDate="2024-01-01 08:00:00 +0000" value="5"'),
    rec('type="HKQuantityTypeIdentifierFlightsClimbed" startDate="2024-01-02 08:00:00 +0000" value="7"'),
    rec('type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2024-01-01 08:00:00 +0000" value="300"'),
    rec('type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2024-01-01 12:00:00 +0000" value="250"'),
  ]);
  assert.deepStrictEqual(r.flights_month.y, [12]);
  assert.deepStrictEqual(r.energy_month.y, [550]);
});

test("VO2 max + fitness age from <Me> sex", () => {
  const me = '<Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>';
  const r = run([
    rec('type="HKQuantityTypeIdentifierVO2Max" startDate="2024-03-01 08:00:00 +0000" value="44"'),
  ], me);
  assert.strictEqual(r.meta.sex, "male");
  assert.strictEqual(r.meta.latest_vo2, 44);
  assert.strictEqual(r.meta.fitness_age, 30); // (48-44)/0.40 + 20 = 30
});

test("missing metrics → empty series, null meta (no crash)", () => {
  const r = run([]);
  assert.deepStrictEqual(r.steps_daily.x, []);
  assert.strictEqual(r.meta.avg_resting_hr, null);
  assert.strictEqual(r.meta.fitness_age, null);
  assert.strictEqual(r.meta.sleep_consistency, null);
  assert.strictEqual(r.meta.records, 0);
});

test("30-day rolling step average", () => {
  const tags = [];
  for (let d = 1; d <= 40; d++) {
    const day = String(d).padStart(2, "0");
    tags.push(rec(`type="HKQuantityTypeIdentifierStepCount" startDate="2024-01-${day} 08:00:00 +0000" value="100"`));
  }
  const r = run(tags);
  // every day is 100 → rolling avg is 100 throughout
  assert.ok(r.steps_daily.roll.every(v => v === 100));
  assert.strictEqual(r.steps_daily.roll.length, 40);
});

// --- route helpers ---
test("extractRoutePoints + decimate", () => {
  const gpx = `<trkpt lat="1.30" lon="103.80"></trkpt><trkpt lat="1.31" lon="103.81"></trkpt><trkpt lat="1.32" lon="103.82"></trkpt>`;
  const pts = P.extractRoutePoints(gpx);
  assert.deepStrictEqual(pts, [[1.30, 103.80], [1.31, 103.81], [1.32, 103.82]]);
  const dec = P.decimate(pts, 2);
  assert.ok(dec.length <= 3 && dec[0] === pts[0] && dec[dec.length - 1] === pts[2]);
});

test("routeLabel + routeSortKey from filename", () => {
  assert.strictEqual(P.routeLabel("workout-routes/route_2022-10-13_11.49pm.gpx"), "2022-10-13 11.49pm");
  assert.strictEqual(P.routeSortKey("route_2022-10-13_11.49pm.gpx"), "2022-10-13 23:49");
  assert.strictEqual(P.routeSortKey("route_2022-10-13_12.05am.gpx"), "2022-10-13 00:05");
});

test("naiveMs ignores timezone, computes duration", () => {
  const ms1 = P.naiveMs("2024-01-01 23:00:00 +0000");
  const ms2 = P.naiveMs("2024-01-02 01:00:00 +0800");
  assert.strictEqual((ms2 - ms1) / 3600000, 2); // 2 hours regardless of TZ text
});
