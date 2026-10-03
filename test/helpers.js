"use strict";
const fs = require("fs");
const path = require("path");
const { createSim } = require("./shelly_sim");

const CODE = fs.readFileSync(path.join(__dirname, "..", "pool.js"), "utf8");
const DEV = "shellyplus1-441793947564";
// Fallback clock URLs of the reference installation (KVS pool_site).
const TIME_URLS = ["http://192.168.1.1/x404", "http://192.168.1.105:8123/api/"];
const OFFSET = 7200; // CEST, valid for the simulated dates (early October 2026)
const MIDNIGHT = 1790978400; // 2026-10-03 00:00 local

// Local time of day `day` (0 = 2026-10-03) at h:m.
function at(day, h, m) {
  return MIDNIGHT + day * 86400 + h * 3600 + (m || 0) * 60;
}

function hm(unix) {
  const d = new Date((unix + OFFSET) * 1000);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return "D" + Math.floor((unix - MIDNIGHT) / 86400) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}

function boot(opts) {
  opts = opts || {};
  const sim = createSim(opts);
  sim.temps = Object.assign({ 100: 15, 101: 20 }, opts.temps || {});
  sim.load(CODE);
  return sim;
}

// Device reboot after `outage` seconds without power; the relay restores its last state.
function reboot(old, outage, opts) {
  opts = opts || {};
  const sim = createSim(
    Object.assign(
      {
        clockAt0: old.trueUnix() + outage,
        relay: old.relay,
        kvs: JSON.parse(JSON.stringify(old.kvs)),
        schedules: old.schedules,
      },
      opts
    )
  );
  sim.temps = Object.assign({}, old.temps, opts.temps || {});
  sim.mqtt.retained = Object.assign({}, old.mqtt.retained);
  sim.load(CODE);
  return sim;
}

// Steps the simulation tick by tick, calling world(sim) before each step to update probes.
function run(sim, seconds, world, step) {
  step = step || 10;
  for (let t = 0; t < seconds; t += step) {
    if (world) world(sim);
    sim.advance(Math.min(step, seconds - t));
  }
}

function runUntil(sim, unix, world, step) {
  run(sim, Math.max(0, unix - sim.trueUnix()), world, step);
}

function S(sim, expr) {
  return sim.eval(expr);
}

function send(sim, key, msg) {
  sim.mqttSend(DEV + "/pool/cmd/" + key, msg);
  sim.advance(1);
}

// Relay transitions (ON/OFF with local time) since `fromUnix`.
function transitions(sim, fromUnix) {
  return sim.relayHistory.filter((h) => h.unix >= (fromUnix || 0)).map((h) => hm(h.unix) + " " + (h.on ? "ON" : "OFF"));
}

// Seconds the relay was ON between two real-world times, from the relay history.
function onSeconds(sim, from, to, initialOn) {
  let on = initialOn;
  let last = from;
  let total = 0;
  for (const h of sim.relayHistory) {
    if (h.unix < from) {
      on = h.on;
      continue;
    }
    if (h.unix > to) break;
    if (on) total += h.unix - last;
    on = h.on;
    last = h.unix;
  }
  if (on) total += to - last;
  return total;
}

function noUnexpectedErrors(sim, allowed) {
  allowed = allowed || [];
  return sim.errors().filter((l) => !allowed.some((a) => l.msg.indexOf(a) >= 0)).map((l) => l.msg);
}

module.exports = { CODE, DEV, TIME_URLS, MIDNIGHT, at, hm, boot, reboot, run, runUntil, S, send, transitions, onSeconds, noUnexpectedErrors };
