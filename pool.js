/**
 * garcia.sylvain@gmail.com
 * https://github.com/sylvaing/shelly-pool-pump
 * 
 * This script is intended to manage your pool pump from a Shelly Plus device.
 * Compatible from firmware 1.0.8.
 * 
 * Based on shelly script of ggilles with lot of new features and improvements.
 * https://www.shelly-support.eu/forum/index.php?thread/14810-script-randomly-killed-on-shelly-plus-1pm/
 * 
 * FIXES applied:
 * - FIX1: RPC queue to prevent exceeding the 5 concurrent RPC limit
 * - FIX3: get_current_time() while loop has a max iteration guard (no infinite loop)
 * - FIX4: schedule24 is now a copy, not a reference to STATUS.schedule
 * - FIX5: on/time variables in compute_switch_from_schedule declared with let
 * - FIX6: debounce on temperature_change events
 * - FIX7: KVS.Get result parsed as float with fallback
 * - FIX8: update_next_noon retried every hour via a timer
 */

/**
 * @typedef {"switch" | "binary_sensor" | "sensor"} HADeviceType
 * @typedef {"config"|"stat"|"cmd"} HATopicType
 */

var CONFIG = {
  shelly_id_temp_ext: 100,
  shelly_id_temp_pool: 101,
  shelly_id: null,
  shelly_mac: null,
  shelly_fw_id: null,
  device_name: "POOL_PUMP",
  ha_mqtt_ad: "homeassistant",
  ha_dev_type: {
    name: "",
    ids: [""],
    mdl: "Shelly-virtual-sensors",
    sw: "",
    mf: "Isynet",
  },
  payloads: {
    on: "on",
    off: "off",
  },
  update_period: 60000,
  freeze_temp: 0.5,
  ha_ip: "192.168.1.105",
  ha_token: "YOUR_HA_TOKEN",
};

// FIX1: Global RPC queue — prevents exceeding Shelly's 5 concurrent RPC limit
// Note: Espruino (Shelly JS engine) does not support Array.shift()
// We use a manual head index instead
var RPC_QUEUE = [];
var RPC_HEAD = 0;
var RPC_RUNNING = false;

function rpc_enqueue(method, params, cb) {
  RPC_QUEUE.push({ method: method, params: params, cb: cb || null });
  rpc_flush();
}

function rpc_flush() {
  if (RPC_RUNNING || RPC_HEAD >= RPC_QUEUE.length) return;
  RPC_RUNNING = true;
  let item = RPC_QUEUE[RPC_HEAD];
  RPC_HEAD++;
  // Reset queue when fully consumed to free memory
  if (RPC_HEAD >= RPC_QUEUE.length) {
    RPC_QUEUE = [];
    RPC_HEAD = 0;
  }
  print("[RPC_QUEUE] call:", item.method, "queue remaining:", RPC_QUEUE.length);
  Shelly.call(item.method, item.params, function (r, ec, em) {
    RPC_RUNNING = false;
    if (item.cb) item.cb(r, ec, em);
    rpc_flush();
  });
}

var STATUS = {
  temp: 0,
  current_temp: Shelly.getComponentStatus("temperature",CONFIG.shelly_id_temp_pool).tC,
  temp_ext: Shelly.getComponentStatus("temperature",CONFIG.shelly_id_temp_ext).tC,
  temp_max: 0,
  temp_today: null,
  temp_yesterday: 0,
  next_noon: 14,
  freeze_mode: false,
  coeff: 1.2,
  sel_mode: "Force off",

  update_time: 0,
  update_time_last: 0,
  update_temp_max_last: 0,
  current_time: 0,

  disable_temp: null,
  lock_update: false,
  make_unlock: false,

  duration: null,
  schedule: null,
  start: null,
  stop: null,
  stop_orig: null,

  time: null,
  uptime: null,

  tick: 0,
  tick_mqtt: 0,
  tick_temp: 0,
  tick_lock: 0,
  tick_pump: 0,
  tick_pump_skip: 0,
  tick_day: 0,
};

// FIX6: Debounce timer for temperature_change events
var DEBOUNCE_TEMP = null;

