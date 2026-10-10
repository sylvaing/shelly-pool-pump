// Scenario tests (spec § 11) on the simulated Shelly.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DEV, TIME_URLS, at, hm, boot, reboot, run, runUntil, S, send, transitions, onSeconds, noUnexpectedErrors } = require("./helpers");

const dayIndex = (d) => Math.floor((at(d, 0) + 7200) / 86400);
const state = (o) =>
  Object.assign({ v: 1, day: dayIndex(0), tmax_today: null, tmax_yesterday: null, last_time: null, last_up: 0, off: 7200 }, o);
const cfg = (o) => Object.assign({ v: 1, mode: "Auto", coeff: 1, hg_air_on: 0.5, hg_air_off: 1, hg_pipe: 2, hg_cycle: 15, hg_air_continu: -5 }, o);
const plain = (v) => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
const st = (sim, expr) => plain(S(sim, expr));

// Seconds since the relay last changed (large when it never changed in this simulation).
function relayFor(sim) {
  const h = sim.relayHistory;
  return h.length ? sim.trueUnix() - h[h.length - 1].unix : 1e6;
}

function assertTime(actualUnix, expectedUnix, toleranceMin, what) {
  assert.ok(
    actualUnix !== undefined && Math.abs(actualUnix - expectedUnix) <= toleranceMin * 60,
    what + ": expected " + hm(expectedUnix) + " ± " + toleranceMin + " min, got " + (actualUnix === undefined ? "nothing" : hm(actualUnix))
  );
}

function firstChange(sim, on, from, to) {
  const h = sim.relayHistory.find((x) => x.on === on && x.unix >= from && (to === undefined || x.unix <= to));
  return h ? h.unix : undefined;
}

function assertAlive(sim) {
  assert.equal(sim.dead, null, sim.dead ? sim.dead.stack : "");
}

// Summer: water probe reads the hot pipe (30 °C) for 4 min after a start, then the pool.
function summerWorld(poolTemp) {
  return (sim) => {
    sim.temps[100] = 24;
    sim.temps[101] = sim.relay && relayFor(sim) >= 240 ? poolTemp(sim.trueUnix()) : 30;
  };
}

// Winter: the still water in the pipe drifts to the room air; running brings pool water.
function winterWorld(airAt, poolTemp, opts) {
  opts = opts || {};
  let pipe = poolTemp;
  return (sim) => {
    const air = airAt(sim.trueUnix());
    if (sim.relay) pipe += (poolTemp - pipe) * Math.min(1, 10 / 30);
    else pipe += (air - pipe) * (10 / (45 * 60));
    sim.minPipe = Math.min(sim.minPipe === undefined ? 99 : sim.minPipe, pipe);
    if (!opts.noAir) sim.temps[100] = Math.round(air * 10) / 10;
    else delete sim.temps[100];
    if (!opts.noWater) sim.temps[101] = Math.round(pipe * 10) / 10;
    else delete sim.temps[101];
  };
}

function lerp(points) {
  return (t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i][0]) {
        const [t0, v0] = points[i - 1];
        const [t1, v1] = points[i];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    }
    return points[points.length - 1][1];
  };
}

