// Smoke test: migration from the old script, two simulated days, a few commands.
"use strict";
const fs = require("fs");
const path = require("path");
const { createSim } = require("./shelly_sim");

const code = fs.readFileSync(path.join(__dirname, "..", "pool.js"), "utf8");
const T0 = 1791014400; // 2026-10-03 10:00 local (08:00 UTC)

const sim = createSim({
  clockAt0: T0,
  relay: true,
  kvs: { coeff: "1.1", temp: "13", pool_temp_max: 24.5, "scripts-library": '{"url":"x"}' },
  schedules: [
    { id: 1, enable: true, timespec: "0 2 9 * * *", calls: [{ method: "Switch.Set", params: { id: 0, on: true } }] },
    { id: 2, enable: true, timespec: "0 22 18 * * *", calls: [{ method: "Switch.Set", params: { id: 0, on: false } }] },
  ],
});
sim.temps = { 100: 22, 101: 24.3 };
sim.load(code);

const fmt = (unix) => new Date((unix + 7200) * 1000).toISOString().slice(5, 16).replace("T", " ");
function relayLog(from) {
  return sim.rpcLog
    .filter((r) => r.method === "Switch.Set" && r.up >= from)
    .map((r) => fmt(sim.clockAt0 + r.up) + " " + (r.params.on ? "ON" : "OFF"));
}

sim.advance(30);
console.log("--- boot logs");
sim.logs.forEach((l) => console.log(Math.round(l.up), l.msg));
sim.advance(2 * 86400);
console.log("--- relay commands over 2 days:", relayLog(0));
console.log("--- schedules:", JSON.stringify(sim.schedules));
console.log("--- kvs:", JSON.stringify(sim.kvs));
const disc = Object.keys(sim.mqtt.retained).filter((t) => t.indexOf("homeassistant/") === 0);
console.log("--- discovery configs retained:", disc.length);
console.log("--- old cmd topics cleared:", sim.mqtt.published.filter((p) => /\/(number|select)\/cmd$/.test(p.topic)).map((p) => p.topic + "=" + JSON.stringify(p.msg)));
console.log("--- state:", JSON.stringify(sim.lastState()));
console.log("    start", fmt(sim.lastState().start_ts), "stop", fmt(sim.lastState().stop_ts));
console.log("--- diag attrs:", sim.mqtt.retained["shellyplus1-441793947564/pool/diag"]);

// Commands
const up0 = sim.up;
sim.mqttSend("shellyplus1-441793947564/pool/cmd/coeff", "1.23");
sim.mqttSend("shellyplus1-441793947564/pool/cmd/coeff", "abc");
sim.mqttSend("shellyplus1-441793947564/pool/cmd/hg_air_on", "2.5");
sim.mqttSend("shellyplus1-441793947564/pool/cmd/mode", "Turbo");
sim.mqttSend("shellyplus1-441793947564/pool/cmd/mode", "Force off");
sim.advance(30);
console.log("--- after commands: cfg", JSON.stringify(sim.eval("S.cfg")), "relay", sim.relay);
console.log("    kvs pool_cfg", JSON.stringify(sim.kvs.pool_cfg));
sim.setRelay(true, "button"); // manual ON while Force off
sim.advance(30);
console.log("--- manual ON in Force off: relay", sim.relay, "manual", JSON.stringify(sim.eval("S.manual")));
sim.mqttSend("shellyplus1-441793947564/pool/cmd/mode", "Auto");
sim.advance(30);
console.log("--- back to Auto: relay", sim.relay, "manual", JSON.stringify(sim.eval("S.manual")));

console.log("--- errors:", sim.errors().map((l) => l.msg));
console.log("--- script dead:", sim.dead ? sim.dead.stack : false);
console.log("--- timers active:", sim.timers.filter((t) => t.active).length, "status handlers:", sim.statusHandlers.length, "mqtt subs:", sim.mqtt.subs.map((s) => s.topic));
