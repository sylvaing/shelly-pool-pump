/**
 * Pool pump controller for a Shelly Plus 1 (Gen2, firmware 1.7+).
 * https://github.com/sylvaing/shelly-pool-pump
 *
 * The Shelly decides alone: no network, MQTT or Home Assistant is needed to
 * filter the pool. Home Assistant (MQTT discovery) displays state and sends
 * settings, which are validated and persisted on the device.
 *
 * Every tick the relay target is:
 *   freeze demand OR (manual override, else Force on / Force off / Auto window)
 * - Auto: filtration window centred on the solar noon, duration from the
 *   highest water temperature of today and yesterday.
 * - Freeze protection: short pump cycles when the still water in the pipe
 *   gets cold; it can only turn the pump on, never off.
 *
 * KVS keys: "pool_site" (installation settings, written by the user, optional),
 * "pool_cfg" (user settings, also set from HA), "pool_state" (daily temperatures,
 * last known time). Engine limits (Shelly 1.7.1): no arrow functions, no template
 * literals, no Array.shift, 5 timers, ~25 KB heap shared by all scripts.
 */

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

let VERSION = "2.1.0";
let DRY_RUN = false; // log decisions only: no relay, KVS, schedule, clock or MQTT writes
let DEBUG = false;

// Installation settings. Change them without editing the code by storing a JSON object
// with only the fields to override in KVS "pool_site", then restart the script, e.g.
//   {"water_id":102,"time_urls":["http://192.168.1.10/"]}
// The Shelly web UI edits KVS on its "KVS" page.
let SITE_DEFAULTS = {
  switch_id: 0, // relay driving the pump contactor
  air_id: 100, // DS18B20 in the air around the pump and filter
  water_id: 101, // DS18B20 on the pipe: pool water when running, still water when stopped
  name: "pool_pump", // HA device name and unique_id prefix: keep it once entities exist
  longitude: null, // null: use the Shelly location (Settings > Location)
  time_urls: null, // fallback clock when NTP fails: null = the network gateway, [] = none
  mqtt: true, // publish state and accept commands over MQTT
  ha_discovery: true, // announce the entities to Home Assistant
  ha_prefix: "homeassistant",
};

let BOOT_DELAY_MS = 10000;
let TICK_MS = 10000;
let LOAD_TIMEOUT_S = 60;
let RPC_TIMEOUT_S = 30;
let RPC_QUEUE_MAX = 20;
let PENDING_TIMEOUT_S = 30;
let CFG_SAVE_DELAY_S = 10;
let TIME_SAVE_S = 3600;
let STATE_PUBLISH_S = 60;
let DIAG_PUBLISH_S = 300;
let DISCOVERY_PER_TICK = 4;

// Fallback clock: HEAD request (headers only: a page body could exhaust the script
// memory) and its Date header.
let HTTP_TIME_DELAY_S = 120;
let MAX_TIME_URLS = 3;
let HTTP_TIME_RETRY_S = 300;
let MIN_VALID_TIME = 1767225600; // 2026-01-01
let MAX_VALID_TIME = 4102444800; // 2100-01-01
let WATCHDOG_TIMESPEC = "0 */30 * * * *";

let TEMP_MIN = -30;
let TEMP_MAX = 60;
let TMAX_SETTLE_S = 300; // pipe holds room-temperature water for the first minutes
let TMAX_SAVE_STEP = 0.5;
let MAX_DURATION_H = 23;
let FALLBACK_DURATION_H = 4;
let RELAY_TEMP_ALERT = 85;

let FREEZE_SETTLE_S = 300;
let FREEZE_EXTEND_MARGIN = 0.5;
let FREEZE_PIPE_ONLY_OFF_S = 1800;
let FREEZE_PIPE_ONLY_EXIT_MARGIN = 1;
let FREEZE_COLD_TIER = -3;
let FREEZE_BLIND_AIR = 3;
let FREEZE_HYSTERESIS_MIN = 0.5;
let FREEZE_CONTINUOUS_HYSTERESIS = 0.5;