// --------------------------------------------------------------------------
test("1-3. summer day: window on the solar noon, longer when the water warms, max read after 5 min", () => {
  const sim = boot({
    clockAt0: at(0, 6),
    kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 22, last_time: at(0, 5, 59) }) },
  });
  const pool = lerp([[at(0, 12), 22], [at(0, 16), 26]]);
  runUntil(sim, at(0, 23), summerWorld(pool));
  // 22 °C -> 7.5 h around 13:44 = start 09:59; 26 °C -> 10.67 h = stop 19:04.
  assertTime(firstChange(sim, true, at(0, 6)), at(0, 9, 59), 3, "start");
  assertTime(firstChange(sim, false, at(0, 10)), at(0, 19, 4), 3, "stop");
  assert.equal(st(sim, "S.st.tmax_today"), 26, "max of the day, never the 30 °C pipe water");
  const s = sim.lastState();
  assert.equal(s.temp_max, 26);
  assert.ok(Math.abs(s.duration - 10.67) < 0.01, "duration " + s.duration);
  assert.equal(s.diag, "ok");
  assert.deepEqual(noUnexpectedErrors(sim), []);
  assertAlive(sim);

  // 2. day change: yesterday takes today's max, the duration does not move at midnight.
  const before = sim.lastState().duration;
  runUntil(sim, at(1, 0, 30), summerWorld(pool));
  assert.equal(st(sim, "S.st.tmax_yesterday"), 26);
  assert.equal(st(sim, "S.st.tmax_today"), null);
  assert.equal(st(sim, "S.st.day"), dayIndex(1));
  assert.equal(sim.kvs.pool_state.day, dayIndex(1), "new day saved");
  assert.equal(sim.lastState().duration, before);
});

test("4. 22 h filtration ending after midnight, and the 23 h cap", () => {
  const sim = boot({
    clockAt0: at(0, 12),
    relay: true,
    kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 29.5, last_time: at(0, 11, 59) }) },
  });
  runUntil(sim, at(1, 4), summerWorld(() => 29.5));
  // 4 * 29.5 - 96 = 22 h: 02:44 -> 00:44
  assertTime(firstChange(sim, false, at(0, 12)), at(1, 0, 44), 3, "stop after midnight");
  assertTime(firstChange(sim, true, at(1, 0, 45)), at(1, 2, 44), 3, "next start");
  assert.equal(sim.lastState().duration, 22);
  send(sim, "coeff", "1.6");
  sim.advance(20);
  assert.equal(sim.lastState().duration, 23, "capped at 23 h");
  assertAlive(sim);
});

test("5. reboot with network: settings and max restored, no relay bounce", () => {
  let sim = boot({ clockAt0: at(0, 10), relay: true, kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 24.5, last_time: at(0, 9) }) } });
  run(sim, 60, summerWorld(() => 25));
  send(sim, "coeff", "1.2");
  runUntil(sim, at(0, 14), summerWorld(() => 25));
  assert.equal(sim.relay, true);
  sim = reboot(sim, 60);
  run(sim, 60, summerWorld(() => 25));
  assert.equal(st(sim, "S.cfg.coeff"), 1.2);
  assert.equal(st(sim, "S.st.tmax_today"), 25);
  assert.equal(st(sim, "S.clock.src"), "ntp");
  assert.equal(sim.relayHistory.length, 0, "relay untouched: " + transitions(sim));
  assert.equal(sim.lastState().diag, "ok");
  assertAlive(sim);
});

test("6a. power cut, no network: estimated clock, then real clock turns the pump off", () => {
  let sim = boot({ clockAt0: at(0, 10), relay: true, kvs: { pool_site: { time_urls: TIME_URLS }, pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 24.5, last_time: at(0, 9) }) } });
  runUntil(sim, at(0, 14, 5), summerWorld(() => 24.5));
  // Out for 5 h: back at 19:05, after the 18:04 stop, but the estimate says ~14:05.
  sim = reboot(sim, 5 * 3600, { ntp: false, http: () => null });
  run(sim, 600, summerWorld(() => 24.5));
  assert.equal(st(sim, "S.clock.src"), "estimated");
  assert.equal(sim.lastState().diag, "heure_estimee");
  assert.equal(sim.relay, true, "estimate still inside the window");
  assert.ok(sim.rpcLog.some((r) => r.method === "HTTP.Request"), "HTTP clock tried");
  assert.ok(!sim.rpcLog.some((r) => r.method === "Sys.SetTime"));
  sim.ntp = true;
  sim.advance(20);
  assert.equal(st(sim, "S.clock.src"), "ntp");
  assert.equal(sim.relay, false, "real clock: after the window");
  assert.deepEqual(noUnexpectedErrors(sim), []);
});