// calcul de l'heure pivot pour répartir la programmation de la pompe
// en fonction du zenith du soleil
function update_next_noon() {
  let h = {
    method: "GET",
    url: "http://" + CONFIG.ha_ip + ":8123/api/states/sun.sun",
    headers: {
      Authorization: "Bearer " + CONFIG.ha_token,
      "Content-Type": "application/json",
    },
    timeout: 4,
  };

  // FIX1: use rpc_enqueue for HTTP.Request too
  rpc_enqueue("HTTP.Request", h, function (result, error_code, error_message) {
    if (error_code === 0) {
      let result_json = JSON.parse(result.body);
      if (
        result_json.hasOwnProperty("attributes") &&
        result_json.attributes.hasOwnProperty("next_noon")
      ) {
        let next_noon = result_json.attributes.next_noon;
        let d = new Date(next_noon);
        let new_d = d.getHours() + d.getMinutes() / 60;
        STATUS.next_noon = new_d;
        print("[POOL_NEXT_NOON] next_noon updated:", STATUS.next_noon);
      } else {
        print("[POOL_NEXT_NOON] ERROR: missing attributes, using default 14h");
        STATUS.next_noon = 14;
      }
    } else {
      print("[POOL_NEXT_NOON] ERROR HTTP:", error_code, "- using default 14h");
      STATUS.next_noon = 14;
    }
  });
}

/**
 * Construct config topic
 * @param   {HADeviceType}  hatype HA device type
 * @param   {string}        object_id
 * @returns {string}        topic
 */
function buildMQTTConfigTopic(hatype, object_id) {
  return (
    CONFIG.ha_mqtt_ad +
    "/" +
    hatype +
    "/" +
    CONFIG.shelly_id +
    "/" +
    object_id +
    "/config"
  );
}

/**
 * @param   {HADeviceType}   hatype
 * @param   {HATopicType}    topic
 * @returns {string}
 */
function buildMQTTStateCmdTopics(hatype, topic) {
  let _t = topic || "";
  if (_t.length) {
    _t = "/" + _t;
  }
  return CONFIG.shelly_id + "/" + hatype + _t;
}

/**
 * Control device switch
 * @param {boolean} sw_state
 * @param {boolean} nolock
 */
function switchActivate(sw_state, nolock) {
  print("[POOL_CALL] switch set _ switchActivate");
  // FIX1: use rpc_enqueue
  rpc_enqueue("Switch.Set", { id: 0, on: sw_state });

  if (nolock !== true) {
    STATUS.tick_lock++;
    print("[POOL] disable temp", STATUS.tick_lock);

    if (STATUS.disable_temp !== null) Timer.clear(STATUS.disable_temp);

    print("[POOL_DISABLE_TEMP] switchActivate() disable temp", STATUS.tick_lock);

    STATUS.disable_temp = Timer.set(600 * 1000, false, function () {
      print("[POOL] re-enable temp");
      STATUS.disable_temp = null;
    });
  }
}

/**
 * Listen to ~/cmd topic for number control — Coefficient filtrage
 */
function MQTTCmdListenerNumber(topic, message) {
  print("[MQTT] listen NUMBER : ", message);

  if (message !== "") {
    if (STATUS.lock_update === false) {
      print("[POOL] - MQTT listenerNumber() lock_update = false");
      let obj = JSON.parse(message);
      STATUS.coeff = obj;
      MQTT.publish(
        buildMQTTStateCmdTopics("number", "state"),
        JSON.stringify(STATUS.coeff)
      );
      update_temp(true, false);
    }
    publishState();
  }
}

/**
 * Listen to ~/cmd topic for select mode control
 */
function MQTTCmdListenerSelect(topic, message) {
  print("[MQTT] listen SELECT", message);
  STATUS.sel_mode = message;

  if (message === "Auto") {
    print("[MQTT-SELECT] AUTO", message);
    update_temp(false, true);
  } else if (message === "Force on") {
    print("[MQTT-SELECT] FORCE ON", message);
    // FIX1: use rpc_enqueue via do_call
    let calls = [];
    calls.push({ method: "Schedule.DeleteAll", params: null });
    do_call(calls);
    switchActivate(true, true);
  } else if (message === "Force off") {
    print("[MQTT-SELECT] FORCE OFF", message);
    let calls = [];
    calls.push({ method: "Schedule.DeleteAll", params: null });
    do_call(calls);
    switchActivate(false, true);
  }
}