let MODES = ["Auto", "Force on", "Force off"];
// [min, max, step]
let CFG_LIMITS = {
  coeff: [0.6, 1.6, 0.1],
  hg_air_on: [-2, 3, 0.5],
  hg_air_off: [-1.5, 5, 0.5],
  hg_pipe: [1, 5, 0.5],
  hg_cycle: [5, 60, 5],
  hg_air_continu: [-10, 0, 1],
};
let CFG_DEFAULTS = {
  mode: "Auto",
  coeff: 1,
  hg_air_on: 0.5,
  hg_air_off: 1,
  hg_pipe: 2,
  hg_cycle: 15,
  hg_air_continu: -5,
};
let LEGACY_KEYS = ["coeff", "temp", "pool_temp_max"];

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let S = {
  booted: false,
  loaded: false,
  loading: false,
  kvsBlocked: false, // set when KVS could not be read: never overwrite it with defaults
  migrate: false,
  site: SITE_DEFAULTS,
  cfg: null,
  st: null,
  cfgDirtyAt: null,
  stSavedAt: 0,
  stSavedTmax: null,

  deviceId: "",
  mac: "",
  fw: "",
  scriptId: 0,
  availTopic: "",
  locationLon: null, // from the Shelly settings
  gatewayUrl: null, // default fallback clock
  timeUrls: [],
  lon: 0,
  lonMissing: false,
  up: 0,
  bootUp: 0,

  clock: { src: "none", unix: null, off: null, estBase: null },
  air: null,
  water: null,
  lastAir: null,
  relay: false,
  relayChangeUp: 0,
  relayTemp: null,
  pending: null, // { on, until }: switch command sent by this script
  manual: null, // { on, mode, base }: relay changed by someone else
  dryWant: null,

  freeze: { active: false, continuous: false, cycleEnd: 0, anchor: 0, reason: "" },
  plan: { duration: FALLBACK_DURATION_H, autoOn: false, startTs: null, stopTs: null, want: false },

  rpc: { q: [], head: 0, busy: null, seq: 0 },
  http: { nextAt: 0, idx: 0 },
  mqtt: { setup: false, disc: -1, lastState: "", stateAt: 0, diagKey: "", diagAt: 0, connects: 0 },
  schedulesDone: false,
  diag: { errors: 0, lastErr: "", lastErrTs: null, kvsWrites: 0 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  print("[pool] " + msg);
}

function debug(msg) {
  if (DEBUG) print("[pool:debug] " + msg);
}

function noteError(where, e) {
  let msg = e && e.message ? e.message : String(e);
  S.diag.errors++;
  S.diag.lastErr = where + ": " + msg;
  S.diag.lastErrTs = S.clock.unix;
  print("[pool:error] " + S.diag.lastErr);
}

function mod(a, n) {
  let r = a % n;
  return r < 0 ? r + n : r;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function isNum(x) {
  return typeof x === "number" && !isNaN(x) && isFinite(x);
}

function onOff(on) {
  return on ? "ON" : "OFF";
}

// ---------------------------------------------------------------------------
// 2. Pure computations (no Shelly API, unit tested on a computer)
// ---------------------------------------------------------------------------

// Number from a number or a numeric string, clamped and snapped to the step.
// Returns null when the input is not a number.
function cleanNumber(raw, limits) {
  let v = raw;
  if (typeof v === "string") v = v.trim().length > 0 ? Number(v) : NaN;
  if (!isNum(v)) return null;
  v = Math.min(Math.max(v, limits[0]), limits[1]);
  return round2(Math.round(v / limits[2]) * limits[2]);
}

function cleanTemp(raw) {
  return isNum(raw) && raw >= TEMP_MIN && raw <= TEMP_MAX ? raw : null;
}

function asObject(raw) {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  return raw !== null && typeof raw === "object" ? raw : null;
}

// The exit threshold always stays at least FREEZE_HYSTERESIS_MIN above the entry one.
function fixFreezeHysteresis(cfg) {
  if (cfg.hg_air_off < cfg.hg_air_on + FREEZE_HYSTERESIS_MIN) {
    cfg.hg_air_off = cfg.hg_air_on + FREEZE_HYSTERESIS_MIN;
  }
}

// Returns { cfg, bad }: every invalid or missing field falls back to its default.
function validateCfg(raw) {
  let src = asObject(raw);
  let bad = raw !== undefined && raw !== null && src === null;
  let cfg = { v: 1, mode: CFG_DEFAULTS.mode };
  if (src !== null && src.mode !== undefined) {
    if (MODES.indexOf(src.mode) >= 0) cfg.mode = src.mode;
    else bad = true;
  }
  for (let k in CFG_LIMITS) {
    let v = src !== null ? cleanNumber(src[k], CFG_LIMITS[k]) : null;
    if (v === null && src !== null && src[k] !== undefined) bad = true;
    cfg[k] = v === null ? CFG_DEFAULTS[k] : v;
  }
  fixFreezeHysteresis(cfg);
  return { cfg: cfg, bad: bad };
}

// Returns { st, bad }. legacyTmax is the old script's "pool_temp_max" key.
function validateState(raw, legacyTmax) {
  let src = asObject(raw);
  let bad = raw !== undefined && raw !== null && src === null;
  let st = { v: 1, day: null, tmax_today: null, tmax_yesterday: null, last_time: null, last_up: 0, off: null };
  if (src !== null) {
    if (isNum(src.day) && src.day > 0) st.day = Math.floor(src.day);
    st.tmax_today = cleanTemp(src.tmax_today);
    st.tmax_yesterday = cleanTemp(src.tmax_yesterday);
    if (isNum(src.last_time) && src.last_time > MIN_VALID_TIME && src.last_time < MAX_VALID_TIME) {
      st.last_time = Math.floor(src.last_time);
      if (isNum(src.last_up) && src.last_up >= 0) st.last_up = src.last_up;
    }
    if (isNum(src.off) && Math.abs(src.off) <= 14 * 3600) st.off = src.off;
  } else {
    st.tmax_yesterday = cleanTemp(typeof legacyTmax === "string" ? Number(legacyTmax) : legacyTmax);
  }
  return { st: st, bad: bad };
}

function isName(x, extra) {
  if (typeof x !== "string" || x.length === 0 || x.length > 32) return false;
  for (let i = 0; i < x.length; i++) {
    let c = x[i];
    let ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_" || extra.indexOf(c) >= 0;
    if (!ok) return false;
  }
  return true;
}

function isId(x, min, max) {
  return isNum(x) && Math.floor(x) === x && x >= min && x <= max;
}

// Returns { site, bad }: defaults overridden by the valid fields of KVS "pool_site".
function validateSite(raw) {
  let src = asObject(raw);
  let bad = raw !== undefined && raw !== null && src === null;
  let site = {};
  for (let k in SITE_DEFAULTS) site[k] = SITE_DEFAULTS[k];
  if (src === null) return { site: site, bad: bad };
  let checks = {
    switch_id: isId(src.switch_id, 0, 3),
    air_id: isId(src.air_id, 100, 199),
    water_id: isId(src.water_id, 100, 199),
    name: isName(src.name, ""),
    longitude: src.longitude === null || (isNum(src.longitude) && Math.abs(src.longitude) <= 180),
    time_urls: src.time_urls === null || (Array.isArray(src.time_urls) && src.time_urls.length <= MAX_TIME_URLS),
    mqtt: typeof src.mqtt === "boolean",
    ha_discovery: typeof src.ha_discovery === "boolean",
    ha_prefix: isName(src.ha_prefix, "/-"),
  };
  if (checks.time_urls && src.time_urls !== null) {
    for (let i = 0; i < src.time_urls.length; i++) {
      let u = src.time_urls[i];
      if (typeof u !== "string" || u.indexOf("http") !== 0) checks.time_urls = false;
    }
  }
  for (let k in src) {
    if (checks[k] === undefined) bad = true; // unknown field
    else if (checks[k]) site[k] = src[k];
    else bad = true;
  }
  return { site: site, bad: bad };
}

function referenceTemp(today, yesterday) {
  if (today === null) return yesterday;
  if (yesterday === null) return today;
  return Math.max(today, yesterday);
}

// Filtration hours for a reference water temperature (original table, capped at 23 h).
function durationHours(t, coeff) {
  if (t === null) return FALLBACK_DURATION_H;
  let h;
  if (t < 4) h = 0.5;
  else if (t < 10) h = t / 7;
  else if (t < 12) h = t - 8;
  else if (t < 16) h = t / 2 - 2;
  else if (t < 24) h = t / 4 + 2;
  else if (t < 27) h = (t * 4) / 3 - 24;
  else if (t < 30) h = t * 4 - 96;
  else h = MAX_DURATION_H;
  return Math.min(h * coeff, MAX_DURATION_H);
}

function localDay(unix, off) {
  return Math.floor((unix + off) / 86400);
}

function minuteOfDay(unix, off) {
  return Math.floor(mod(unix + off, 86400) / 60);
}

// Local solar noon in minutes after midnight (NOAA equation of time, ~1 min accuracy).
function solarNoonMinutes(unix, off, lon) {
  let dayOfYear = mod(Math.floor(unix / 86400) - 10957, 365.2425); // days since 2000-01-01
  let g = (2 * Math.PI * dayOfYear) / 365;
  let eot =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  return 720 - 4 * lon - eot + off / 60;
}

// Filtration window around the solar noon. Works across midnight.
// Returns { on, startTs, stopTs }: the current window, or the next one.
function autoWindow(unix, off, lon, hours) {
  let durMin = Math.round(hours * 60);
  let startMin = Math.round(solarNoonMinutes(unix, off, lon) - durMin / 2);
  let since = mod(minuteOfDay(unix, off) - startMin, 1440);
  let minuteTs = unix - mod(unix, 60);
  let start = since < durMin ? minuteTs - since * 60 : minuteTs + (1440 - since) * 60;
  return { on: since < durMin, startTs: start, stopTs: start + durMin * 60 };
}

// Without any clock: run the duration right after boot, then once every 24 h.
function bootWindowOn(secondsSinceBoot, hours) {
  return mod(Math.floor(secondsSinceBoot / 60), 1440) < Math.round(hours * 60);
}

// Freeze protection. i = { air, water, lastAir, relay, onFor, offFor, up } (temperatures
// may be null when a probe is down). f = { active, continuous, cycleEnd, anchor, reason }
// is updated.
// Returns true when the pump must run.
function freezeStep(cfg, i, f) {
  let wasActive = f.active;
  if (i.air !== null) {
    if (i.air < cfg.hg_air_on) f.active = true;
    else if (i.air > cfg.hg_air_off) f.active = false;
  } else if (i.water !== null) {
    // Air probe down: the still water in the pipe tells the room temperature.
    if (!i.relay && i.offFor >= FREEZE_PIPE_ONLY_OFF_S) {
      if (i.water <= cfg.hg_pipe) f.active = true;
      else if (i.water > cfg.hg_pipe + FREEZE_PIPE_ONLY_EXIT_MARGIN) f.active = false;
    }
  } else {
    f.active = i.lastAir !== null && i.lastAir < FREEZE_BLIND_AIR;
  }
  if (!f.active) {
    f.continuous = false;
    f.cycleEnd = 0;
    f.reason = "";
    return false;
  }
  if (!wasActive) f.anchor = i.up;
  if (i.air === null) f.continuous = false;
  else if (i.air < cfg.hg_air_continu) f.continuous = true;
  else if (i.air > cfg.hg_air_continu + FREEZE_CONTINUOUS_HYSTERESIS) f.continuous = false;
  if (f.continuous) {
    f.reason = "continuous";
    return true;
  }
  if (i.water !== null) return freezePipeCycle(cfg, i, f);
  let perHour = i.air !== null && i.air < FREEZE_COLD_TIER ? 2 * cfg.hg_cycle : cfg.hg_cycle;
  f.reason = "hourly";
  return mod(Math.floor((i.up - f.anchor) / 60), 60) < Math.min(perHour, 60);
}

// Cycle triggered by the pipe temperature, extended while the pool water itself is cold.
function freezePipeCycle(cfg, i, f) {
  if (i.up < f.cycleEnd) {
    f.reason = "cycle";
    return true;
  }
  if (f.cycleEnd > 0 && i.relay && i.onFor >= FREEZE_SETTLE_S && i.water <= cfg.hg_pipe + FREEZE_EXTEND_MARGIN) {
    f.reason = "extended";
    return true;
  }
  f.cycleEnd = 0;
  if (!i.relay && i.offFor >= FREEZE_SETTLE_S && i.water <= cfg.hg_pipe) {
    f.cycleEnd = i.up + cfg.hg_cycle * 60;
    f.reason = "cycle";
    return true;
  }
  f.reason = "standby";
  return false;
}

// Decision of ranks 2 to 4 (freeze demand is OR-ed on top of it).
function baseDecision(mode, autoOn, manual) {
  if (manual !== null) return manual.on;
  if (mode === "Force on") return true;
  if (mode === "Force off") return false;
  return autoOn;
}

// A manual override lasts until the next planned change (Auto) or the next mode change.
function manualExpired(manual, mode, autoOn) {
  return manual.mode !== mode || (mode === "Auto" && autoOn !== manual.base);
}

function parseHttpDate(s) {
  if (typeof s !== "string" || s.indexOf("GMT") < 0) return null;
  let t = new Date(s).getTime() / 1000;
  if (!isNum(t) || t < MIN_VALID_TIME || t > MAX_VALID_TIME) return null;
  return Math.floor(t);
}

// ---------------------------------------------------------------------------
// 3. RPC queue: one Shelly.call at a time, dropped after RPC_TIMEOUT_S
// ---------------------------------------------------------------------------

function rpc(method, params, cb) {
  let r = S.rpc;
  if (r.q.length - r.head >= RPC_QUEUE_MAX) {
    noteError("rpc", "queue full, dropped " + method);
    return;
  }
  r.q.push({ m: method, p: params, cb: cb || null });
  rpcNext();
}

function rpcNext() {
  let r = S.rpc;
  if (r.busy !== null || r.head >= r.q.length) return;
  let item = r.q[r.head];
  r.q[r.head] = null;
  r.head++;
  if (r.head >= r.q.length) {
    r.q = [];
    r.head = 0;
  }
  r.seq++;
  r.busy = { seq: r.seq, m: item.m, cb: item.cb, at: S.up };
  debug("rpc " + item.m);
  try {
    Shelly.call(item.m, item.p, onRpcDone, r.seq);
  } catch (e) {
    r.busy = null;
    noteError("rpc " + item.m, e);
  }
}

function onRpcDone(res, code, msg, seq) {
  let b = S.rpc.busy;
  if (b === null || b.seq !== seq) return; // late answer, already timed out
  S.rpc.busy = null;
  try {
    if (b.cb !== null) b.cb(res, code, msg);
    else if (code !== 0) noteError(b.m, msg);
  } catch (e) {
    noteError(b.m, e);
  }
  try {
    rpcNext();
  } catch (e2) {
    noteError("rpc", e2);
  }
}

function rpcCheckTimeout() {
  let b = S.rpc.busy;
  if (b !== null && S.up - b.at > RPC_TIMEOUT_S) {
    S.rpc.busy = null;
    noteError("rpc", b.m + " timed out");
  }
  rpcNext();
}

// ---------------------------------------------------------------------------
// 4. Storage (KVS)
// ---------------------------------------------------------------------------

function loadStorage() {
  if (S.loading) return;
  if (S.up - S.bootUp > LOAD_TIMEOUT_S) {
    noteError("KVS", "load failed, running on defaults without saving");
    S.kvsBlocked = true;
    applyLoaded(validateSite(null), validateCfg(null), validateState(null, null), false, false);
    return;
  }
  S.loading = true;
  rpc("KVS.GetMany", { match: "pool_*" }, onStorageLoaded);
}

// KVS.GetMany answers an array of { key, value } (1.x) or an object keyed by name.
function kvsValues(res) {
  let out = {};
  let items = res && res.items ? res.items : {};
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i++) out[items[i].key] = items[i].value;
  } else {
    for (let k in items) out[k] = items[k] !== null && typeof items[k] === "object" ? items[k].value : items[k];
  }
  return out;
}

