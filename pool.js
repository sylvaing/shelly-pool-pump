print("[POOL] start");

let status = {
  temp: null,
  current_temp: null,
  temp_ext:null,
  temp_max: null,
  temp_today: null,
  temp_yesterday: null,
  next_noon: 12,
  freeze_mode: false,
  coeff: 1.2,


  update_time: null,
  update_time_last: 0,
  update_temp_max_last: null,

  disable_temp: null,
  lock_update: false,

  duration: null,
  schedule: null,
  start: null,
  stop: null,

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

////////////
//MQTT


/**
 * @typedef {"switch" | "binary_sensor" | "sensor"} HADeviceType
 * @typedef {"config"|"stat"|"cmd"} HATopicType
 */

 let CONFIG = {
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
  update_period: 2500,
};

Shelly.call("Shelly.GetDeviceInfo", {}, function (result) {
  CONFIG.shelly_id = result.id;
  CONFIG.shelly_mac = result.mac;
  CONFIG.shelly_fw_id = result.fw_id;
  CONFIG.device_name = result.name || CONFIG.device_name;
  CONFIG.ha_dev_type.name = CONFIG.device_name;
  CONFIG.ha_dev_type.ids[0] = CONFIG.shelly_id;
  CONFIG.ha_dev_type.sw = CONFIG.shelly_fw_id;
  initMQTT();
});

/**
 * Construct config topic
 * @param   {HADeviceType}  hatype HA device type
 * @param   {string}        object_id
 * @returns {string}        topic - ha_mqtt_auto_discovery_prefix/device_type/device_id/config
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
 * @param   {HADeviceType}   hatype HA device type
 * @param   {HATopicType}    topic HA topic
 * @returns {string}         topic string
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
 */
function switchActivate(sw_state) {
  Shelly.call("Switch.Set", {
    id: 0,
    on: sw_state,
  });
}

/**
 * Listen to ~/cmd topic for switch conrol
 * @param {string} topic
 * @param {string} message
 */
function MQTTCmdListener(topic, message) {
  let _sw_state = message === "on" ? true : false;
  switchActivate(_sw_state);
}

/**
 * Listen to ~/cmd topic for number control Coefficient filtrage
 * @param {string} topic
 * @param {string} message
 */
 function MQTTCmdListenerNumber(topic, message) {
  print("[MQTT] listen Number", message);
  let obj = JSON.parse(message);
  print("[MQTT-LISTEN] listen Number - status.coeff", obj);
  // if (obj !== status.coeff){
    status.coeff = obj;
    MQTT.publish(buildMQTTStateCmdTopics("number", "state"), JSON.stringify(status.coeff));
    print("[MQTT] listen Number - status.coeff", status.coeff);
    // let _obj = {
    //   coeff_filt : status.coeff,
    //   next_noon : status.next_noon,
    //   temperature : status.temp,
    //   temperature_ext : status.temp_ext,
    // };
    update_temp(true);
  // }
}

/**
 * Publish update on switch change
 */
Shelly.addEventHandler(function (ev_data) {
  if (
    ev_data.component === "switch:0" &&
    typeof ev_data.info.output !== "undefined"
  ) {
    let _state_str = ev_data.info.output ? "on" : "off";
    MQTT.publish(buildMQTTStateCmdTopics("switch", "state"), _state_str);
  }
});

function publishState() {
  Shelly.call("Switch.GetStatus", { id: 0 }, function (result) {
    let _sensor = {
      duration: 0,
      start: 0,
      stop: 0,
      mode: "null",
    };
    _sensor.duration = status.duration;
    _sensor.start = status.start;
    _sensor.stop = status.stop;
    if (status.freeze_mode === true){
      _sensor.mode = 'freeze';
    }else{
      _sensor.mode = 'summer';
    }
    _sensor.state = result.output;
    MQTT.publish(
      buildMQTTStateCmdTopics("sensor", "state"),
      JSON.stringify(_sensor)
    );
    let _state_str = _sensor.state ? "on" : "off";
    MQTT.publish(buildMQTTStateCmdTopics("switch", "state"), _state_str);

    MQTT.publish(buildMQTTStateCmdTopics("number", "state"),JSON.stringify(status.coeff));
  });
}

/**
 * Activate periodic updates
 */
if(CONFIG.update_period > 0) Timer.set(CONFIG.update_period, true, publishState);

/**
 * Initialize listeners and configure switch and sensors entries
 */
function initMQTT() {
  MQTT.subscribe(buildMQTTStateCmdTopics("switch", "cmd"), MQTTCmdListener);
  /**
   * Configure the switch
   */
  MQTT.publish(
    buildMQTTConfigTopic("switch", "switch"),
    JSON.stringify({
      dev: CONFIG.ha_dev_type,
      "~": buildMQTTStateCmdTopics("switch"),
      cmd_t: "~/cmd",
      stat_t: "~/state",
      icon: "mdi:pump",
      pl_on: CONFIG.payloads.on,
      pl_off: CONFIG.payloads.off,
      name: "pool pump",
      uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_SW",
    }),
    0,
    true
  );

  MQTT.subscribe(buildMQTTStateCmdTopics("number", "cmd"), MQTTCmdListenerNumber);
  /**
   * Configure the number coeff
   */
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


  /**
   * Configure temperature, current and voltage sensors
   */
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
}




/////////

// compute duration of filtration for a given max temperature
// duration is returned in float format (1.25 -> 1h 15mn)

function compute_duration_filt(t) {
  if (t < 5)
    return 1;
  if (t < 10)
    return (t/5);           // 1 -> 2
  if (t < 12)
    return (t-8);           // 2 -> 4
  if (t < 16)
    return (t/2-2);         // 4 -> 6
  if (t < 24)
    return (t/4+2);         // 6 -> 8
  if (t < 27)
    return (t*4/3-24)       // 8 -> 12
  if (t < 30)
    return (t*4 - 96);      // 12 -> 24
  return 24;
}


// Calcul suivant l'équation
// y = (0.00335 * temperature^3) + (-0.14953 * temperature^2) + (2.43489 * temperature) -10.72859
// https://github.com/scadinot/pool/blob/master/core/class/pool.class.php

function compute_duration_filt_abacus(t){
  
  
  // Pour assurer un temps minimum de filtration la temperature de calcul est forcée a 10°C
  let new_t = null;
  new_t = Math.max(t, 10);

  //coefficient multiplicateur pour ajuster le temps de filtration
  //let coeff = 1;

  print("[ABACUS]  status.coeff = ", status.coeff);

  let a = 0.00335 * status.coeff;
  let b = -0.14953 * status.coeff;
  let c = 2.43489 * status.coeff;
  let d = -10.72859 * status.coeff;

  return (  (a * Math.pow(new_t,3)) + ( b * Math.pow(new_t,2)) + ( c * new_t ) + d );

}

// calcul de l'heure pivot pour répartir la programmation de la pompe
// en fonction du zenith du soleil

function update_next_noon(d){
  // il faut aller chercher la valeur de sHA sun.sun next_noon et ensuite la convertir
  print("[POOL] date pivot", d);
  let new_d = JSON.parse(d.slice(0,2)) + JSON.parse(d.slice(3,5)) / 60;
  status.next_noon = new_d;
  print("[POOL] new_date pivot", new_d);
}

// compute the pump schedule for a given duration
// returns an array of start/stop times in float
// [ start1, stop1, start2, stop2, ... ]
function compute_schedule_filt_pivot(d) {
  let s = null;
  let matin = Math.round(d)/2;
  let aprem = d - matin;
  s = [ status.next_noon - matin, status.next_noon + aprem ];

  status.start = JSON.stringify(s[0]);
  status.stop = JSON.stringify(s[1]);

  return s;
}


// convert a time to a crontab-like timespec
function time_to_timespec(t) {
  let h = Math.floor(t);
  let m = Math.floor((t-h)*60);
  let ts = "0 " + JSON.stringify(m) + " " + JSON.stringify(h) + " * * SUN,MON,TUE,WED,THU,FRI,SAT";
  return ts;
}

// new day, update status
function update_new_day() {
  status.tick_day++;
  print("[POOL] update_new_day", status.tick_day);
  status.temp_yesterday = status.temp_today;
  status.temp_today = null;
}

// call a chain of API calls
function do_call(calls) {
  if (calls.length === 0) {
    print("[POOL] call: done.");
    return;
  }

  let m = calls[0].method;
  let p = calls[0].params;
  calls.splice(0, 1);

  print("[POOL] call:", m, JSON.stringify(p));

  Shelly.call(
    m,
    p,
    function (r, errc, errm, _calls) {
      do_call(_calls);
    },
    calls
  );
}

// compute & configure pump schedule

function update_pump(temp, max, time) {
  status.tick_pump++;
  print("[POOL] update_pump", status.tick_pump, "- temp:", temp, "max:", max, "time:", time);

  let duration_abacus = compute_duration_filt_abacus(max);
  let schedule = compute_schedule_filt_pivot(duration_abacus);

  print("[POOL] update_pump - duration abacus:", duration_abacus);
  print("[POOL] update_pump - schedule:", JSON.stringify(schedule));

  
  
  status.duration = duration_abacus;
  status.schedule = schedule;
  let calls = [];

  calls.push({method: "Schedule.DeleteAll", params: null});

  let on = true;
  for (let i = 0; i < schedule.length; i++) {
    let ts = time_to_timespec(schedule[i]);
    let p = {
      id: i+1,
      enable: true,
      timespec: ts,
      calls: [{
        method: "Switch.Set",
        params: { id: 0, on: on }
      }]
    };
    calls.push({method: "Schedule.Create", params: p});
    on = !on;
  }

  // compute the current switch state according to the schedule
  on = false;
  let j = false;
  for (let i = 0; i < schedule.length; i++) {
    j = !j;
    if (time >= schedule[i])
      on = j;
  }

  calls.push({method: "Switch.Set", params: {id: 0, on: on}});

  do_call(calls);
}

function update_pump_hivernage(){

  let calls = [];
  //on efface le scheduler
  calls.push({method: "Schedule.DeleteAll", params: null});
  //on force la pompe a on
  calls.push({method: "Switch.Set", params: {id: 0, on: true}});

  do_call(calls);
  
}

// update temperature from Sensor
// - update max temp
// - retrieve current time
// - switch to new day
// - do a pump update if the last one didn't happen too close and if max temp has changed

function update_temp(fromUpdateCoeff) {
  status.tick_temp++;

  print("[POOL] update_temp", status.tick_temp, status.current_temp);

  if (status.disable_temp !== null) {
    print("[POOL] update disabled");
    return;
  }

  if (status.lock_update) {
    print("[POOL] update_temp locked");
    return;
  }
  status.lock_update = true;

  status.temp = Math.round(status.current_temp * 10) / 10;
  status.temp_today = Math.max(status.temp_today, status.temp);
  status.temp_max   = Math.max(status.temp_today, status.temp_yesterday);

  print("[POOL] update_temp - max:", status.temp_max, "today:", status.temp_today, "yesterday:", status.temp_yesterday);
  print("[POOL] update_temp - update_temp_max:", status.temp_max, "update_temp_max_last:", status.update_temp_max_last, "temp_ext:", status.temp_ext);

  
  if ((status.temp_max !== status.update_temp_max_last) ||
      (status.temp_ext < 2 ) ||
      (status.freeze_mode === true) ||
      (fromUpdateCoeff === true) )   {
        update_temp_call();
  }
  else {
    print("[POOL] no temp change, skip update_pump");
  }
  status.lock_update = false;
}

function update_temp_call(){
  Shelly.call (
    "Sys.GetStatus",
    {},
    function (result) {
      let time = result.time; // "HH:MM"
      print("[POOL] time", time);

      // compute current time in float format (12h45 -> 12.75)
      let t = JSON.parse(time.slice(0,2)) + JSON.parse(time.slice(3,5)) / 60;

      print("[POOL] update_new_day debug IF - t:", t, " < update_time:", status.update_time);
      if (t < status.update_time)
        update_new_day();
      
      status.update_time = t;

      // freeze_mode
      if (status.temp_ext < 2){
        print("[POOL] Mode hivernage - temp : ", status.temp_ext);
        status.freeze_mode = true;
        update_pump_hivernage();
        publishState()
      }
      else{
        status.freeze_mode = false;
        // faire ici peut-être un off de la pompe.. qui sort du freeze mode
        if (status.temp_max !== null) {
         // if ((t - status.update_time_last) > 0.15) { // 9 minutes
            update_pump(status.temp, status.temp_max, t);
            status.update_time_last = t;
            status.update_temp_max_last = status.temp_max;
         // }
         // else {
         //   status.tick_pump_skip++;
         //   print("[POOL] to much update_pump, skipped", status.tick_pump_skip);
         // }
        }
      } 
      //publish_mqtt_info()
      publishState()
    }
  );
}

// receives update from Pool Sensor
// - trigger all temperature and pump updates
MQTT.subscribe(
  "ha/pool",
  function (topic, msg) {
    status.tick_mqtt++;
    print("[POOL] mqtt", topic);
    let obj = JSON.parse(msg);
    if ((obj.next_noon === undefined) || (obj.temperature === undefined) || (obj.temperature_ext === undefined) )  {
      return;
    }
    update_next_noon(obj.next_noon);
    status.current_temp = obj.temperature;
    status.temp_ext = obj.temperature_ext;
    update_temp();
  }
)

// after a Switch Event, disable temp update
// during 10 minutes (600 * 10000)

Shelly.addEventHandler(
  function (data) {
    if (data.info.event === "toggle") {
      status.tick_lock++;
      print("[POOL] disable temp", status.tick_lock);

      if (status.disable_temp !== null)
        Timer.clear(status.disable_temp);

      status.disable_temp = Timer.set(
        60 * 100,
        //60 * 1000,
        false,
        function () {
          print("[POOL] re-enable temp");
          status.disable_temp = null;
        }
      );
    }
  }
);

// Debug...

Timer.set(
  60 * 1000,
  true,
  function() {
    status.tick++;
    Shelly.call (
      "Sys.GetStatus",
      {},
      function (result) {
        print("[POOL] DEBUG time : ", result.time, ", update_time : "status.update_time, " , uptime : ", result.uptime);
        print("[POOL] DEBUG - update_temp_max:", status.temp_max, "update_temp_max_last:", status.update_temp_max_last, "temp_ext:", status.temp_ext);

        status.time = result.time;
        status.uptime = result.uptime;
      }
    );
  }
);

