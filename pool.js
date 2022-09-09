/**
 * garcia.sylvain@gmail.com
 * https://github.com/sylvaing/shelly-pool-pump
 * 
 * This script is intended to  manage your pool pump from a Shelly Plus device.
 * He is compatible from firmware 0.11
 * 
 * Based on shelly script of ggilles with lot of new feature and improvment.
 * https://www.shelly-support.eu/forum/index.php?thread/14810-script-randomly-killed-on-shelly-plus-1pm/
 * 
 * Calculate duration filter from current temperature of water, and use max temp of the day and yesterday. The script use sun noon
 * to calculate the start of script and the end. the morning and the afternoon are separate by sun noon, and duration are equal.
 * manage freeze mode : under 2°C pump will be activate to prevent freeze of water.
 * 
 * Publish informations on MQTT for Home Assistant autodiscover, all sensors and switch are autocreate in your home assitant.
 * Before use the script you must configure correcly your Shelly device to connect a your MQTT broker trought web interface or shelly app.
 * 
 * Today, there are no native external sensor, so you must publish temp of water and external temperature on one MQTT topic "ha/pool/...". you have
 * configuration package 'pool_pum.yaml' to do this, replace and addapt tou your sensor and configuration.
 * 
 * You must also publish th next_noon on the same topic, to calulate the middle of duration filtration
 * 
 * You have au slider to configure the factor of duration filtration, if you want adapt this, by default its 1, put you can choose what you want.
 *
 */


print("[POOL] start");

let STATUS = {
  temp: null,
  current_temp: null,
  temp_ext:null,
  temp_max: null,
  temp_today: null,
  temp_yesterday: 0,
  next_noon: 12,
  freeze_mode: false,
  coeff: 1.2,
  sel_mode: "Force off",

  update_time: null,
  update_time_last: 0,
  update_temp_max_last: null,
  current_time: null,

  disable_temp: null,
  lock_update: false,
  make_unlock: false,

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
  update_period: 60000,
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
 * * @param {boolean} nolock
 */
function switchActivate(sw_state, nolock) {
  print("[POOL_CALL] switch set _ switchActivate");
  Shelly.call("Switch.Set", {
    id: 0,
    on: sw_state,
  });
  
  if ( nolock !== true ){
    STATUS.tick_lock++;
    print("[POOL] disable temp", STATUS.tick_lock);

    if (STATUS.disable_temp !== null)
      Timer.clear(STATUS.disable_temp);

    print("[POOL_DISABLE_TEMP] switchActivate() disable temp", STATUS.tick_lock);

    STATUS.disable_temp = Timer.set(
      6 * 100,
      //600 * 1000,
      false,
      function () {
        print("[POOL] re-enable temp");
        STATUS.disable_temp = null;
      }
    );
  }
}

/**
 * Listen to ~/cmd topic for switch conrol
 * @param {string} topic
 * @param {string} message
 */
// function MQTTCmdListener(topic, message) {
//   let _sw_state = message === "on" ? true : false;
//   switchActivate(_sw_state);
// }

/**
 * Listen to ~/cmd topic for number control Coefficient filtrage
 * @param {string} topic
 * @param {string} message
 */
 function MQTTCmdListenerNumber(topic, message) {
  if (STATUS.lock_update === false){
  print("[POOL] - MQTT listenerNumber() lock_update =  false");


  print("[MQTT] listen Number", message);
  let obj = JSON.parse(message);
 // print("[MQTT-LISTEN] listen Number - STATUS.coeff", obj);
  // if (obj !== STATUS.coeff){
    STATUS.coeff = obj;
    MQTT.publish(buildMQTTStateCmdTopics("number", "state"), JSON.stringify(STATUS.coeff));
    //print("[MQTT] listen Number - STATUS.coeff", STATUS.coeff);
    // let _obj = {
    //   coeff_filt : STATUS.coeff,
    //   next_noon : STATUS.next_noon,
    //   temperature : STATUS.temp,
    //   temperature_ext : STATUS.temp_ext,
    // };
      update_temp(true,false);
    }else{
      print("[POOL] - MQTT listener lock_update =  true");
    }
    // a tester..
    publishState();
  // }
}

/**
 * Listen to ~/cmd topic for select mode control
 * @param {string} topic
 * @param {string} message
 */
function MQTTCmdListenerSelect(topic, message) {

  print("[MQTT] listen SELECT", message);
  STATUS.sel_mode = message;
  if (message === "Auto"){
    print("[MQTT-SELECT] AUTO", message);
    // fonctionnement Automatique normal
    // appel du calcul de la pompe
    update_temp(false,true);
  }else if (message === "Force on"){
    print("[MQTT-SELECT] FORCE ON", message);
    // start pump & delete schedule
    let calls = [];
    calls.push({method: "Schedule.DeleteAll", params: null});
    do_call(calls);

    switchActivate(true,true);

  }else if (message === "Force off"){
    print("[MQTT-SELECT] FORCE OFF", message);
    // stop pump & delete schedule
    let calls = [];
    calls.push({method: "Schedule.DeleteAll", params: null});
    do_call(calls);

    switchActivate(false,true);
  }
  

}


/**
 * Publish update on switch change on binary sensor
 */
Shelly.addEventHandler(function (ev_data) {
  if (
    ev_data.component === "switch:0" &&
    typeof ev_data.info.output !== "undefined"
  ) {
    let _state_str = ev_data.info.output ? "ON" : "OFF";
    MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);

  }
});

