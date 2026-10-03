#!/usr/bin/env node
// Small Shelly Gen2 helper for deploying and watching pool.js (Node 22+, no dependency).
//
//   node tools/shelly.mjs status
//   node tools/shelly.mjs deploy pool.js --name pool_v2_dryrun --dry-run [--autostart]
//   node tools/shelly.mjs compare <script id>      v2 dry-run decisions vs the running v1
//   node tools/shelly.mjs eval <script id> "<js expression>"
//   node tools/shelly.mjs logs [seconds] [filter]
//   node tools/shelly.mjs stop|start|delete <script id>
//
// Device: SHELLY_HOST (default 192.168.1.142).
import { readFileSync } from "node:fs";

const HOST = process.env.SHELLY_HOST || "192.168.1.142";
const CHUNK = 1024;

async function rpc(method, params) {
  const res = await fetch(`http://${HOST}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, method, params: params || {} }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result;
}

const local = (unix, off) => new Date((unix + off) * 1000).toISOString().slice(11, 16);

async function status() {
  const sys = await rpc("Sys.GetStatus");
  const sw = await rpc("Switch.GetStatus", { id: 0 });
  const air = await rpc("Temperature.GetStatus", { id: 100 }).catch(() => null);
  const water = await rpc("Temperature.GetStatus", { id: 101 }).catch(() => null);
  console.log(`time ${sys.time}  uptime ${sys.uptime}s  relay ${sw.output ? "ON" : "OFF"} (${sw.source}, ${sw.temperature?.tC} °C)`);
  console.log(`air ${air?.tC} °C  water ${water?.tC} °C`);
  const { scripts } = await rpc("Script.List");
  for (const s of scripts) {
    const st = await rpc("Script.GetStatus", { id: s.id });
    const mem = st.running ? ` mem ${st.mem_used} used / ${st.mem_peak} peak / ${st.mem_free} free` : "";
    console.log(`script ${s.id} ${s.name} enable=${s.enable} running=${st.running}${mem}${st.errors ? " errors=" + st.errors : ""}`);
  }
  const { jobs } = await rpc("Schedule.List");
  for (const j of jobs) console.log(`schedule ${j.id} ${j.enable ? "on " : "off"} ${j.timespec}  ${j.calls.map((c) => c.method + " " + JSON.stringify(c.params)).join(", ")}`);
  const { items } = await rpc("KVS.GetMany");
  console.log("kvs " + items.map((i) => `${i.key}=${JSON.stringify(i.value)}`).join("  "));
}

async function deploy(file, opts) {
  let code = readFileSync(file, "utf8");
  if (opts.dryRun) {
    if (!/^let DRY_RUN = false;/m.test(code)) throw new Error("DRY_RUN line not found");
    code = code.replace(/^let DRY_RUN = false;/m, "let DRY_RUN = true;");
  }
  const { scripts } = await rpc("Script.List");
  let s = scripts.find((x) => x.name === opts.name);
  let id;
  if (s) {
    id = s.id;
    if (s.running) await rpc("Script.Stop", { id });
  } else {
    id = (await rpc("Script.Create", { name: opts.name })).id;
  }
  for (let i = 0; i < code.length; i += CHUNK) {
    await rpc("Script.PutCode", { id, code: code.slice(i, i + CHUNK), append: i > 0 });
  }
  await rpc("Script.SetConfig", { id, config: { enable: !!opts.autostart } });
  console.log(`uploaded ${code.length} chars to script ${id} (${opts.name})${opts.dryRun ? " with DRY_RUN = true" : ""}, autostart ${!!opts.autostart}`);
  if (opts.start) {
    await rpc("Script.Start", { id });
    console.log("started");
  }
  return id;
}

async function evalIn(id, expr) {
  return (await rpc("Script.Eval", { id: Number(id), code: expr })).result;
}

// Snapshot of the v2 decisions next to what the running v1 does.
async function compare(id) {
  const v2 = JSON.parse(
    await evalIn(
      id,
      "JSON.stringify({ src: S.clock.src, unix: S.clock.unix, off: S.clock.off, plan: S.plan, cfg: S.cfg, st: S.st, " +
        "air: S.air, water: S.water, relay: S.relay, freeze: S.freeze, manual: S.manual, dryWant: S.dryWant, diag: diagState(), " +
        "errors: S.diag.errors, lastErr: S.diag.lastErr })"
    )
  );
  const { jobs } = await rpc("Schedule.List");
  const v1 = jobs.filter((j) => j.calls[0]?.method === "Switch.Set").map((j) => {
    const [, m, h] = j.timespec.split(" ");
    return `${j.calls[0].params.on ? "ON " : "OFF"} ${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  });
  const st = await rpc("Script.GetStatus", { id: Number(id) });
  const off = v2.off || 0;
  console.log(`clock ${v2.src} ${v2.unix ? local(v2.unix, off) : "-"}  diag ${v2.diag}  errors ${v2.errors}${v2.lastErr ? " (" + v2.lastErr + ")" : ""}`);
  console.log(`v2 mode ${v2.cfg.mode} coeff ${v2.cfg.coeff}  tmax today ${v2.st.tmax_today} yesterday ${v2.st.tmax_yesterday}  duration ${v2.plan.duration.toFixed(2)} h`);
  console.log(`v2 window ${v2.plan.startTs ? local(v2.plan.startTs, off) + " -> " + local(v2.plan.stopTs, off) : "-"}  wants ${v2.plan.want ? "ON" : "OFF"}  relay ${v2.relay ? "ON" : "OFF"}${v2.dryWant !== null ? "  (would switch)" : ""}`);
  console.log(`v1 schedules ${v1.join(", ") || "-"}`);
  console.log(`freeze ${v2.freeze.active ? v2.freeze.reason : "off"}  air ${v2.air}  water ${v2.water}  manual ${JSON.stringify(v2.manual)}`);
  console.log(`memory ${st.mem_used} used / ${st.mem_peak} peak / ${st.mem_free} free`);
}

// Live device log over the debug websocket.
async function logs(seconds, filter) {
  const ws = new WebSocket(`ws://${HOST}/debug/log`);
  ws.onmessage = (ev) => {
    let line = String(ev.data);
    try {
      line = JSON.parse(line).data.trimEnd();
    } catch {}
    if (!filter || line.includes(filter)) console.log(line);
  };
  ws.onerror = (e) => console.error("websocket error", e.message || e);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  ws.close();
}

const [cmd, ...args] = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
try {
  if (cmd === "status") await status();
  else if (cmd === "deploy") await deploy(args[0], { name: opt("--name") || "pool_v2", dryRun: flag("--dry-run"), autostart: flag("--autostart"), start: !flag("--no-start") });
  else if (cmd === "compare") await compare(args[0]);
  else if (cmd === "eval") console.log(await evalIn(args[0], args[1]));
  else if (cmd === "logs") await logs(Number(args[0] || 30), args[1]);
  else if (cmd === "stop" || cmd === "start") console.log(await rpc(cmd === "stop" ? "Script.Stop" : "Script.Start", { id: Number(args[0]) }));
  else if (cmd === "delete") console.log(await rpc("Script.Delete", { id: Number(args[0]) }));
  else console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 12).join("\n"));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