function onStorageLoaded(res, code, msg) {
  S.loading = false;
  if (code !== 0) {
    noteError("KVS load", msg); // retried on the next tick
    return;
  }
  let kv = kvsValues(res);
  applyLoaded(
    validateSite(kv.pool_site),
    validateCfg(kv.pool_cfg),
    validateState(kv.pool_state, kv.pool_temp_max),
    kv.pool_cfg === undefined,
    kv.pool_state === undefined
  );
}

function applyLoaded(site, c, s, newCfg, newState) {
  S.site = site.site;
  S.timeUrls = [];
  if (site.bad) noteError("KVS", "pool_site has invalid or unknown fields, defaults used for them");
  applySite();
  S.cfg = c.cfg;
  S.st = s.st;
  if (c.bad) noteError("KVS", "pool_cfg had invalid fields, defaults used");
  if (s.bad) noteError("KVS", "pool_state was unreadable, reset");
  S.clock.estBase = estimateBase(S.st, S.up);
  if (S.st.off !== null) S.clock.off = S.st.off;
  S.stSavedTmax = S.st.tmax_today;
  S.loaded = true;
  if (newCfg || c.bad) S.cfgDirtyAt = S.up;
  if (newState) S.migrate = true;
  if (newState || s.bad) saveState("init");
  setupMqtt();
  log(
    "loaded: mode=" + S.cfg.mode + " coeff=" + S.cfg.coeff + " tmax today=" + S.st.tmax_today +
      " yesterday=" + S.st.tmax_yesterday + (newState ? " (first run)" : "")
  );
}