function publishState() {
  let result = Shelly.getComponentStatus("switch", 0);

  let _sensor = {
    duration: 0,
    start: 0,
    stop: 0,
    mode: "null",
    temp_max: 0,
    temp_max_yesterday: 0,
    temp_current: 0,
    temp_ext: 0,
  };
  _sensor.duration = STATUS.duration;
  _sensor.start = STATUS.start;
  _sensor.stop = STATUS.stop_orig;
  _sensor.temp_max = STATUS.temp_max;
  _sensor.temp_max_yesterday = STATUS.temp_yesterday;
  _sensor.temp_current = STATUS.current_temp;
  _sensor.temp_ext = STATUS.temp_ext;

  if (STATUS.freeze_mode === true) {
    _sensor.mode = "freeze";
  } else {
    _sensor.mode = "summer";
  }
  _sensor.state = result.output;

  MQTT.publish(
    buildMQTTStateCmdTopics("sensor", "state"),
    JSON.stringify(_sensor)
  );
  let _state_str = _sensor.state ? "ON" : "OFF";
  MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);
  MQTT.publish(
    buildMQTTStateCmdTopics("number", "state"),
    JSON.stringify(STATUS.coeff)
  );

  if (STATUS.make_unlock) {
    STATUS.lock_update = false;
    STATUS.make_unlock = false;
    print("[POOL] - make_unlock - Publish state lock_update => false");
  }
}

/**
 * Initialize MQTT listeners and HA autodiscovery config
 */
function initMQTT() {
  MQTT.subscribe(
    buildMQTTStateCmdTopics("number", "cmd"),
    MQTTCmdListenerNumber
  );
  MQTT.publish(
    buildMQTTConfigTopic("number", "coeff"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": buildMQTTStateCmdTopics("number"),
      cmd_t: "~/cmd",
      stat_t: "~/state",
      icon: "mdi:close-circle-multiple",
      retain: "true",
      min: "0.6",
      max: "1.60",
      step: "0.1",
      name: "coeff de filtration",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_coeff",
    }),
    0,
    true
  );

  MQTT.subscribe(
    buildMQTTStateCmdTopics("select", "cmd"),
    MQTTCmdListenerSelect
  );
  let options = ["Auto", "Force on", "Force off"];
  MQTT.publish(
    buildMQTTConfigTopic("select", "mode"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": buildMQTTStateCmdTopics("select"),
      cmd_t: "~/cmd",
      options: options,
      retain: "true",
      ic: "mdi:cog-play",
      name: "Running mode",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_selectMode",
    }),
    0,
    true
  );

  let binarySensorStateTopic = buildMQTTStateCmdTopics("binary_sensor", "state");
  MQTT.publish(
    buildMQTTConfigTopic("binary_sensor", "pump"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": binarySensorStateTopic,
      stat_t: "~",
      name: "Pool Pump",
      device_class: "running",
      ic: "mdi:pump",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_pump",
    }),
    0,
    true
  );

  let sensorStateTopic = buildMQTTStateCmdTopics("sensor", "state");
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "duration"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.duration }}",
      name: "Duration",
      device_class: "duration",
      unit_of_measurement: "h",
      ic: "mdi:timer",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_duration",
    }),
    0,
    true
  );
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "start"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.start }}",
      name: "Start",
      device_class: "duration",
      unit_of_measurement: "h",
      icon: "mdi:clock",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_start",
    }),
    0,
    true
  );
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "stop"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.stop }}",
      name: "Stop",
      device_class: "duration",
      unit_of_measurement: "h",
      icon: "mdi:clock",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_stop",
    }),
    0,
    true
  );
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "mode"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.mode }}",
      name: "Mode",
      icon: "mdi:sun-snowflake-variant",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_mode",
    }),
    0,
    true
  );
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "temp_max"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.temp_max }}",
      name: "Max",
      device_class: "temperature",
      unit_of_measurement: "°C",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_temp_max",
    }),
    0,
    true
  );
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "temp_max_yesterday"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.temp_max_yesterday }}",
      name: "Yesterday",
      device_class: "temperature",
      unit_of_measurement: "°C",
      uniq_id:
        CONFIG.shelly_mac + ":" + CONFIG.device_name + "_temp_max_yesterday",
    }),
    0,
    true
  );
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "temp_current"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.temp_current }}",
      name: "Now",
      device_class: "temperature",
      unit_of_measurement: "°C",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_temp_current",
    }),
    0,
    true
  );
  MQTT.publish(
    buildMQTTConfigTopic("sensor", "temp_ext"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": sensorStateTopic,
      stat_t: "~",
      val_tpl: "{{ value_json.temp_ext }}",
      name: "Exterieur",
      device_class: "temperature",
      unit_of_measurement: "°C",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_temp_ext",
    }),
    0,
    true
  );
}