test("6b. power cut at night, no network: estimate keeps it off, real clock turns it on", () => {
  let sim = boot({ clockAt0: at(0, 10), relay: true, kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 24.5, last_time: at(0, 9) }) } });
  runUntil(sim, at(1, 5), summerWorld(() => 24.5));
  assert.equal(sim.relay, false);
  sim = reboot(sim, 5 * 3600, { ntp: false, http: () => null }); // back at 10:00
  run(sim, 600, summerWorld(() => 24.5));
  assert.equal(st(sim, "S.clock.src"), "estimated");
  assert.equal(sim.relay, false, "estimate ~05:00: off");
  sim.ntp = true;
  sim.advance(20);
  assert.equal(sim.relay, true, "real clock 10:10: on");
});

test("7. first boot without any data or clock: runs at once, then every 24 h", () => {
  const sim = boot({ clockAt0: at(0, 22), ntp: false, http: () => null, temps: { 100: 15, 101: 20 } });
  run(sim, 120);
  assert.equal(sim.relay, true, "on right after boot");
  assert.equal(sim.lastState().diag, "attente_heure");
  assert.equal(sim.lastState().start_ts, null);
  run(sim, 26 * 3600);
  // 20 °C water -> 7 h, from ~20 s after boot
  assertTime(firstChange(sim, false, at(0, 22)), at(0, 22) + 7 * 3600, 2, "stop after 7 h");
  assertTime(firstChange(sim, true, at(0, 23)), at(0, 22) + 24 * 3600, 2, "again 24 h after boot");
  assertAlive(sim);
});

test("8. NTP down: clock from the HTTP Date header (box, then Home Assistant)", () => {
  let sim = boot({ clockAt0: at(0, 10), ntp: false, kvs: { pool_site: { time_urls: TIME_URLS }, pool_cfg: cfg(), pool_state: state({ last_time: at(0, 9) }) } });
  run(sim, 200);
  const get = sim.rpcLog.find((r) => r.method === "HTTP.Request");
  assert.equal(get.params.url, "http://192.168.1.1/x404");
  assert.equal(get.params.method, "HEAD", "headers only: no page body in memory");
  const set = sim.rpcLog.find((r) => r.method === "Sys.SetTime");
  assert.ok(set && Math.abs(set.params.unixtime - sim.trueUnix()) < 120, "clock set to the real time");
  assert.equal(st(sim, "S.clock.src"), "http");

  // Box down: the second URL is used 5 min later.
  sim = boot({
    clockAt0: at(0, 10),
    ntp: false,
    http: (url) => (url.indexOf("192.168.1.1/") >= 0 ? null : { code: 401, headers: { Date: new Date(sim.trueUnix() * 1000).toUTCString() } }),
    kvs: { pool_site: { time_urls: TIME_URLS }, pool_cfg: cfg(), pool_state: state({ last_time: at(0, 9) }) },
  });
  run(sim, 500);
  assert.deepEqual(sim.rpcLog.filter((r) => r.method === "HTTP.Request").map((r) => r.params.url), ["http://192.168.1.1/x404", "http://192.168.1.105:8123/api/"]);
  assert.equal(st(sim, "S.clock.src"), "http");

  // Garbage header: refused, reported.
  sim = boot({ clockAt0: at(0, 10), ntp: false, http: () => ({ code: 200, headers: { Date: "yesterday" } }), kvs: { pool_site: { time_urls: TIME_URLS } } });
  run(sim, 200);
  assert.ok(!sim.rpcLog.some((r) => r.method === "Sys.SetTime"));
  assert.ok(sim.errors().some((l) => l.msg.indexOf("invalid Date header") >= 0));
  assertAlive(sim);
});

