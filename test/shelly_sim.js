// Minimal Shelly Gen2 scripting runtime for Node, with a simulated clock.
// Usage: const sim = createSim(opts); sim.load(code); sim.advance(seconds);
"use strict";
const vm = require("vm");

function createSim(opts) {
  opts = opts || {};
  const sim = {
    up: opts.up || 0, // device uptime (s)
    clockAt0: opts.clockAt0 === undefined ? 1791015600 : opts.clockAt0, // real-world unix time at uptime 0
    ntp: opts.ntp !== false, // NTP server reachable
    utcOffset: opts.utcOffset === undefined ? 7200 : opts.utcOffset,
    temps: { 100: 15, 101: 20 },
    relay: opts.relay || false,
    relayTemp: 60,
    kvs: Object.assign({}, opts.kvs || {}),
    schedules: (opts.schedules || []).map((j) => JSON.parse(JSON.stringify(j))),
    nextScheduleId: 100,
    mqtt: { connected: opts.mqtt !== false, subs: [], published: [], retained: {}, connectHandler: null },
    http: opts.http || ((url) => ({ code: 404, headers: { Date: new Date(sim.trueUnix() * 1000).toUTCString() }, body: "" })),
    logs: [],
    calls: [],
    rpcLog: [],
    timers: [],
    timerSeq: 0,
    statusHandlers: [],
    dead: null,
    scriptId: opts.scriptId || 3,
    location: opts.location === undefined ? { tz: "Europe/Paris", lat: 43.5321, lon: 1.2299 } : opts.location,
    callDelay: 0.2,
    relayHistory: [], // { unix, on, source }
    faults: {}, // name -> function(args) returning a value or throwing, to inject API failures
  };

  sim.trueUnix = () => Math.floor(sim.clockAt0 + sim.up);
  // The device knows the time only through NTP or Sys.SetTime.
  sim.deviceUnix = () => {
    if (sim.ntp) return sim.trueUnix();
    if (sim.clockSetAt !== undefined) return Math.floor(sim.clockSetValue + (sim.up - sim.clockSetAt));
    return null;
  };

  function setRelay(on, source) {
    if (sim.relay === on) return;
    sim.relay = on;
    sim.relayHistory.push({ unix: sim.trueUnix(), on, source });
    for (const h of sim.statusHandlers) {
      sim.queue(0, () => h({ component: "switch:0", delta: { id: 0, output: on, source: source } }));
    }
  }
  sim.setRelay = setRelay;

  sim.queue = (delay, fn) => {
    sim.calls.push({ at: sim.up + delay, fn });
  };

  function rpcHandle(method, p) {
    sim.rpcLog.push({ up: sim.up, method, params: p });
    switch (method) {
      case "Switch.Set":
        setRelay(!!p.on, "loopback");
        return [{ was_on: !p.on }, 0, ""];
      case "KVS.GetMany": {
        const items = [];
        const re = new RegExp("^" + String(p.match || "*").replace(/\*/g, ".*") + "$");
        for (const k of Object.keys(sim.kvs)) if (re.test(k)) items.push({ key: k, etag: "x", value: clone(sim.kvs[k]) });
        return [{ items, offset: 0, total: Object.keys(sim.kvs).length }, 0, ""];
      }
      case "KVS.Set": {
        const s = JSON.stringify(p.value);
        if (s.length > 253) return [null, -103, "value too long: " + s.length];
        sim.kvs[p.key] = clone(p.value);
        return [{ etag: "x", rev: 1 }, 0, ""];
      }
      case "KVS.Delete":
        if (!(p.key in sim.kvs)) return [null, -105, "Argument 'key', value '" + p.key + "' not found!"];
        delete sim.kvs[p.key];
        return [{ rev: 1 }, 0, ""];
      case "Schedule.List":
        return [{ jobs: clone(sim.schedules), rev: 1 }, 0, ""];
      case "Schedule.Delete":
        sim.schedules = sim.schedules.filter((j) => j.id !== p.id);
        return [{ rev: 1 }, 0, ""];
      case "Schedule.Create": {
        const job = clone(p);
        job.id = sim.nextScheduleId++;
        sim.schedules.push(job);
        return [{ id: job.id, rev: 1 }, 0, ""];
      }
      case "HTTP.GET": {
        const r = sim.http(p.url);
        if (r === null) return [null, -114, "connection failed"];
        return [r, 0, ""];
      }
      case "Sys.SetTime":
        sim.clockSetAt = sim.up;
        sim.clockSetValue = p.unixtime;
        return [null, 0, ""];
      default:
        return [null, -114, "method not simulated: " + method];
    }
  }

  function fault(name, args) {
    const f = sim.faults[name];
    return f ? { hit: true, value: f.apply(null, args) } : { hit: false };
  }

  const Shelly = {
    call(method, params, cb, ud) {
      const fc = fault("call:" + method, [params]);
      if (fc.hit) {
        sim.queue(sim.callDelay, () => cb && cb(fc.value[0], fc.value[1], fc.value[2], ud));
        return;
      }
      if (sim.inflight >= 5) throw new Error("Too many calls in progress");
      sim.inflight = (sim.inflight || 0) + 1;
      const delay = method === "HTTP.GET" ? 1 : sim.callDelay;
      sim.queue(delay, () => {
        sim.inflight--;
        const r = rpcHandle(method, params === null ? {} : params);
        if (cb) cb(r[0], r[1], r[2], ud);
      });
    },
    getComponentStatus(type, id) {
      const f = fault("status:" + type, [id]);
      if (f.hit) return f.value;
      if (type === "sys") {
        const t = sim.deviceUnix();
        return {
          uptime: Math.floor(sim.up),
          unixtime: t,
          time: t === null ? null : "xx:xx",
          utc_offset: t === null ? null : sim.utcOffset,
          last_sync_ts: sim.ntp ? t - 100 : null,
        };
      }
      if (type === "temperature") {
        if (!(id in sim.temps)) return null;
        return { id, tC: sim.temps[id] };
      }
      if (type === "switch") return { id: 0, source: "init", output: sim.relay, temperature: { tC: sim.relayTemp } };
      if (type === "script") return { id, running: true, mem_used: 4000, mem_peak: 6000, mem_free: 20000 };
      return null;
    },
    getComponentConfig(type) {
      if (type === "sys") return { location: sim.location || { tz: "Europe/Paris", lat: null, lon: null } };
      if (type === "mqtt") return { topic_prefix: "shellyplus1-441793947564" };
      return null;
    },
    getDeviceInfo() {
      return { name: "pool_pump", id: "shellyplus1-441793947564", mac: "441793947564", ver: "1.7.1" };
    },
    getCurrentScriptId() {
      return sim.scriptId;
    },
    addStatusHandler(fn) {
      if (sim.statusHandlers.length >= 5) throw new Error("Too many status handlers");
      sim.statusHandlers.push(fn);
      return sim.statusHandlers.length;
    },
  };

  const Timer = {
    set(ms, repeat, fn, ud) {
      const active = sim.timers.filter((t) => t.active).length;
      if (active >= 5) throw new Error("Too many running timers.");
      const t = { id: ++sim.timerSeq, at: sim.up + ms / 1000, period: ms / 1000, repeat, fn, ud, active: true };
      sim.timers.push(t);
      return t.id;
    },
    clear(id) {
      const t = sim.timers.find((x) => x.id === id);
      if (t) t.active = false;
      return !!t;
    },
  };

  const MQTT = {
    isConnected: () => sim.mqtt.connected,
    setConnectHandler(fn) {
      sim.mqtt.connectHandler = fn;
    },
    setDisconnectHandler() {},
    subscribe(topic, fn) {
      if (sim.mqtt.subs.length >= 10) throw new Error("Too many subscriptions");
      sim.mqtt.subs.push({ topic, fn });
    },
    unsubscribe() {
      return true;
    },
    publish(topic, msg, qos, retain) {
      const f = fault("mqtt:publish", [topic]);
      if (f.hit) return f.value;
      if (!sim.mqtt.connected) return false;
      sim.mqtt.published.push({ up: sim.up, topic, msg, retain: !!retain });
      if (retain) {
        if (msg === "") delete sim.mqtt.retained[topic];
        else sim.mqtt.retained[topic] = msg;
      }
      return true;
    },
  };

  function guarded(fn, args) {
    if (sim.dead) return;
    try {
      fn.apply(null, args);
    } catch (e) {
      sim.dead = e; // like the firmware: an uncaught error stops the script
      sim.logs.push({ up: sim.up, msg: "UNCAUGHT " + e.stack });
    }
  }

  // The script gets its own built-ins (own realm), so they can be trimmed like on the device.
  sim.context = vm.createContext({
    Shelly,
    Timer,
    MQTT,
    print: (...a) => sim.logs.push({ up: sim.up, msg: a.join(" ") }),
  });

  sim.load = (code) => {
    // Shelly's engine has no Array.shift/padStart: make sure the script never relies on them.
    vm.runInContext("Array.prototype.shift = undefined; String.prototype.padStart = undefined; Number.isFinite = undefined;", sim.context);
    vm.runInContext(code, sim.context, { filename: "pool.js" });
  };
  sim.eval = (expr) => vm.runInContext(expr, sim.context);

  // Runs timers and pending calls in time order until uptime reaches up + seconds.
  sim.advance = (seconds) => {
    const end = sim.up + seconds;
    for (;;) {
      if (sim.dead) {
        sim.up = end;
        return;
      }
      let next = null;
      let kind = null;
      for (const t of sim.timers) if (t.active && (next === null || t.at < next.at)) (next = t), (kind = "timer");
      for (const c of sim.calls) if (next === null || c.at < next.at) (next = c), (kind = "call");
      if (next === null || next.at > end) break;
      sim.up = Math.max(sim.up, next.at);
      if (kind === "call") {
        sim.calls.splice(sim.calls.indexOf(next), 1);
        guarded(next.fn, []);
      } else {
        if (next.repeat) next.at += next.period;
        else next.active = false;
        guarded(next.fn, [next.ud]);
      }
    }
    sim.up = end;
  };

  // Simulates a broker message on a subscribed topic.
  sim.mqttSend = (topic, msg) => {
    for (const s of sim.mqtt.subs) {
      const re = new RegExp("^" + s.topic.replace(/\+/g, "[^/]+").replace(/#/g, ".*") + "$");
      if (re.test(topic)) sim.queue(0, () => s.fn(topic, msg));
    }
  };

  sim.mqttConnect = (on) => {
    sim.mqtt.connected = on;
    if (on && sim.mqtt.connectHandler) sim.queue(0, () => sim.mqtt.connectHandler());
  };

  // Advance until the real-world clock reaches unix (or by a number of seconds).
  sim.until = (unix) => sim.advance(Math.max(0, unix - sim.trueUnix()));

  sim.lastState = () => {
    const s = sim.mqtt.retained["shellyplus1-441793947564/pool/state"];
    return s ? JSON.parse(s) : null;
  };
  sim.errors = () => sim.logs.filter((l) => l.msg.indexOf("[pool:error]") === 0 || l.msg.indexOf("UNCAUGHT") === 0);
  return sim;
}

function clone(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

module.exports = { createSim };