// Compute duration of filtration for a given max temperature
// Duration returned in float format (1.25 -> 1h15mn)
function compute_duration_filt(t) {
  let result = 0;
  if (t < 4) {
    result = 0.5 * STATUS.coeff;
    return result > 24 ? 23 : result;
  }
  if (t < 10) {
    result = (t / 7) * STATUS.coeff;
    return result > 24 ? 23 : result;
  }
  if (t < 12) {
    result = (t - 8) * STATUS.coeff;
    return result > 24 ? 23 : result;
  }
  if (t < 16) {
    result = (t / 2 - 2) * STATUS.coeff;
    return result > 24 ? 23 : result;
  }
  if (t < 24) {
    result = (t / 4 + 2) * STATUS.coeff;
    return result > 24 ? 23 : result;
  }
  if (t < 27) {
    result = (t * 4 / 3 - 24) * STATUS.coeff;
    return result > 24 ? 23 : result;
  }
  if (t < 30) {
    result = (t * 4 - 96) * STATUS.coeff;
    return result > 24 ? 23 : result;
  }
  return 23;
}

// Compute the pump schedule for a given duration
// Returns [ start, stop ] times in float
function compute_schedule_filt_pivot(d) {
  let matin = d / 2;
  let aprem = d - matin;
  let saprem = STATUS.next_noon + aprem;
  if (saprem >= 24) {
    saprem = saprem - 24;
  }
  let s = [STATUS.next_noon - matin, saprem];

  STATUS.start = JSON.stringify(s[0]);
  STATUS.stop = JSON.stringify(s[1]);
  STATUS.stop_orig = JSON.stringify(STATUS.next_noon + aprem);

  return s;
}

// Convert a time float to a crontab-like timespec
function time_to_timespec(t) {
  let h = Math.floor(t);
  let m = Math.floor((t - h) * 60);
  return (
    "0 " +
    JSON.stringify(m) +
    " " +
    JSON.stringify(h) +
    " * * SUN,MON,TUE,WED,THU,FRI,SAT"
  );
}

// New day: update status and recalculate
function update_new_day() {
  let t = get_current_time();

  print(
    "[POOL] [NEW_DAY] current_time:",
    t,
    "<= update_time:",
    STATUS.update_time
  );
  print(
    "[POOL] [NEW_DAY] temp_max:",
    STATUS.temp_max,
    "temp_yesterday:",
    STATUS.temp_yesterday,
    "temp_ext:",
    STATUS.temp_ext
  );

  if (t <= STATUS.update_time && STATUS.temp_today !== null) {
    STATUS.tick_day++;
    print("[POOL_NEW_DAY] update_new_day OK", STATUS.tick_day);
    STATUS.temp_yesterday = STATUS.temp_today;
    STATUS.temp_today = null;
    STATUS.update_time = t;
    update_temp(false, false);
  }
}

// Call a chain of API calls sequentially via the RPC queue
// FIX1: do_call now feeds the RPC queue instead of calling Shelly.call directly
function do_call(calls) {
  for (let i = 0; i < calls.length; i++) {
    rpc_enqueue(calls[i].method, calls[i].params);
  }
}

// Compute and configure pump schedule
function update_pump(temp, max, time) {
  STATUS.tick_pump++;
  print(
    "[POOL] update_pump",
    STATUS.tick_pump,
    "- temp:",
    temp,
    "max:",
    max,
    "time:",
    time
  );

  let duration = compute_duration_filt(max);
  let schedule = compute_schedule_filt_pivot(duration);

  print("[POOL] update_pump - duration:", duration);
  print("[POOL] update_pump - schedule:", JSON.stringify(schedule));

  STATUS.duration = duration;
  STATUS.schedule = schedule;

  if (STATUS.sel_mode === "Auto") {
    let calls = [];
    calls.push({ method: "Schedule.DeleteAll", params: null });

    let on = true;
    for (let i = 0; i < schedule.length; i++) {
      let ts = time_to_timespec(schedule[i]);
      let p = {
        id: i + 1,
        enable: true,
        timespec: ts,
        calls: [{ method: "Switch.Set", params: { id: 0, on: on } }],
      };
      calls.push({ method: "Schedule.Create", params: p });
      on = !on;
    }
    compute_switch_from_schedule();
    do_call(calls);
  }
}