test("9. cold night: freeze cycles get closer as it gets colder, continuous below -5 °C", () => {
  const sim = boot({ clockAt0: at(0, 17), kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 8, last_time: at(0, 16) }) } });
  const air = lerp([[at(0, 18), 5], [at(0, 23), -2], [at(1, 3), -6], [at(1, 9), 3]]);
  const world = winterWorld(air, 7);
  runUntil(sim, at(1, 12), world);
  const starts = sim.relayHistory.filter((h) => h.on).map((h) => h.unix);
  const night = starts.filter((t) => t >= at(0, 18) && t < at(1, 9));
  assert.ok(night.length >= 5, "several freeze cycles: " + transitions(sim, at(0, 18)).join(", "));
  // The room air crosses 0.5 °C at ~21:13: nothing may start before.
  assert.equal(firstChange(sim, true, at(0, 18), at(0, 21, 10)), undefined, "nothing while the room is above 0.5 °C");
  // Continuous while the room is under -5 °C (about 02:00 -> 03:40).
  assert.equal(onSeconds(sim, at(1, 2, 15), at(1, 3, 30), true), 75 * 60, "continuous at -5..-6 °C");
  const early = night.filter((t) => t < at(1, 0, 30));
  const later = night.filter((t) => t >= at(1, 0, 30) && t < at(1, 2));
  const gap = (xs) => (xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : Infinity);
  assert.ok(gap(later) < gap(early), "cycles closer when colder: " + gap(early) / 60 + " vs " + gap(later) / 60 + " min");
  assert.ok(sim.minPipe > 1, "pipe water never close to freezing: min " + sim.minPipe.toFixed(2));
  const onNight = onSeconds(sim, at(0, 18), at(1, 9), false);
  assert.ok(onNight < 6 * 3600, "about " + (onNight / 3600).toFixed(1) + " h of pumping over a 15 h night");
  assert.equal(st(sim, "S.freeze.active"), false, "freeze mode left once the room is above 1 °C");
  sim.reportNight = (onNight / 3600).toFixed(1) + " h ON over 18:00-09:00, " + night.length + " starts, min pipe " + sim.minPipe.toFixed(1) + " °C";
  console.log("    night summary: " + sim.reportNight);
  assertAlive(sim);
});

test("9b. cold night with a nearly frozen pool: cycles are extended", () => {
  const sim = boot({ clockAt0: at(0, 20), kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 3, last_time: at(0, 19) }) } });
  const world = winterWorld(() => -2, 2.3);
  runUntil(sim, at(1, 2), world);
  assert.equal(st(sim, "S.freeze.reason"), "extended");
  assert.equal(sim.relay, true);
  assert.ok(onSeconds(sim, at(0, 22), at(1, 2), sim.relay) > 3.5 * 3600, "runs nearly all the time");
});

test("10. freeze beats Force off and a manual stop", () => {
  const sim = boot({ clockAt0: at(0, 20), kvs: { pool_cfg: cfg({ mode: "Force off" }), pool_state: state({ last_time: at(0, 19) }) } });
  const world = winterWorld(() => -2, 7);
  runUntil(sim, at(1, 2), world);
  assert.ok(sim.relayHistory.some((h) => h.on), "freeze cycles despite Force off");
  // Wait for a cycle, stop it by hand: the script restarts the pump.
  for (let i = 0; i < 360 && !sim.relay; i++) run(sim, 10, world);
  assert.equal(sim.relay, true);
  sim.setRelay(false, "button");
  run(sim, 20, world);
  assert.equal(sim.relay, true, "manual stop overridden by freeze");
  assertAlive(sim);
});