// Unix time at uptime 0 when the clock is lost. last_up <= uptime means the script was
// restarted without a device reboot: the saved time already includes that uptime.
function estimateBase(st, up) {
  if (st.last_time === null) return null;
  return up >= st.last_up ? st.last_time - st.last_up : st.last_time;
}

// Settings that depend on pool_site: relay state, longitude, fallback clock URLs.
function applySite() {
  S.timeUrls = S.site.time_urls !== null ? S.site.time_urls : S.gatewayUrl !== null ? [S.gatewayUrl] : [];
  let sw = Shelly.getComponentStatus("switch", S.site.switch_id);
  if (sw === null) noteError("site", "switch " + S.site.switch_id + " not found");
  S.relay = sw ? sw.output === true : false;
  S.relayChangeUp = S.up;
  let lon = S.site.longitude !== null ? S.site.longitude : S.locationLon;
  S.lonMissing = lon === null;
  S.lon = lon === null ? 0 : lon;
  if (S.lonMissing) noteError("site", "no longitude: set the Shelly location, solar noon assumed at 12:00 UTC");
}

function canWrite() {
  return !DRY_RUN && !S.kvsBlocked;
}

function saveCfg() {
  S.cfgDirtyAt = null;
  if (!canWrite()) return;
  S.diag.kvsWrites++;
  rpc("KVS.Set", { key: "pool_cfg", value: S.cfg }, onCfgSaved);
}

function onCfgSaved(res, code, msg) {
  if (code !== 0) noteError("KVS save pool_cfg", msg);
}

