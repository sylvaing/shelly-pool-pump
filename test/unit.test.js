// Unit tests of the pure functions (no Shelly API involved).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, at, S } = require("./helpers");

const sim = boot();
// Values from the script realm are re-created here so deepEqual compares plain data.
const call = (expr) => {
  const v = S(sim, expr);
  return v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || "") + " expected " + b + " ± " + eps + ", got " + a);

test("durationHours follows the original table, capped at 23 h", () => {
  const cases = [
    [null, 1, 4],
    [2, 1, 0.5],
    [7, 1, 1],
    [11, 1, 3],
    [14, 1, 5],
    [20, 1, 7],
    [24.5, 1, 24.5 * 4 / 3 - 24],
    [28, 1, 16],
    [29.9, 1, 23], // 23.6 h in the old script: now capped
    [31, 1, 23],
    [26, 1.6, 26 * 4 / 3 * 1.6 - 24 * 1.6],
    [29, 1.6, 23], // 32 h before the cap
    [20, 0.6, 4.2],
  ];
  for (const [t, coeff, want] of cases) near(call(`durationHours(${t}, ${coeff})`), want, 1e-9, `t=${t} coeff=${coeff}`);
});

test("referenceTemp ignores missing values", () => {
  assert.equal(call("referenceTemp(null, null)"), null);
  assert.equal(call("referenceTemp(20, null)"), 20);
  assert.equal(call("referenceTemp(null, 18)"), 18);
  assert.equal(call("referenceTemp(20, 22)"), 22);
});

test("solar noon matches Home Assistant within 2 minutes (13:42.5 on 2026-10-03)", () => {
  const noon = call(`solarNoonMinutes(${at(0, 12)}, 7200, 1.2299)`);
  near(noon, 13 * 60 + 42.5, 2, "noon");
  // Solstices: Toulouse solar noon is ~12:53 CET on 21 Dec and ~13:57 CEST on 21 June.
  near(call("solarNoonMinutes(1797850800, 3600, 1.2299)"), 12 * 60 + 53, 3, "December");
  near(call("solarNoonMinutes(1813572000, 7200, 1.2299)"), 13 * 60 + 57, 3, "June");
});

test("autoWindow: inside, before, after and across midnight", () => {
  const lon = 1.2299;
  let w = call(`autoWindow(${at(0, 12)}, 7200, ${lon}, 8)`);
  assert.equal(w.on, true);
  near(w.stopTs - w.startTs, 8 * 3600, 0);
  near((w.startTs + w.stopTs) / 2, at(0, 13, 44), 120, "centred on noon");
  w = call(`autoWindow(${at(0, 7)}, 7200, ${lon}, 8)`);
  assert.equal(w.on, false);
  near(w.startTs, at(0, 9, 44), 120, "next start today");
  w = call(`autoWindow(${at(0, 20)}, 7200, ${lon}, 8)`);
  assert.equal(w.on, false);
  near(w.startTs, at(1, 9, 44), 120, "next start tomorrow");
  // 22 h: window 02:44 -> 00:44 the next day
  assert.equal(call(`autoWindow(${at(1, 0, 20)}, 7200, ${lon}, 22)`).on, true, "00:20 still running");
  assert.equal(call(`autoWindow(${at(1, 1, 30)}, 7200, ${lon}, 22)`).on, false, "01:30 stopped");
  assert.equal(call(`autoWindow(${at(1, 3)}, 7200, ${lon}, 22)`).on, true, "03:00 running");
});

test("bootWindowOn runs right after boot, then every 24 h", () => {
  assert.equal(call("bootWindowOn(0, 4)"), true);
  assert.equal(call("bootWindowOn(4 * 3600 - 60, 4)"), true);
  assert.equal(call("bootWindowOn(4 * 3600, 4)"), false);
  assert.equal(call("bootWindowOn(86400 + 60, 4)"), true);
});

test("cleanNumber parses, clamps and snaps; rejects garbage", () => {
  const lim = "[0.6, 1.6, 0.1]";
  assert.equal(call(`cleanNumber("1.23", ${lim})`), 1.2);
  assert.equal(call(`cleanNumber(1.26, ${lim})`), 1.3);
  assert.equal(call(`cleanNumber("9", ${lim})`), 1.6);
  assert.equal(call(`cleanNumber("-4", ${lim})`), 0.6);
  for (const bad of ['"abc"', '""', '"  "', '"1.2abc"', "null", "undefined", "NaN", "Infinity", "{}", "true"]) {
    assert.equal(call(`cleanNumber(${bad}, ${lim})`), null, bad);
  }
  assert.equal(call('cleanNumber("-2.6", [-10, 0, 1])'), -3);
});