function compute_switch_from_schedule() {
  if (STATUS.sel_mode === "Auto" && STATUS.freeze_mode === false) {
    // FIX5: declare on and time with let (no implicit globals)
    let on = false;
    let time = get_current_time();
    let j = false;
    // FIX4: copy the array instead of referencing STATUS.schedule directly
    let schedule24 = [STATUS.schedule[0], STATUS.schedule[1]];
    if (schedule24[1] < STATUS.next_noon) {
      schedule24[1] = schedule24[1] + 24;
    }
    for (let i = 0; i < schedule24.length; i++) {
      j = !j;
      if (time >= schedule24[i]) on = j;
    }
    print("[POOL SWITCH] time:", time, "on:", on);

    // FIX1: use rpc_enqueue
    rpc_enqueue("Switch.Set", { id: 0, on: on });
    let _state_str = on ? "ON" : "OFF";
    MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);
  }
}

function update_pump_hivernage() {
  // FIX1: use do_call which now feeds the queue
  let calls = [];
  calls.push({ method: "Schedule.DeleteAll", params: null });
  calls.push({ method: "Switch.Set", params: { id: 0, on: true } });
  do_call(calls);
}

/**
 * Update temperature from sensor
 * @param {boolean} fromUpdateCoeff
 * @param {boolean} nodisable
 */
function update_temp(fromUpdateCoeff, nodisable) {
  STATUS.tick_temp++;
  print("[POOL] update_temp", STATUS.tick_temp, STATUS.current_temp);

  if (STATUS.disable_temp !== null && nodisable !== true) {
    print("[POOL] update disabled");
    return;
  }

  if (STATUS.lock_update) {
    print("[POOL] update_temp locked");
    return;
  }
  print("[POOL] update_temp() lock_update => true");
  STATUS.lock_update = true;

  // FIX: guard against null/undefined current_temp
  let raw = STATUS.current_temp;
  if (raw === null || raw === undefined) raw = 0;
  STATUS.temp = Math.round(raw * 10) / 10;

  let switchResult = Shelly.getComponentStatus("switch", 0);
  if (switchResult.output) {
    STATUS.temp_today = Math.max(STATUS.temp_today, STATUS.temp);
    STATUS.temp_max = Math.max(STATUS.temp_today, STATUS.temp_yesterday);
  }

  STATUS.current_time = get_current_time();

  if (
    STATUS.temp_max !== STATUS.update_temp_max_last ||
    STATUS.temp_ext < CONFIG.freeze_temp ||
    STATUS.freeze_mode === true ||
    fromUpdateCoeff === true ||
    nodisable === true
  ) {
    update_temp_call();
  } else if (
    STATUS.sel_mode === "Force on" ||
    STATUS.sel_mode === "Force off"
  ) {
    print("[POOL] Force ON or Off, lock_update => false");
    STATUS.lock_update = false;
  } else {
    print("[POOL] no temp change, skip update_pump, lock_update => false");
    STATUS.lock_update = false;
  }
}

// FIX3: get_current_time with max iteration guard — no more infinite loop risk
function get_current_time() {
  print("[POOL] get_current_time");

  let result = { time: null };
  let i = 0;
  let MAX_TRIES = 10;

  while (result.time === null && i < MAX_TRIES) {
    result = Shelly.getComponentStatus("sys");
    i++;
  }

  if (result.time === null) {
    print("[POOL] ERROR: could not get sys time after", MAX_TRIES, "tries, returning 0");
    return 0;
  }

  print("[POOL] get_current_time() time:", result.time);
  let time = result.time; // "HH:MM"
  let t =
    JSON.parse(time.slice(0, 2)) + JSON.parse(time.slice(3, 5)) / 60;
  return t;
}