function saveState(reason) {
  S.stSavedAt = S.up;
  S.stSavedTmax = S.st.tmax_today;
  if (S.clock.unix !== null) {
    S.st.last_time = S.clock.unix;
    S.st.last_up = S.up;
    S.st.off = S.clock.off;
  }
  if (!canWrite()) return;
  debug("save state (" + reason + ")");
  S.diag.kvsWrites++;
  rpc("KVS.Set", { key: "pool_state", value: S.st }, onStateSaved);
}

function onStateSaved(res, code, msg) {
  if (code !== 0) {
    noteError("KVS save pool_state", msg);
    return;
  }
  if (!S.migrate) return;
  S.migrate = false;
  for (let i = 0; i < LEGACY_KEYS.length; i++) rpc("KVS.Delete", { key: LEGACY_KEYS[i] }, onLegacyDeleted);
  log("legacy KVS keys removed");
}

function onLegacyDeleted() {
  // Missing legacy keys are expected: nothing to report.
}

// ---------------------------------------------------------------------------
// 5. Clock and sensors
// ---------------------------------------------------------------------------

// Real clock (NTP or HTTP Date), else estimated from the last saved time, else none.
function readClock(sys) {
  let c = S.clock;
  let t = sys.unixtime;
  if (isNum(t) && t > MIN_VALID_TIME && t < MAX_VALID_TIME) {
    let src = isNum(sys.last_sync_ts) ? "ntp" : "http";
    if (c.src !== src) log("clock: " + src);
    c.src = src;
    c.unix = t;
    if (isNum(sys.utc_offset)) c.off = sys.utc_offset;
  } else if (c.estBase !== null) {
    if (c.src !== "estimated") log("clock: estimated from the last saved time");
    c.src = "estimated";
    c.unix = c.estBase + S.up;
  } else {
    c.src = "none";
    c.unix = null;
  }
  if (c.off === null) c.off = 0;
}

function readTemp(id) {
  let st = Shelly.getComponentStatus("temperature", id);
  return st ? cleanTemp(st.tC) : null;
}

function readInputs() {
  S.air = readTemp(S.site.air_id);
  S.water = readTemp(S.site.water_id);
  if (S.air !== null) S.lastAir = S.air;
  let sw = Shelly.getComponentStatus("switch", S.site.switch_id);
  if (sw) {
    if (sw.output !== S.relay) relayChanged(sw.output === true, "poll");
    S.relayTemp = sw.temperature && isNum(sw.temperature.tC) ? sw.temperature.tC : null;
  }
}

// Highest pool water temperature of the day, read once the water has flowed for a while.
function updateTmax() {
  if (!S.relay || S.water === null || S.up - S.relayChangeUp < TMAX_SETTLE_S) return;
  let t = round1(S.water);
  let st = S.st;
  if (st.tmax_today !== null && t <= st.tmax_today) return;
  st.tmax_today = t;
  if (S.stSavedTmax === null || t >= S.stSavedTmax + TMAX_SAVE_STEP) saveState("tmax");
}

function rollDay() {
  let c = S.clock;
  if (c.unix === null) return;
  let day = localDay(c.unix, c.off);
  let st = S.st;
  if (st.day === day) return;
  if (st.day !== null && day > st.day) {
    if (st.tmax_today !== null) st.tmax_yesterday = st.tmax_today;
    st.tmax_today = null;
    log("new day: yesterday max=" + st.tmax_yesterday);
  }
  st.day = day;
  saveState("day");
}

// ---------------------------------------------------------------------------
// 6. Decision and relay
// ---------------------------------------------------------------------------

function evaluate() {
  let cfg = S.cfg;
  let c = S.clock;
  let p = S.plan;
  p.duration = durationHours(referenceTemp(S.st.tmax_today, S.st.tmax_yesterday), cfg.coeff);
  if (c.unix !== null) {
    let w = autoWindow(c.unix, c.off, S.lon, p.duration);
    p.autoOn = w.on;
    p.startTs = cfg.mode === "Auto" ? w.startTs : null;
    p.stopTs = cfg.mode === "Auto" ? w.stopTs : null;
  } else {
    p.autoOn = bootWindowOn(S.up - S.bootUp, p.duration);
    p.startTs = null;
    p.stopTs = null;
  }
  if (S.manual !== null && manualExpired(S.manual, cfg.mode, p.autoOn)) {
    log("manual override ended");
    S.manual = null;
  }
  let since = S.up - S.relayChangeUp;
  let freezeOn = freezeStep(
    cfg,
    {
      air: S.air,
      water: S.water,
      lastAir: S.lastAir,
      relay: S.relay,
      onFor: S.relay ? since : 0,
      offFor: S.relay ? 0 : since,
      up: S.up,
    },
    S.freeze
  );
  p.want = freezeOn || baseDecision(cfg.mode, p.autoOn, S.manual);
  applyRelay(p.want, freezeOn);
}

function applyRelay(on, byFreeze) {
  if (S.pending !== null && S.up > S.pending.until) S.pending = null;
  if (on === S.relay) {
    S.dryWant = null;
    return;
  }
  if (S.pending !== null && S.pending.on === on) return;
  let why = byFreeze ? "freeze " + S.freeze.reason : S.manual !== null ? "manual" : S.cfg.mode;
  if (DRY_RUN) {
    if (S.dryWant !== on) log("dry-run: would switch " + onOff(on) + " (" + why + ")");
    S.dryWant = on;
    return;
  }
  log("relay " + onOff(on) + " (" + why + ")");
  S.pending = { on: on, until: S.up + PENDING_TIMEOUT_S };
  rpc("Switch.Set", { id: S.site.switch_id, on: on }, onSwitchSet);
}

function onSwitchSet(res, code, msg) {
  if (code !== 0) {
    S.pending = null; // retried on the next tick
    noteError("Switch.Set", msg);
  }
}

// Any relay change not requested by this script is a manual override.
function relayChanged(on, source) {
  S.relay = on;
  S.relayChangeUp = S.up;
  S.mqtt.stateAt = 0;
  if (S.pending !== null && S.pending.on === on) {
    S.pending = null;
    return;
  }
  if (DRY_RUN || !S.loaded) return;
  S.manual = { on: on, mode: S.cfg.mode, base: S.plan.autoOn };
  log("manual override " + onOff(on) + " (" + source + ")");
}