test("11. probe failures", () => {
  // a. water probe down: 15 min per hour at -1 °C, 30 min per hour at -4 °C
  let sim = boot({ clockAt0: at(0, 20), kvs: { pool_cfg: cfg({ mode: "Force off" }), pool_state: state({ last_time: at(0, 19) }) } });
  run(sim, 3 * 3600, winterWorld(() => -1, 7, { noWater: true }));
  let on = onSeconds(sim, at(0, 20, 30), at(0, 22, 30), false);
  assert.ok(Math.abs(on - 30 * 60) <= 120, "15 min/h: " + on / 60 + " min over 2 h");
  assert.equal(plain(JSON.parse(sim.mqtt.retained[DEV + "/pool/diag"])).water_probe, "hs");
  assert.equal(sim.lastState().temp_current, null);
  run(sim, 3 * 3600, winterWorld(() => -4, 7, { noWater: true }));
  on = onSeconds(sim, at(0, 23, 30), at(1, 1, 30), false);
  assert.ok(Math.abs(on - 60 * 60) <= 120, "30 min/h: " + on / 60 + " min over 2 h");

  // b. air probe down: the still pipe water triggers the cycles
  sim = boot({ clockAt0: at(0, 20), kvs: { pool_cfg: cfg({ mode: "Force off" }), pool_state: state({ last_time: at(0, 19) }) } });
  run(sim, 4 * 3600, winterWorld(() => -2, 7, { noAir: true }));
  assert.equal(st(sim, "S.freeze.active"), true);
  assert.ok(sim.relayHistory.filter((h) => h.on).length >= 2, "cycles from the pipe probe: " + transitions(sim));
  assert.ok(sim.minPipe > 1, "min pipe " + sim.minPipe);

  // c. both down after a cold reading: blind 15 min per hour
  sim = boot({ clockAt0: at(0, 20), temps: { 100: 2, 101: 7 }, kvs: { pool_cfg: cfg({ mode: "Force off" }), pool_state: state({ last_time: at(0, 19) }) } });
  run(sim, 120);
  delete sim.temps[100];
  delete sim.temps[101];
  run(sim, 2 * 3600 + 60);
  on = onSeconds(sim, at(0, 20, 3), at(0, 22, 3), false);
  assert.ok(Math.abs(on - 30 * 60) <= 120, "blind 15 min/h: " + on / 60);

  // d. diagnostic states outside freeze
  sim = boot({ clockAt0: at(0, 12), kvs: { pool_cfg: cfg(), pool_state: state({ last_time: at(0, 11) }) } });
  sim.temps = { 100: 15 };
  run(sim, 90); // discovery first (5 batches), then the state
  assert.equal(sim.lastState().diag, "sonde_eau_hs");
  sim.temps = { 101: 20 };
  run(sim, 70);
  assert.equal(sim.lastState().diag, "sonde_air_hs");
  sim.temps = { 100: 99, 101: 20 };
  run(sim, 70);
  assert.equal(sim.lastState().diag, "sonde_air_hs", "99 °C is out of range");
  assertAlive(sim);
});

test("12. manual override in Auto lasts until the next planned change", () => {
  const sim = boot({ clockAt0: at(0, 11), relay: true, kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 24.5, last_time: at(0, 10) }) } });
  const world = summerWorld(() => 24.5);
  runUntil(sim, at(0, 12), world);
  sim.setRelay(false, "button");
  runUntil(sim, at(0, 17), world);
  assert.equal(sim.relay, false, "manual stop held during the window");
  assert.equal(JSON.parse(sim.mqtt.retained[DEV + "/pool/diag"]).manual, "OFF");
  runUntil(sim, at(0, 20), world);
  assert.equal(st(sim, "S.manual"), null, "override ended at the planned stop (18:04)");
  sim.setRelay(true, "button");
  runUntil(sim, at(1, 3), world);
  assert.equal(sim.relay, true, "manual start held overnight");
  runUntil(sim, at(1, 12), world);
  assert.equal(st(sim, "S.manual"), null, "override ended at the planned start");
  assert.equal(sim.relay, true);
  runUntil(sim, at(1, 19), world);
  assert.equal(sim.relay, false, "normal stop afterwards");
  assertAlive(sim);
});