function update_temp_call() {
  STATUS.update_time = STATUS.current_time;
  print("[POOL TIME]", STATUS.update_time);

  if (STATUS.temp_ext < CONFIG.freeze_temp) {
    print("[POOL] Mode hivernage - temp:", STATUS.temp_ext);
    STATUS.freeze_mode = true;
    update_pump_hivernage();
    STATUS.make_unlock = true;
    publishState();
  } else {
    STATUS.freeze_mode = false;
    if (STATUS.temp_max !== null) {
      update_pump(STATUS.temp, STATUS.temp_max, STATUS.update_time);
      STATUS.update_time_last = STATUS.update_time;
      STATUS.update_temp_max_last = STATUS.temp_max;
      // FIX1: use rpc_enqueue
      rpc_enqueue(
        "KVS.Set",
        { key: "pool_temp_max", value: STATUS.temp_max },
        function (result, error_code) {
          print("[KVS.Set] error_code:", error_code);
        }
      );
    }
  }

  STATUS.make_unlock = true;
  publishState();
}

function subscribe_to_events() {
  Shelly.addEventHandler(function (data) {
    let re = JSON.stringify(data);
    print("EVENT", re);

    // Publish switch state on output change
    if (
      data.component === "switch:0" &&
      typeof data.info.output !== "undefined"
    ) {
      let _state_str = data.info.output ? "ON" : "OFF";
      MQTT.publish(
        buildMQTTStateCmdTopics("binary_sensor", "state"),
        _state_str
      );
    }

    // FIX6: debounce temperature_change events to avoid RPC flooding
    if (data.info.event === "temperature_change") {
      if (data.info.id === CONFIG.shelly_id_temp_ext) {
        STATUS.temp_ext = data.info.tC;
        print("changement de la temperature exterieur");
      }
      if (data.info.id === CONFIG.shelly_id_temp_pool) {
        STATUS.current_temp = data.info.tC;
        print("changement de la temperature piscine");
      }

      // Debounce: wait 3s of silence before processing
      if (DEBOUNCE_TEMP !== null) Timer.clear(DEBOUNCE_TEMP);
      DEBOUNCE_TEMP = Timer.set(3000, false, function () {
        DEBOUNCE_TEMP = null;
        update_temp(false, false);
        publishState();
      });
    }

    // Lock on manual toggle
    if (data.info.event === "toggle") {
      let result = Shelly.getComponentStatus("switch", 0);
      print("[POOL_] TOGGLE EVENT SWITCH:", result.output);

      let _state_str = result.output ? "ON" : "OFF";
      MQTT.publish(
        buildMQTTStateCmdTopics("binary_sensor", "state"),
        _state_str
      );

      STATUS.tick_lock++;
      if (STATUS.disable_temp !== null) Timer.clear(STATUS.disable_temp);

      STATUS.disable_temp = Timer.set(600 * 1000, false, function () {
        print("[POOL] re-enable temp");
        STATUS.disable_temp = null;
      });
    }
  });
}

/**
 * Main — delayed start to avoid boot-time crash
 */
Timer.set(10000, false, function () {
  print("[POOL] start");

  // FIX8: update_next_noon at boot, then refresh every hour
  update_next_noon();
  Timer.set(3600000, true, update_next_noon);

  // FIX1: use rpc_enqueue for GetDeviceInfo
  rpc_enqueue("Shelly.GetDeviceInfo", {}, function (result) {
    CONFIG.shelly_id = result.id;
    CONFIG.shelly_mac = result.mac;
    CONFIG.shelly_fw_id = result.fw_id;
    CONFIG.device_name = result.name || CONFIG.device_name;
    CONFIG.ha_dev_type.name = CONFIG.device_name;
    CONFIG.ha_dev_type.ids[0] = CONFIG.shelly_id;
    CONFIG.ha_dev_type.sw = CONFIG.shelly_fw_id;
    initMQTT();
  });

  // FIX7: parse KVS result as float with fallback
  rpc_enqueue(
    "KVS.Get",
    { key: "pool_temp_max" },
    function (result, error_code) {
      if (error_code !== 0) {
        print("[KVS] no pool_temp_max found, error_code:", error_code);
      } else {
        let val = parseFloat(result.value);
        STATUS.temp_max = isNaN(val) ? 0 : val;
        print("[KVS] pool_temp_max restored:", STATUS.temp_max);
      }
    }
  );

  // Periodic publish
  if (CONFIG.update_period > 0)
    Timer.set(CONFIG.update_period, true, publishState);

  // Subscribe to events
  subscribe_to_events();

  // Check for new day every 10 minutes
  Timer.set(600000, true, update_new_day);
}, null);