// ---------------------------------------------------------------------------
// 7. MQTT and Home Assistant discovery
// ---------------------------------------------------------------------------

function topic(suffix) {
  return S.deviceId + "/pool/" + suffix;
}

function numTpl(field) {
  return "{{ value_json." + field + " if value_json." + field + " is number else None }}";
}

function tsTpl(field) {
  return "{{ as_datetime(value_json." + field + ") if value_json." + field + " is number else None }}";
}

function diagState() {
  if (S.freeze.active) return "hors_gel";
  if (S.water === null) return "sonde_eau_hs";
  if (S.air === null) return "sonde_air_hs";
  if (S.lonMissing) return "position_absente";
  if (S.clock.src === "none") return "attente_heure";
  if (S.clock.src === "estimated") return "heure_estimee";
  return "ok";
}

function stateJson() {
  let cfg = S.cfg;
  let st = S.st;
  let p = S.plan;
  return JSON.stringify({
    pump: S.relay,
    sel_mode: cfg.mode,
    coeff: cfg.coeff,
    duration: round2(p.duration),
    start_ts: p.startTs,
    stop_ts: p.stopTs,
    mode: S.freeze.active ? "freeze" : "summer",
    temp_max: referenceTemp(st.tmax_today, st.tmax_yesterday),
    temp_max_yesterday: st.tmax_yesterday,
    temp_current: S.water,
    temp_ext: S.air,
    diag: diagState(),
    hg_air_on: cfg.hg_air_on,
    hg_air_off: cfg.hg_air_off,
    hg_pipe: cfg.hg_pipe,
    hg_cycle: cfg.hg_cycle,
    hg_air_continu: cfg.hg_air_continu,
  });
}

function diagJson() {
  let mem = Shelly.getComponentStatus("script", S.scriptId);
  return JSON.stringify({
    version: VERSION,
    time_source: S.clock.src,
    air_probe: S.air !== null ? "ok" : "hs",
    water_probe: S.water !== null ? "ok" : "hs",
    manual: S.manual !== null ? onOff(S.manual.on) : null,
    freeze: S.freeze.reason,
    last_error: S.diag.lastErr,
    last_error_ts: S.diag.lastErrTs,
    errors: S.diag.errors,
    kvs_writes: S.diag.kvsWrites,
    kvs_blocked: S.kvsBlocked,
    longitude: S.lonMissing ? null : S.lon,
    mqtt_connects: S.mqtt.connects,
    mem_used: mem ? mem.mem_used : null,
    mem_peak: mem ? mem.mem_peak : null,
    relay_temp: S.relayTemp,
    relay_temp_alert: S.relayTemp !== null && S.relayTemp > RELAY_TEMP_ALERT,
    uptime: S.up,
  });
}

function baseEntity(uidSuffix, name) {
  return {
    device: {
      name: S.site.name,
      identifiers: [S.deviceId],
      model: "Shelly-virtual-sensors",
      manufacturer: "Isynet",
      sw_version: VERSION + " / fw " + S.fw,
    },
    unique_id: S.mac + ":" + S.site.name + uidSuffix,
    name: name,
    availability_topic: S.availTopic,
    payload_available: "true",
    payload_not_available: "false",
    state_topic: topic("state"),
  };
}

function sensorEntity(uidSuffix, name, field, unit, deviceClass, icon) {
  let e = baseEntity(uidSuffix, name);
  e.value_template = numTpl(field);
  if (unit !== null) e.unit_of_measurement = unit;
  if (deviceClass !== null) e.device_class = deviceClass;
  if (icon !== null) e.icon = icon;
  return e;
}

function numberEntity(key, uidSuffix, name, unit, icon) {
  let lim = CFG_LIMITS[key];
  let e = baseEntity(uidSuffix, name);
  e.command_topic = topic("cmd/" + key);
  e.value_template = "{{ value_json." + key + " }}";
  e.min = lim[0];
  e.max = lim[1];
  e.step = lim[2];
  e.icon = icon;
  if (unit !== null) e.unit_of_measurement = unit;
  if (key !== "coeff") {
    e.mode = "box";
    e.entity_category = "config";
  }
  return e;
}