test("13. MQTT down for a day, then reconnect; old retained commands ignored and cleared", () => {
  const sim = boot({ clockAt0: at(0, 10), relay: true, kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 24.5, last_time: at(0, 9) }) } });
  sim.mqtt.retained[DEV + "/select/cmd"] = "Force on";
  sim.mqtt.retained[DEV + "/number/cmd"] = "0.6";
  const world = summerWorld(() => 24.5);
  runUntil(sim, at(0, 12), world);
  assert.equal(st(sim, "S.cfg.mode"), "Auto", "old retained Force on ignored");
  assert.equal(sim.mqtt.retained[DEV + "/select/cmd"], undefined, "old retained command cleared");
  assert.equal(sim.mqtt.retained[DEV + "/number/cmd"], undefined);
  sim.mqttConnect(false);
  const published = sim.mqtt.published.length;
  runUntil(sim, at(1, 12), world);
  assertTime(firstChange(sim, false, at(0, 12)), at(0, 18, 4), 3, "stops on time without MQTT");
  assert.equal(sim.mqtt.published.length, published, "nothing published while down");
  sim.mqttConnect(true);
  run(sim, 60, world);
  const disc = sim.mqtt.published.slice(published).filter((p) => p.topic.indexOf("homeassistant/") === 0);
  assert.equal(disc.length, 17, "discovery republished");
  assert.ok(sim.lastState().pump);
  assert.equal(st(sim, "S.mqtt.connects"), 2);
  assertAlive(sim);
});

test("14. invalid commands and corrupted storage", () => {
  const sim = boot({ clockAt0: at(0, 10), kvs: { pool_cfg: "garbage{", pool_state: { day: "x", tmax_today: 999, last_time: "y" } } });
  run(sim, 30);
  assert.equal(st(sim, "S.cfg.mode"), "Auto");
  assert.ok(sim.errors().some((l) => l.msg.indexOf("pool_cfg had invalid fields") >= 0));
  run(sim, 30);
  assert.equal(sim.kvs.pool_cfg.mode, "Auto", "rewritten with valid values");
  assert.equal(sim.kvs.pool_state.tmax_today, null);
  const errorsBefore = sim.errors().length;
  for (const [k, v] of [["coeff", ""], ["coeff", "abc"], ["coeff", "NaN"], ["mode", "Turbo"], ["mode", "auto"], ["foo", "1"], ["hg_cycle", "{}"]]) send(sim, k, v);
  assert.equal(sim.errors().length - errorsBefore, 6, "empty payload ignored, the 6 others reported");
  send(sim, "coeff", "1e9");
  assert.equal(st(sim, "S.cfg.coeff"), 1.6);
  send(sim, "coeff", "-50");
  assert.equal(st(sim, "S.cfg.coeff"), 0.6);
  send(sim, "hg_air_off", "0");
  assert.equal(st(sim, "S.cfg.hg_air_off"), 1, "exit kept 0.5 °C above entry");
  send(sim, "hg_cycle", "17");
  assert.equal(st(sim, "S.cfg.hg_cycle"), 15, "snapped to the 5 min step");
  run(sim, 30);
  assert.equal(sim.kvs.pool_cfg.coeff, 0.6);
  assertAlive(sim);
});

test("15. watchdog schedule, and a script-only restart keeps the estimated clock", () => {
  let sim = boot({ clockAt0: at(0, 10), kvs: { pool_cfg: cfg(), pool_state: state({ last_time: at(0, 9) }) } });
  run(sim, 60);
  const wd = sim.schedules.filter((j) => j.calls[0].method === "Script.Start");
  assert.equal(wd.length, 1);
  assert.equal(wd[0].timespec, "0 */30 * * * *");
  assert.equal(wd[0].calls[0].params.id, sim.scriptId);
  run(sim, 60);
  assert.equal(sim.schedules.filter((j) => j.calls[0].method === "Script.Start").length, 1, "not duplicated");

  // Device rebooted without any clock: estimated time, saved every hour.
  sim = reboot(sim, 600, { ntp: false, http: () => null });
  run(sim, 2.5 * 3600);
  const estimate = st(sim, "S.clock.unix");
  // The script alone restarts (crash + watchdog): same uptime, same KVS.
  const restarted = boot({ up: sim.up, clockAt0: sim.clockAt0, ntp: false, http: () => null, kvs: JSON.parse(JSON.stringify(sim.kvs)) });
  restarted.advance(30);
  const after = st(restarted, "S.clock.unix");
  assert.ok(Math.abs(after - (estimate + 30)) <= 20, "estimate continues: " + hm(estimate) + " -> " + hm(after));
});