function publishState() {
  //update_newday
  //get_current_time();


  // use getComponentStatus (sync call) instead of call of "Sys.GetStatus" ( async call)
  let result = Shelly.getComponentStatus("switch",0); 
  print("[POOL_] GETCOMPONENT-STATUS SWITCH :", result.output);


  //Shelly.call("Switch.GetStatus", { id: 0 }, function (result) {
    let _sensor = {
      duration: 0,
      start: 0,
      stop: 0,
      mode: "null",
      temp_max : 0,
      temp_max_yesterday: 0,
    };
    _sensor.duration = STATUS.duration;
    _sensor.start = STATUS.start;
    _sensor.stop = STATUS.stop;
    _sensor.temp_max = STATUS.temp_max
    _sensor.temp_max_yesterday = STATUS.temp_yesterday
    if (STATUS.freeze_mode === true){
      _sensor.mode = 'freeze';
    }else{
      _sensor.mode = 'summer';
    }
    _sensor.state = result.output;
    MQTT.publish(
      buildMQTTStateCmdTopics("sensor", "state"),
      JSON.stringify(_sensor)
    );
    let _state_str = _sensor.state ? "ON" : "OFF";
    MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);

    MQTT.publish(buildMQTTStateCmdTopics("number", "state"),JSON.stringify(STATUS.coeff));

    if (STATUS.make_unlock){
      STATUS.lock_update = false;
      STATUS.make_unlock = false;
      print("[POOL] - Publish state lock_update => false");
    }else{
      print("[POOL] - Publishstate() make_unlock =  true , lock_update = ", STATUS.lock_update );
    }

  //});
}

/**
 * Activate periodic updates
 */
if(CONFIG.update_period > 0) Timer.set(CONFIG.update_period, true, publishState);
//========>>


/**
 * Initialize listeners and configure switch and sensors entries
 */