// Discovery message number i: [component, object_id, payload], or null past the end.
// Object ids and unique_id suffixes of the first 11 entities match the previous script.
function discovery(i) {
  let e;
  if (i === 0) {
    e = baseEntity("_selectMode", "Running mode");
    e.command_topic = topic("cmd/mode");
    e.value_template = "{{ value_json.sel_mode }}";
    e.options = MODES;
    e.icon = "mdi:cog-play";
    return ["select", "mode", e];
  }
  if (i === 1) return ["number", "coeff", numberEntity("coeff", "_coeff", "coeff de filtration", null, "mdi:close-circle-multiple")];
  if (i === 2) {
    e = baseEntity("_pump", "Pool Pump");
    e.value_template = "{{ 'ON' if value_json.pump else 'OFF' }}";
    e.device_class = "running";
    e.icon = "mdi:pump";
    return ["binary_sensor", "pump", e];
  }
  if (i === 3) return ["sensor", "duration", sensorEntity("_duration", "Duration", "duration", "h", "duration", "mdi:timer")];
  if (i === 4 || i === 5) {
    let field = i === 4 ? "start" : "stop";
    e = baseEntity("_" + field, i === 4 ? "Start" : "Stop");
    e.value_template = tsTpl(field + "_ts");
    e.device_class = "timestamp";
    e.icon = "mdi:clock";
    return ["sensor", field, e];
  }
  if (i === 6) {
    e = baseEntity("_mode", "Mode");
    e.value_template = "{{ value_json.mode }}";
    e.icon = "mdi:sun-snowflake-variant";
    return ["sensor", "mode", e];
  }
  if (i === 7) return ["sensor", "temp_max", sensorEntity("_temp_max", "Max", "temp_max", "°C", "temperature", null)];
  if (i === 8) return ["sensor", "temp_max_yesterday", sensorEntity("_temp_max_yesterday", "Yesterday", "temp_max_yesterday", "°C", "temperature", null)];
  if (i === 9) return ["sensor", "temp_current", sensorEntity("_temp_current", "Now", "temp_current", "°C", "temperature", null)];
  if (i === 10) return ["sensor", "temp_ext", sensorEntity("_temp_ext", "Exterieur", "temp_ext", "°C", "temperature", null)];
  if (i === 11) {
    e = baseEntity("_diag", "Diagnostic");
    e.value_template = "{{ value_json.diag }}";
    e.json_attributes_topic = topic("diag");
    e.entity_category = "diagnostic";
    e.icon = "mdi:stethoscope";
    return ["sensor", "diag", e];
  }
  if (i === 12) return ["number", "hg_air_on", numberEntity("hg_air_on", "_hg_air_on", "Hors-gel entrée sous", "°C", "mdi:snowflake-alert")];
  if (i === 13) return ["number", "hg_air_off", numberEntity("hg_air_off", "_hg_air_off", "Hors-gel sortie au-dessus de", "°C", "mdi:snowflake-off")];
  if (i === 14) return ["number", "hg_pipe", numberEntity("hg_pipe", "_hg_pipe", "Hors-gel seuil tuyau", "°C", "mdi:pipe")];
  if (i === 15) return ["number", "hg_cycle", numberEntity("hg_cycle", "_hg_cycle", "Hors-gel durée cycle", "min", "mdi:timer-cog")];
  if (i === 16) return ["number", "hg_air_continu", numberEntity("hg_air_continu", "_hg_air_continu", "Hors-gel marche continue sous", "°C", "mdi:snowflake-thermometer")];
  return null;
}

function publishDiscoveryBatch() {
  for (let n = 0; n < DISCOVERY_PER_TICK && S.mqtt.disc >= 0; n++) {
    let d = discovery(S.mqtt.disc);
    if (d === null) {
      S.mqtt.disc = -1;
      S.mqtt.stateAt = 0;
      return;
    }
    MQTT.publish(S.site.ha_prefix + "/" + d[0] + "/" + S.deviceId + "/" + d[1] + "/config", JSON.stringify(d[2]), 0, true);
    S.mqtt.disc++;
  }
}

function mqttOn() {
  return !DRY_RUN && S.loaded && S.site.mqtt;
}

function publishState(force) {
  if (!mqttOn() || !MQTT.isConnected()) return;
  let js = stateJson();
  if (!force && js === S.mqtt.lastState && S.up - S.mqtt.stateAt < STATE_PUBLISH_S) return;
  MQTT.publish(topic("state"), js, 0, true);
  S.mqtt.lastState = js;
  S.mqtt.stateAt = S.up;
}

function publishDiag() {
  let key = diagState() + "|" + S.clock.src + "|" + S.diag.errors + "|" + (S.manual !== null) + "|" + S.freeze.reason;
  if (key === S.mqtt.diagKey && S.up - S.mqtt.diagAt < DIAG_PUBLISH_S) return;
  MQTT.publish(topic("diag"), diagJson(), 0, true);
  S.mqtt.diagKey = key;
  S.mqtt.diagAt = S.up;
}

function mqttTick() {
  if (!mqttOn() || !MQTT.isConnected()) return;
  if (S.mqtt.disc >= 0) {
    publishDiscoveryBatch();
    return;
  }
  publishState(false);
  publishDiag();
}

function onMqttConnect() {
  try {
    handleConnect();
  } catch (e) {
    noteError("mqtt connect", e);
  }
}

// Republish everything and clear the commands the old script left retained on the broker.
function handleConnect() {
  S.mqtt.connects++;
  if (!mqttOn()) return;
  MQTT.publish(S.deviceId + "/number/cmd", "", 0, true);
  MQTT.publish(S.deviceId + "/select/cmd", "", 0, true);
  S.mqtt.disc = S.site.ha_discovery ? 0 : -1;
  S.mqtt.lastState = "";
  S.mqtt.diagKey = "";
}

function onMqttCmd(t, msg) {
  try {
    handleCmd(t, msg);
  } catch (e) {
    noteError("mqtt cmd", e);
  }
}

function handleCmd(t, msg) {
  if (!S.loaded || typeof msg !== "string" || msg.length === 0) return;
  let parts = t.split("/");
  let key = parts[parts.length - 1];
  let cfg = S.cfg;
  let before = cfg[key];
  if (key === "mode") {
    if (MODES.indexOf(msg) < 0) {
      noteError("cmd mode", "unknown mode " + msg);
      return;
    }
    if (msg !== cfg.mode) S.manual = null;
    cfg.mode = msg;
  } else if (CFG_LIMITS[key] !== undefined) {
    let v = cleanNumber(msg, CFG_LIMITS[key]);
    if (v === null) {
      noteError("cmd " + key, "invalid value " + msg);
      return;
    }
    cfg[key] = v;
    fixFreezeHysteresis(cfg);
  } else {
    noteError("cmd", "unknown setting " + key);
    return;
  }
  if (cfg[key] === before && key !== "hg_air_on") {
    publishState(true);
    return;
  }
  log("set " + key + " = " + cfg[key]);
  S.cfgDirtyAt = S.up;
  evaluate();
  publishState(true);
}

// ---------------------------------------------------------------------------
// 8. Housekeeping: fallback clock, watchdog schedule, legacy schedules
// ---------------------------------------------------------------------------

function httpTimeTick() {
  let src = S.clock.src;
  let urls = S.timeUrls;
  if (src === "ntp" || src === "http" || urls.length === 0) return;
  if (S.up - S.bootUp < HTTP_TIME_DELAY_S || S.up < S.http.nextAt) return;
  S.http.nextAt = S.up + HTTP_TIME_RETRY_S;
  let url = urls[S.http.idx % urls.length];
  S.http.idx = (S.http.idx + 1) % urls.length;
  rpc("HTTP.Request", { method: "HEAD", url: url, timeout: 5 }, onHttpTime);
}