test("16. chaos: random API failures never stop the script", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const sim = boot({ clockAt0: at(0, 10), relay: true, kvs: { pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 24.5, last_time: at(0, 9) }) } });
  sim.faults["status:temperature"] = (id) => {
    const r = rnd();
    if (r < 0.05) throw new Error("probe bus error");
    if (r < 0.1) return null;
    if (r < 0.15) return { tC: "abc" };
    if (r < 0.2) return {};
    return { id, tC: id === 100 ? 20 : 24.5 };
  };
  sim.faults["mqtt:publish"] = () => {
    if (rnd() < 0.05) throw new Error("mqtt buffer full");
    return true;
  };
  sim.faults["call:KVS.Set"] = () => (rnd() < 0.5 ? [null, -1, "flash busy"] : [{}, 0, ""]);
  sim.faults["call:Switch.Set"] = (p) => {
    if (rnd() < 0.3) return [null, -2, "relay error"];
    sim.setRelay(!!p.on, "loopback");
    return [{}, 0, ""];
  };
  run(sim, 2 * 86400);
  assertAlive(sim);
  assert.ok(st(sim, "S.diag.errors") > 0, "errors were caught and counted");
  // Faults gone: normal behaviour resumes.
  sim.faults = {};
  sim.temps = { 100: 20, 101: 24.5 };
  runUntil(sim, at(3, 12));
  assert.equal(sim.relay, true);
  runUntil(sim, at(3, 19));
  assert.equal(sim.relay, false);
  assert.ok(sim.timers.filter((t) => t.active).length <= 2, "timers");
  assert.ok(st(sim, "S.rpc.q.length - S.rpc.head") === 0, "RPC queue drained");
  assertAlive(sim);
});

// --------------------------------------------------------------------------
// v2.1: installation settings in KVS "pool_site"

test("17. custom site: probe ids, name and discovery prefix from pool_site", () => {
  const sim = boot({
    clockAt0: at(0, 12),
    temps: { 102: 3, 103: 21.5 },
    kvs: { pool_site: { air_id: 102, water_id: 103, name: "piscine", ha_prefix: "ha" }, pool_cfg: cfg(), pool_state: state({ last_time: at(0, 11) }) },
  });
  run(sim, 120);
  assert.equal(st(sim, "S.air"), 3);
  assert.equal(st(sim, "S.water"), 21.5);
  const topics = Object.keys(sim.mqtt.retained).filter((t) => t.indexOf("/config") > 0);
  assert.equal(topics.length, 17);
  assert.ok(topics.every((t) => t.indexOf("ha/") === 0), topics[0]);
  const coeff = JSON.parse(sim.mqtt.retained["ha/number/" + DEV + "/coeff/config"]);
  assert.equal(coeff.unique_id, "441793947564:piscine_coeff");
  assert.equal(coeff.device.name, "piscine");
  assert.deepEqual(noUnexpectedErrors(sim), []);
});

test("18. MQTT disabled: no subscription, no publication, the pump is still driven", () => {
  const sim = boot({ clockAt0: at(0, 10), relay: true, kvs: { pool_site: { mqtt: false }, pool_cfg: cfg(), pool_state: state({ tmax_yesterday: 24.5, last_time: at(0, 9) }) } });
  runUntil(sim, at(0, 20), summerWorld(() => 24.5));
  assert.equal(sim.mqtt.subs.length, 0);
  assert.equal(sim.mqtt.published.length, 0);
  assertTime(firstChange(sim, false, at(0, 10)), at(0, 18, 4), 3, "stop");
});