function initMQTT() {
//   MQTT.subscribe(buildMQTTStateCmdTopics("switch", "cmd"), MQTTCmdListener);
//   /**
//    * Configure the switch
//    */
//   MQTT.publish(
//     buildMQTTConfigTopic("switch", "switch"),
//     JSON.stringify({
//       dev: CONFIG.ha_dev_type,
//       "~": buildMQTTStateCmdTopics("switch"),
//       cmd_t: "~/cmd",
//       stat_t: "~/state",
//       icon: "mdi:pump",
//       pl_on: CONFIG.payloads.on,
//       pl_off: CONFIG.payloads.off,
//       name: "pool pump",
//       uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_SW",
//     }),
//     0,
//     true
//   );

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

  MQTT.subscribe(buildMQTTStateCmdTopics("select", "cmd"), MQTTCmdListenerSelect);
  /**
   * Configure the select Mode
   */
  let options = [
    "Auto",
    "Force on",
    "Force off",
  ];
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
  /**
   * Configure binary_sensor of switch
   */
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



  /**
   * Configure  sensors
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

  //temperature max between today and yesterday use for calculate duration
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
    //temperature max yesterday
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
        uniq_id: CONFIG.shelly_mac + ":" + CONFIG.device_name + "_temp_max_yesterday",
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

  print("[POOL_ABACUS]  STATUS.coeff = ", STATUS.coeff);

  let a = 0.00335 * STATUS.coeff;
  let b = -0.14953 * STATUS.coeff;
  let c = 2.43489 * STATUS.coeff;
  let d = -10.72859 * STATUS.coeff;

  return (  (a * Math.pow(new_t,3)) + ( b * Math.pow(new_t,2)) + ( c * new_t ) + d );

}

// calcul de l'heure pivot pour répartir la programmation de la pompe
// en fonction du zenith du soleil

function update_next_noon(d){
  // il faut aller chercher la valeur de HA sun.sun next_noon et ensuite la convertir
  //print("[POOL_NEXT_NOON] date pivot", d);
  let new_d = JSON.parse(d.slice(0,2)) + JSON.parse(d.slice(3,5)) / 60;
  STATUS.next_noon = new_d;
  //print("[POOL_NEXT_NOON] new_date pivot", new_d);
}

// compute the pump schedule for a given duration
// returns an array of start/stop times in float
// [ start1, stop1, start2, stop2, ... ]
function compute_schedule_filt_pivot(d) {
  let s = null;
  let matin = Math.round(d)/2;
  let aprem = d - matin;
  s = [ STATUS.next_noon - matin, STATUS.next_noon + aprem ];

  STATUS.start = JSON.stringify(s[0]);
  STATUS.stop = JSON.stringify(s[1]);

  return s;
}


// convert a time to a crontab-like timespec
function time_to_timespec(t) {
  let h = Math.floor(t);
  let m = Math.floor((t-h)*60);
  let ts = "0 " + JSON.stringify(m) + " " + JSON.stringify(h) + " * * SUN,MON,TUE,WED,THU,FRI,SAT";
  return ts;
}

//new day, update status
function update_new_day() {
  
  let t = get_current_time();
  
  print("[POOL_CURRENT_TIME] update_new_day debug IF - current_time:", t, " <= update_time:", STATUS.update_time);
  if (t <= STATUS.update_time){
  STATUS.tick_day++;
  print("[POOL_NEW_DAY] update_new_day is OK", STATUS.tick_day);
  //STATUS.temp_yesterday = STATUS.temp_max;
  STATUS.temp_yesterday = STATUS.temp_today;
  STATUS.temp_today = null;
  STATUS.update_time = t
  }

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
  STATUS.tick_pump++;
  print("[POOL] update_pump", STATUS.tick_pump, "- temp:", temp, "max:", max, "time:", time);

  let duration_abacus = compute_duration_filt_abacus(max);
  let schedule = compute_schedule_filt_pivot(duration_abacus);

  print("[POOL] update_pump - duration abacus:", duration_abacus);
  print("[POOL] update_pump - schedule:", JSON.stringify(schedule));

  
  
  STATUS.duration = duration_abacus;
  STATUS.schedule = schedule;
  let calls = [];

  print("[POOL_MODE] sel_mode: ", STATUS.sel_mode);
  if (STATUS.sel_mode === "Auto") {
    calls.push({method: "Schedule.DeleteAll", params: null});

    print("[POOL] update_pump - after schedule:" );

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

    // // compute the current switch state according to the schedule
    // on = false;
    // let j = false;
    // for (let i = 0; i < schedule.length; i++) {
    //   j = !j;
    //   print("[POOL SWITCH] time:", time ,"schedule[i]");
    //   if (time >= schedule[i])
        
    //     on = j;
    // }
    // print("[POOL SWITCH] time:", time ,"");

    // calls.push({method: "Switch.Set", params: {id: 0, on: on}});
  
    compute_switch_from_schedule();

    do_call(calls);
  }
}

// TODO : fix time & schedule whici seems empty;
function compute_switch_from_schedule(){

  if (STATUS.sel_mode === "Auto"){
    // compute the current switch state according to the schedule
    //STATUS.schedule = schedule;
    //STATUS.update_time = time;
    on = false;
    let j = false;
    for (let i = 0; i < schedule.length; i++) {
      j = !j;
      print("[POOL SWITCH] time:", time ,"schedule[i]");
      if (time >= schedule[i])
        on = j;
    }
    print("[POOL SWITCH] time:", time ,"");

    calls.push({method: "Switch.Set", params: {id: 0, on: on}});
    do_call(calls);
    let _state_str = on ? "ON" : "OFF";
    MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);
  }
}

function update_pump_hivernage(){

  let calls = [];
  //on efface le scheduler
  calls.push({method: "Schedule.DeleteAll", params: null});
  //on force la pompe a on
  calls.push({method: "Switch.Set", params: {id: 0, on: true}});

  do_call(calls);
  
}


/**
 * Update temperature from Sensor
 * - update max temp
 * - retrieve current time
 * - switch to new day
 * - do a pump update if the last one didn't happen too close and if max temp has changed
 * @param {boolean} fromUpdateCoeff
 * @param {boolean} nodisable
 */
function update_temp(fromUpdateCoeff, nodisable) {
  STATUS.tick_temp++;

  print("[POOL] update_temp", STATUS.tick_temp, STATUS.current_temp);

  print("[POOL_DISABLE_TEMP] disable_temp", STATUS.disable_temp, nodisable);
  if ((STATUS.disable_temp !== null) && ( nodisable !== true)) {
    print("[POOL] update disabled");
    return;
  }

  if (STATUS.lock_update) {
    print("[POOL] update_temp locked");
    return;
  }
  print("[POOL] update_temp() lock_update =>  true");
  STATUS.lock_update = true;

  STATUS.temp = Math.round(STATUS.current_temp * 10) / 10;
  STATUS.temp_today = Math.max(STATUS.temp_today, STATUS.temp);
  STATUS.temp_max   = Math.max(STATUS.temp_today, STATUS.temp_yesterday);

  print("[POOL] update_temp - max today:", STATUS.temp_max, "today:", STATUS.temp_today, "yesterday:", STATUS.temp_yesterday);
  print("[POOL] update_temp - update_temp_max:", STATUS.temp_max, "update_temp_max_last:", STATUS.update_temp_max_last, "temp_ext:", STATUS.temp_ext);

  STATUS.current_time = get_current_time();
  
  if ((STATUS.temp_max !== STATUS.update_temp_max_last) ||
      (STATUS.temp_ext < 2 ) ||
      (STATUS.freeze_mode === true) ||
      (fromUpdateCoeff === true)  ||
      (nodisable === true) ) {

        update_temp_call();

  }else if( (STATUS.sel_mode === "Force on") || (STATUS.sel_mode === "Force off")){
    return;
  }else {
    print("[POOL] no temp change, skip update_pump, lock_update =  false");
    STATUS.lock_update = false;
  }
}

function get_current_time(){
  // print("[POOL_CALL] get_status current time");

  // use getComponentStatus (sync call) instead of call of "Sys.GetStatus" ( async call)
  let result = Shelly.getComponentStatus("sys"); 
  print("[POOL_] get_current_time() time:", result.time);
  
  let time = result.time; // "HH:MM"

  // compute current time in float format (12h45 -> 12.75)
  let t = JSON.parse(time.slice(0,2)) + JSON.parse(time.slice(3,5)) / 60;

  //print("[POOL_CURRENT_TIME] current_time:", t);
  //print("[POOL_CURRENT_TIME] update_new_day debug IF - current_time:", t, " <= update_time:", STATUS.update_time);
  // if (t <= STATUS.update_time){
  //   // update_new_day();
  //   STATUS.tick_day++;
  //   print("[POOL_NEW_DAY] update_new_day is OK", STATUS.tick_day);
  //   //STATUS.temp_yesterday = STATUS.temp_max;
  //   STATUS.temp_yesterday = STATUS.temp_today;
  //   STATUS.temp_today = null;
  //   STATUS.update_time = t
  // }

  //STATUS.current_time = t;

  return t;
}


function update_temp_call(){

  STATUS.update_time = STATUS.current_time;
  print("[POOL TIME] ", STATUS.update_time);
  // freeze_mode
  if (STATUS.temp_ext < 2){
    print("[POOL] Mode hivernage - temp : ", STATUS.temp_ext);
    STATUS.freeze_mode = true;
    update_pump_hivernage();
    // too much RPC (limit to 5)
    // the update_temp is locked and unlock only on publishstate.
    // add make_unlock, to tel publishState to unlock on his call RPC
    //  -> I can't pass arg to function to reuse it into rpc call of publishState
    STATUS.make_unlock = true;
    publishState()
  }
  else{
    STATUS.freeze_mode = false;
    // faire ici peut-être un off de la pompe.. qui sort du freeze mode
    if (STATUS.temp_max !== null) {
      // if ((t - STATUS.update_time_last) > 0.15) { // 9 minutes
        update_pump(STATUS.temp, STATUS.temp_max, STATUS.update_time);
        STATUS.update_time_last = STATUS.update_time;
        STATUS.update_temp_max_last = STATUS.temp_max;
      // }
      // else {
      //   STATUS.tick_pump_skip++;
      //   print("[POOL] to much update_pump, skipped", STATUS.tick_pump_skip);
      // }
    }
  }

  // too much RPC (limit to 5)
  // the update_temp is locked and unlock only on publishstate.
  // add make_unlock, to tel publishState to unlock on his call RPC
  //  -> I can't pass arg to function to reuse it into rpc call of publishState
    STATUS.make_unlock = true;
    publishState()


}

// receives update from Pool Sensor
// - trigger all temperature and pump updates
MQTT.subscribe(
  "ha/pool",
  function (topic, msg) {
    STATUS.tick_mqtt++;
    print("[POOL] mqtt", topic);
    let obj = JSON.parse(msg);
    if ((obj.next_noon === undefined) || (obj.temperature === undefined) || (obj.temperature_ext === undefined) )  {
      return;
    }
    update_next_noon(obj.next_noon);
    STATUS.current_temp = obj.temperature;
    STATUS.temp_ext = obj.temperature_ext;
    update_temp(false,false);
  }
)

// after a Switch Event, disable temp update
// during 10 minutes (600 * 10000)

// Shelly.addEventHandler(
//   function (data) {
//     if ((data.info.event === "toggle") && ( STATUS.sel_update !== true )){
//       STATUS.tick_lock++;
//       print("[POOL] disable temp", STATUS.tick_lock);

//       if (STATUS.disable_temp !== null)
//         Timer.clear(STATUS.disable_temp);

//       STATUS.disable_temp = Timer.set(
//         6 * 100,
//         //600 * 1000,
//         false,
//         function () {
//           print("[POOL] re-enable temp");
//           STATUS.disable_temp = null;
//         }
//       );
//       STATUS.sel_update = false;
//     }
//   }
// );

Shelly.addEventHandler(
  function (data) {
    if (data.info.event === "toggle"){

      let result = Shelly.getComponentStatus("switch",0); 
      print("[POOL_] GETCOMPONENT-STATUS SWITCH :", result.output);

      let _state_str = result.output ? "ON" : "OFF";
      MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);


    }
  }
);


// Debug...


/**
 * Activate periodic check for new day
 */
 Timer.set(300000, true, update_new_day);


// Timer.set(
//   60 * 1000,
//   true,
//   function() {
//     STATUS.tick++;
//     Shelly.call (
//       "Sys.GetStatus",
//       {},
//       function (result) {
//         //print("[POOL] DEBUG time : ", result.time, ", update_time : " STATUS.update_time, " , uptime : ", result.uptime);
//         print("[POOL] DEBUG temp - update_temp_max:", STATUS.temp_max, "update_temp_max_last:", STATUS.update_temp_max_last,"temp_yesterday:", STATUS.temp_yesterday, "temp_ext:", STATUS.temp_ext);
//         //print("[POOL] DEBUG temp - temp_yesterday:", STATUS.temp_yesterday, "temp_ext:", STATUS.temp_ext);

//         STATUS.time = result.time;
//         STATUS.uptime = result.uptime;
//       }
//     );
//   }
// );