test("validateCfg falls back per field and keeps the freeze hysteresis", () => {
  let r = call("validateCfg(undefined)");
  assert.equal(r.bad, false);
  assert.deepEqual(r.cfg, { v: 1, mode: "Auto", coeff: 1, hg_air_on: 0.5, hg_air_off: 1, hg_pipe: 2, hg_cycle: 15, hg_air_continu: -5 });
  r = call('validateCfg("garbage{")');
  assert.equal(r.bad, true);
  assert.equal(r.cfg.mode, "Auto");
  r = call('validateCfg({ mode: "Turbo", coeff: "x", hg_pipe: 3, hg_air_on: 2, hg_air_off: 1 })');
  assert.equal(r.bad, true);
  assert.equal(r.cfg.mode, "Auto");
  assert.equal(r.cfg.coeff, 1);
  assert.equal(r.cfg.hg_pipe, 3);
  assert.equal(r.cfg.hg_air_off, 2.5, "exit raised above entry");
  r = call('validateCfg(JSON.stringify({ mode: "Force off", coeff: 1.2 }))');
  assert.equal(r.bad, false);
  assert.equal(r.cfg.mode, "Force off");
});

test("validateState migrates the legacy max and rejects corrupt fields", () => {
  let r = call("validateState(undefined, 24.5)");
  assert.equal(r.st.tmax_yesterday, 24.5);
  assert.equal(r.st.tmax_today, null);
  r = call('validateState(undefined, "23")');
  assert.equal(r.st.tmax_yesterday, 23);
  r = call('validateState({ day: "x", tmax_today: 999, tmax_yesterday: 21.5, last_time: "y", off: 99999 }, 30)');
  assert.deepEqual(r.st, { v: 1, day: null, tmax_today: null, tmax_yesterday: 21.5, last_time: null, last_up: 0, off: null });
  r = call("validateState(42, null)");
  assert.equal(r.bad, true);
});

test("estimateBase does not count the uptime twice after a script-only restart", () => {
  const st = "{ last_time: 1791000000, last_up: 5000 }";
  assert.equal(call(`estimateBase(${st}, 20)`), 1791000000, "device rebooted: uptime restarted");
  assert.equal(call(`estimateBase(${st}, 7000)`), 1791000000 - 5000, "same boot: saved time already includes the uptime");
  assert.equal(call("estimateBase({ last_time: null, last_up: 0 }, 10)"), null);
});

test("parseHttpDate accepts RFC 1123 dates only", () => {
  assert.equal(call('parseHttpDate("Sat, 03 Oct 2026 09:08:43 GMT")'), 1791018523);
  for (const bad of ['"garbage"', '"Thu, 01 Jan 1970 00:00:00 GMT"', "undefined", "null", '"Sat, 03 Oct 2026"']) {
    assert.equal(call(`parseHttpDate(${bad})`), null, bad);
  }
});

test("baseDecision and manualExpired", () => {
  assert.equal(call('baseDecision("Auto", true, null)'), true);
  assert.equal(call('baseDecision("Force off", true, null)'), false);
  assert.equal(call('baseDecision("Force on", false, null)'), true);
  assert.equal(call('baseDecision("Force off", false, { on: true })'), true);
  assert.equal(call('manualExpired({ mode: "Auto", base: true }, "Auto", true)'), false);
  assert.equal(call('manualExpired({ mode: "Auto", base: true }, "Auto", false)'), true);
  assert.equal(call('manualExpired({ mode: "Force off", base: true }, "Force off", false)'), false);
  assert.equal(call('manualExpired({ mode: "Force off", base: true }, "Auto", true)'), true);
});

const CFG = "{ hg_air_on: 0.5, hg_air_off: 1, hg_pipe: 2, hg_cycle: 15, hg_air_continu: -5 }";
function freeze(input, f) {
  return call(`(function () { let f = ${JSON.stringify(f)}; let d = freezeStep(${CFG}, ${JSON.stringify(input)}, f); return { d: d, f: f }; })()`);
}
const F0 = { active: false, continuous: false, cycleEnd: 0, anchor: 0, reason: "" };
const base = { air: 5, water: 8, lastAir: 5, relay: false, onFor: 0, offFor: 3600, up: 10000 };
const w = (o) => Object.assign({}, base, o);

test("freezeStep: hysteresis on the room air", () => {
  assert.equal(freeze(w({ air: 0.6 }), F0).f.active, false);
  let r = freeze(w({ air: 0.4 }), F0);
  assert.equal(r.f.active, true);
  assert.equal(freeze(w({ air: 0.8 }), r.f).f.active, true, "stays active between thresholds");
  assert.equal(freeze(w({ air: 1.1 }), r.f).f.active, false);
});