test("19. HA discovery disabled: state and commands over MQTT, no discovery", () => {
  const sim = boot({ clockAt0: at(0, 10), kvs: { pool_site: { ha_discovery: false }, pool_cfg: cfg(), pool_state: state({ last_time: at(0, 9) }) } });
  run(sim, 120);
  assert.equal(sim.mqtt.published.filter((p) => p.topic.indexOf("/config") > 0).length, 0);
  assert.ok(sim.lastState(), "state published");
  send(sim, "coeff", "1.4");
  assert.equal(st(sim, "S.cfg.coeff"), 1.4);
});

test("20. no location: reported, solar noon assumed for longitude 0", () => {
  const sim = boot({ clockAt0: at(0, 12), location: { tz: "Europe/Paris", lat: null, lon: null }, kvs: { pool_cfg: cfg(), pool_state: state({ last_time: at(0, 11) }) } });
  run(sim, 120);
  assert.equal(sim.lastState().diag, "position_absente");
  assert.ok(sim.errors().some((l) => l.msg.indexOf("no longitude") >= 0));
  assert.equal(JSON.parse(sim.mqtt.retained[DEV + "/pool/diag"]).longitude, null);
  // pool_site longitude wins over a missing location
  const sim2 = boot({ clockAt0: at(0, 12), location: null, kvs: { pool_site: { longitude: 1.2299 }, pool_cfg: cfg(), pool_state: state({ last_time: at(0, 11) }) } });
  run(sim2, 120);
  assert.equal(sim2.lastState().diag, "ok");
});

test("21. fallback clock defaults to the gateway; [] disables it; invalid pool_site fields reported", () => {
  // DHCP: gateway guessed as <own IP>.1
  let sim = boot({ clockAt0: at(0, 10), ntp: false, kvs: { pool_cfg: cfg(), pool_state: state({ last_time: at(0, 9) }) } });
  run(sim, 200);
  let req = sim.rpcLog.find((r) => r.method === "HTTP.Request");
  assert.equal(req.params.url, "http://192.168.1.1/");
  assert.equal(req.params.method, "HEAD");
  assert.equal(st(sim, "S.clock.src"), "http");
  // Static IP: gateway from the Wi-Fi settings
  sim = boot({ clockAt0: at(0, 10), ntp: false, wifi: { gw: "10.0.0.254", ip: "10.0.0.42" }, kvs: { pool_cfg: cfg() } });
  run(sim, 200);
  assert.equal(sim.rpcLog.find((r) => r.method === "HTTP.Request").params.url, "http://10.0.0.254/");
  // Disabled
  sim = boot({ clockAt0: at(0, 10), ntp: false, kvs: { pool_site: { time_urls: [] }, pool_cfg: cfg(), pool_state: state({ last_time: at(0, 9) }) } });
  run(sim, 900);
  assert.equal(sim.rpcLog.filter((r) => r.method === "HTTP.Request").length, 0, "time_urls [] : no request");
  // Invalid fields
  sim = boot({ clockAt0: at(0, 10), kvs: { pool_site: { water_id: 7, name: "Pool Pump!", colour: "blue", air_id: 104 }, pool_cfg: cfg() } });
  sim.temps[104] = 12;
  run(sim, 60);
  assert.equal(st(sim, "S.site.water_id"), 101, "invalid id ignored");
  assert.equal(st(sim, "S.site.name"), "pool_pump", "invalid name ignored");
  assert.equal(st(sim, "S.site.air_id"), 104, "valid field kept");
  assert.ok(sim.errors().some((l) => l.msg.indexOf("pool_site") >= 0));
  assertAlive(sim);
});

test("22. pool_site written as a JSON string (Shelly web UI KVS page) is accepted", () => {
  const sim = boot({ clockAt0: at(0, 10), temps: { 105: 9 }, kvs: { pool_site: '{"air_id":105}', pool_cfg: cfg() } });
  run(sim, 60);
  assert.equal(st(sim, "S.site.air_id"), 105);
  assert.equal(st(sim, "S.air"), 9);
  assert.deepEqual(noUnexpectedErrors(sim), []);
});