function onHttpTime(res, code, msg) {
  if (code !== 0 || !res || !res.headers) {
    log("http clock failed: " + msg);
    return;
  }
  let t = parseHttpDate(res.headers.Date || res.headers.date);
  if (t === null) {
    noteError("http clock", "invalid Date header");
    return;
  }
  if (DRY_RUN) {
    log("dry-run: would set the clock to " + t);
    return;
  }
  log("clock set from HTTP Date header");
  rpc("Sys.SetTime", { unixtime: t }, null);
}

function setupSchedules() {
  S.schedulesDone = true;
  rpc("Schedule.List", {}, onScheduleList);
}

// Keeps one watchdog job restarting this script and removes the old script's
// Switch.Set jobs: only this script drives the relay. Never Schedule.DeleteAll.
function onScheduleList(res, code, msg) {
  if (code !== 0 || !res || !Array.isArray(res.jobs)) {
    S.schedulesDone = false; // retried on the next tick
    noteError("Schedule.List", msg);
    return;
  }
  let hasWatchdog = false;
  for (let i = 0; i < res.jobs.length; i++) {
    let job = res.jobs[i];
    let call = job.calls && job.calls.length > 0 ? job.calls[0] : null;
    if (call === null || !call.params) continue;
    let method = String(call.method).toUpperCase();
    if (method === "SCRIPT.START" && call.params.id === S.scriptId) hasWatchdog = true;
    if (method === "SWITCH.SET" && call.params.id === S.site.switch_id) {
      log("removing legacy schedule " + job.id);
      rpc("Schedule.Delete", { id: job.id }, null);
    }
  }
  if (!hasWatchdog) {
    log("creating watchdog schedule");
    rpc(
      "Schedule.Create",
      { enable: true, timespec: WATCHDOG_TIMESPEC, calls: [{ method: "Script.Start", params: { id: S.scriptId } }] },
      null
    );
  }
}

function housekeeping() {
  if (S.cfgDirtyAt !== null && S.up - S.cfgDirtyAt >= CFG_SAVE_DELAY_S) saveCfg();
  if (S.clock.unix !== null && S.up - S.stSavedAt >= TIME_SAVE_S) saveState("hourly");
  httpTimeTick();
  if (!S.schedulesDone && !DRY_RUN) setupSchedules();
}

// ---------------------------------------------------------------------------
// 9. Main loop and boot
// ---------------------------------------------------------------------------

function tick() {
  let sys = Shelly.getComponentStatus("sys");
  S.up = sys.uptime;
  rpcCheckTimeout();
  if (!S.loaded) {
    loadStorage();
    return;
  }
  readClock(sys);
  readInputs();
  rollDay();
  updateTmax();
  evaluate();
  housekeeping();
  mqttTick();
}

function onTick() {
  try {
    tick();
  } catch (e) {
    noteError("tick", e);
  }
}

function onStatus(ev) {
  try {
    if (!S.loaded || ev.component !== "switch:" + S.site.switch_id || !ev.delta || typeof ev.delta.output !== "boolean") return;
    if (ev.delta.output === S.relay) return;
    S.up = Shelly.getComponentStatus("sys").uptime;
    relayChanged(ev.delta.output, ev.delta.source || "?");
  } catch (e) {
    noteError("status", e);
  }
}

function setupMqtt() {
  if (!mqttOn() || S.mqtt.setup) return;
  S.mqtt.setup = true;
  try {
    MQTT.setConnectHandler(onMqttConnect);
    MQTT.subscribe(topic("cmd/+"), onMqttCmd);
    if (MQTT.isConnected()) handleConnect();
  } catch (e) {
    noteError("mqtt setup", e);
  }
}

// http://<gateway>/ from the Wi-Fi settings (static IP), else <own IP>.1 (DHCP: usual router address).
function gatewayUrl() {
  let cfg = Shelly.getComponentConfig("wifi");
  let gw = cfg && cfg.sta && typeof cfg.sta.gw === "string" && cfg.sta.gw.length > 0 ? cfg.sta.gw : null;
  if (gw === null) {
    let st = Shelly.getComponentStatus("wifi");
    let ip = st && typeof st.sta_ip === "string" ? st.sta_ip.split(".") : [];
    if (ip.length === 4) gw = ip[0] + "." + ip[1] + "." + ip[2] + ".1";
  }
  return gw === null ? null : "http://" + gw + "/";
}

function boot() {
  let info = Shelly.getDeviceInfo();
  S.deviceId = info.id;
  S.mac = info.mac;
  S.fw = info.ver;
  S.scriptId = Shelly.getCurrentScriptId();
  S.up = Shelly.getComponentStatus("sys").uptime;
  S.bootUp = S.up;
  let sysCfg = Shelly.getComponentConfig("sys");
  if (sysCfg && sysCfg.location && isNum(sysCfg.location.lon)) S.locationLon = sysCfg.location.lon;
  S.gatewayUrl = gatewayUrl();
  let mqttCfg = Shelly.getComponentConfig("mqtt");
  S.availTopic = (mqttCfg && mqttCfg.topic_prefix ? mqttCfg.topic_prefix : S.deviceId) + "/online";
  Timer.set(TICK_MS, true, onTick);
  S.booted = true;
  Shelly.addStatusHandler(onStatus);
  log("start " + VERSION + (DRY_RUN ? " (dry-run)" : ""));
  onTick();
}

function onBoot() {
  try {
    boot();
  } catch (e) {
    noteError("boot", e);
    if (!S.booted) Timer.set(BOOT_DELAY_MS, false, onBoot);
  }
}

// Calling Shelly APIs right after a device boot can fail: start a bit later.
Timer.set(BOOT_DELAY_MS, false, onBoot);