test("freezeStep: pipe-triggered cycle, extension, continuous", () => {
  const act = Object.assign({}, F0, { active: true });
  let r = freeze(w({ air: -1, water: 2.5 }), act);
  assert.equal(r.d, false, "pipe still warm: standby");
  r = freeze(w({ air: -1, water: 2, offFor: 200 }), act);
  assert.equal(r.d, false, "off for less than 5 min: wait");
  r = freeze(w({ air: -1, water: 2 }), act);
  assert.equal(r.d, true);
  assert.equal(r.f.cycleEnd, 10000 + 900);
  let r2 = freeze(w({ air: -1, water: 8, relay: true, onFor: 600, up: 10600 }), r.f);
  assert.equal(r2.d, true, "inside the cycle");
  r2 = freeze(w({ air: -1, water: 8, relay: true, onFor: 960, up: 10960 }), r.f);
  assert.equal(r2.d, false, "pool water warm: cycle ends");
  r2 = freeze(w({ air: -1, water: 2.3, relay: true, onFor: 960, up: 10960 }), r.f);
  assert.equal(r2.d, true, "pool water cold: extended");
  const c = freeze(w({ air: -5.5, water: 9 }), act);
  assert.equal(c.d, true, "continuous below -5");
  assert.equal(freeze(w({ air: -4.8, water: 9, relay: true, onFor: 3600 }), c.f).d, true, "still continuous at -4.8 (hysteresis)");
  assert.equal(freeze(w({ air: -4.4, water: 9, relay: true, onFor: 3600 }), c.f).d, false, "continuous ends above -4.5");
});

test("freezeStep: probe failures", () => {
  const act = Object.assign({}, F0, { active: true, anchor: 10000 });
  // water probe down: 15 min per hour, 30 min per hour below -3
  assert.equal(freeze(w({ air: -1, water: null, up: 10000 + 10 * 60 }), act).d, true);
  assert.equal(freeze(w({ air: -1, water: null, up: 10000 + 20 * 60 }), act).d, false);
  assert.equal(freeze(w({ air: -4, water: null, up: 10000 + 20 * 60 }), act).d, true);
  assert.equal(freeze(w({ air: -4, water: null, up: 10000 + 40 * 60 }), act).d, false);
  // air probe down: the still pipe water decides, after 30 min off
  assert.equal(freeze(w({ air: null, water: 1.5, offFor: 1200 }), F0).f.active, false);
  let r = freeze(w({ air: null, water: 1.5, offFor: 1900 }), F0);
  assert.equal(r.f.active, true);
  assert.equal(r.d, true);
  // both down: blind 15 min per hour if the last known air was cold
  assert.equal(freeze(w({ air: null, water: null, lastAir: 2, up: 10000 }), F0).d, true);
  assert.equal(freeze(w({ air: null, water: null, lastAir: 5 }), F0).f.active, false);
  assert.equal(freeze(w({ air: null, water: null, lastAir: null }), F0).f.active, false);
});

test("validateSite: defaults, overrides, rejects invalid and unknown fields", () => {
  let r = call("validateSite(undefined)");
  assert.equal(r.bad, false);
  assert.deepEqual(r.site, {
    switch_id: 0, air_id: 100, water_id: 101, name: "pool_pump", longitude: null,
    time_urls: [], mqtt: true, ha_discovery: true, ha_prefix: "homeassistant",
  });
  r = call('validateSite({ water_id: 103, longitude: -4.5, time_urls: ["http://10.0.0.1/"], mqtt: false })');
  assert.equal(r.bad, false);
  assert.equal(r.site.water_id, 103);
  assert.equal(r.site.longitude, -4.5);
  assert.deepEqual(r.site.time_urls, ["http://10.0.0.1/"]);
  assert.equal(r.site.mqtt, false);
  for (const bad of [
    "{ switch_id: 9 }", "{ air_id: 100.5 }", '{ name: "Pool" }', '{ name: "" }', "{ longitude: 200 }",
    '{ time_urls: "http://x" }', '{ time_urls: ["ftp://x"] }', '{ time_urls: ["http://a", "http://b", "http://c", "http://d"] }',
    '{ mqtt: "yes" }', '{ ha_prefix: "Home Assistant" }', "{ foo: 1 }", '"garbage{"',
  ]) {
    const v = call(`validateSite(${bad})`);
    assert.equal(v.bad, true, bad);
    assert.equal(v.site.switch_id, 0, bad);
  }
  assert.equal(call('validateSite({ ha_prefix: "ha/test-1" })').site.ha_prefix, "ha/test-1");
});
