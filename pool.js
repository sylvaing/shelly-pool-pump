/**
 * garcia.sylvain@gmail.com
 * https://github.com/sylvaing/shelly-pool-pump
 * 
 * This script is intended to  manage your pool pump from a Shelly Plus device.
 * He is compatible from firmware 1.0.8.
 * 
 * Based on shelly script of ggilles with lot of new feature and improvment.
 * https://www.shelly-support.eu/forum/index.php?thread/14810-script-randomly-killed-on-shelly-plus-1pm/
 * 
 * Calculate duration filter from current temperature of water, and use max temp of the day and yesterday. The script use sun noon
 * to calculate the start of script and the end. the morning and the afternoon are separate by sun noon, and duration are equal.
 * manage freeze mode : under 0.5°C (CONFIG.freeze_temp) pump will be activate to prevent freeze of water.
 * 
 * Publish informations on MQTT for Home Assistant autodiscover, all sensors and switch are autocreate in your home assitant.
 * Before use the script you must configure correcly your Shelly device to connect a your MQTT broker trought web interface or shelly app.
 * You must also use shelly external addon and two DS18b20, one for the water, an other one for air temp.
 * So you must configure shelly_id_temp_ext and shelly_id_temp_pool in this script according of your id in shelly addon configuration.
 * 
 * The next noon is fix at 2h00pm (STATUS.next_noon) by default.
 * the script request your home hassitant inorder to find your next_noon. If error to request the next noon on your Home Assisstant the value is 2h00pm
 * You must generate token on your Home Assitant installation, and replace value CONFIG.ha_token and also IP of your HA installation
 * 
 * You have au slider to configure the factor of duration filtration, if you want adapt this, by default its 1, but you can choose what you want.
 *
 * configuration resume
 * CONFIG.freeze_temp : prevent freeze of water under this temp
 * CONFIG.shelly_id_temp_ext: Shelly id of external temp ( see your config on shelly UI
 * CONFIG.shelly_id_temp_pool: Shelly id of water pool temp ( see your config on shelly UI
 * CONFIG.ha_ip: IP of your Home assitant
 * CONFIG.ha_token: long lived access token on your Home assistant API ( see here: https://developers.home-assistant.io/docs/auth_api/#:~:text=Long%2Dlived%20access%20tokens%20can,access%20token%20for%20current%20user. )
 * 
 */


print("[POOL] start");



/**
 * @typedef {"switch" | "binary_sensor" | "sensor"} HADeviceType
 * @typedef {"config"|"stat"|"cmd"} HATopicType
 */

 let CONFIG = {
  shelly_id_temp_ext: 100,
  shelly_id_temp_pool: 101,
  shelly_id: null,
  shelly_mac: null,
  shelly_fw_id: null,
  device_name: "POOL_PUMP_TEST",
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
  ha_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI3MDIxNmE2Yjk4YmY0YWE0OWQ2YjI2YTZmMThhMzE5NSIsImlhdCI6MTY5NjQ5NDk3MiwiZXhwIjoyMDExODU0OTcyfQ._4Jihf-RTSsHWTCU2_F-nLy5bpZrlH--2XV_xN4gbgw",
};

let STATUS = {
  temp: 0,
  current_temp: Shelly.getComponentStatus("temperature",CONFIG.shelly_id_temp_pool).tC,
  temp_ext: Shelly.getComponentStatus("temperature",CONFIG.shelly_id_temp_ext).tC,
  temp_max: 0,
  temp_today: 0,
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

// calcul de l'heure pivot pour répartir la programmation de la pompe
// en fonction du zenith du soleil

function update_next_noon(){
  // il faut aller chercher la valeur de HA sun.sun next_noon et ensuite la convertir
  //print("[POOL_NEXT_NOON] date pivot", d);
  //let new_d = JSON.parse(d.slice(0,2)) + JSON.parse(d.slice(3,5)) / 60;
  //STATUS.next_noon = new_d;
  //print("[POOL_NEXT_NOON] new_date pivot", new_d);

  let h = {
    method: "GET",
    url: "http://"+ CONFIG.ha_ip +":8123/api/states/sun.sun",
    headers : {
        Authorization: "Bearer "+ CONFIG.ha_token,
        'Content-Type': "application/json",
    },
    timeout: 4,
    
  };

  Shelly.call("HTTP.Request", h, function (result,error_code,error_message) {
  
    if (error_code == 0 ) {
      //print(result);
      //print(error_code);
      //print(error_message);
      let re = JSON.stringify(result);
      //print(re);
      let result_json = JSON.parse(result.body);
      if (result_json.hasOwnProperty("attributes")){
        if (result_json.attributes.hasOwnProperty("next_noon")){
          let next_noon = result_json.attributes.next_noon
          //print("--------------------------------");
          //print(next_noon);
          let d = new Date(next_noon);
          //print(d.toISOString());
          //print(d.getHours());
          //print(d.getMinutes());
          //print(d.getSeconds());
          let new_d = d.getHours() + d.getMinutes() /60;
          STATUS.next_noon = new_d;
          //print("POOL_nn: next_noon"+ STATUS.next_noon);
        }else {
          print("ERROR HTTP request on HA next noon: "+error_code);
          STATUS.next_noon = 14;
        }
      }else {
        print("ERROR HTTP request on HA next noon: "+error_code);
        STATUS.next_noon = 14;
      }

    }else{
      print("ERROR CODE HTTP request on HA next noon: "+error_code);
      STATUS.next_noon = 14;
    }
    
});

}

update_next_noon();

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
      600 * 1000,
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
  print("[MQTT] listen NUMBER : ", message);

  if ( message !== ""){
  if (STATUS.lock_update === false){
    print("[POOL] - MQTT listenerNumber() lock_update =  false");
    //print("[MQTT] listen Number", message);
    let obj = JSON.parse(message);

    STATUS.coeff = obj;
    MQTT.publish(buildMQTTStateCmdTopics("number", "state"), JSON.stringify(STATUS.coeff));
    update_temp(true,false);
  }
    publishState();
  }
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

// TODO= a été déplacé a la fin
/**
 * Publish update on switch change on binary sensor
 */
// Shelly.addEventHandler(function (ev_data) {
//   if (
//     ev_data.component === "switch:0" &&
//     typeof ev_data.info.output !== "undefined"
//   ) {
//     let _state_str = ev_data.info.output ? "ON" : "OFF";
//     MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);

//   }
// });

function publishState() {
  // use getComponentStatus (sync call) instead of call of "Sys.GetStatus" ( async call)
  let result = Shelly.getComponentStatus("switch",0); 
  //print("[POOL_] GETCOMPONENT-STATUS SWITCH :", result.output);

  let _sensor = {
    duration: 0,
    start: 0,
    stop: 0,
    mode: "null",
    temp_max : 0,
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
    print("[POOL] - make_unlock - Publish state lock_update => false");
  }

  
}

/**
 * Activate periodic updates
 */
if(CONFIG.update_period > 0) Timer.set(CONFIG.update_period, true, publishState);


/**
 * Initialize listeners and configure switch and sensors entries
 */
function initMQTT() {

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

    //temperature current
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

  //temperature exterior
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




/////////

// compute duration of filtration for a given max temperature
// duration is returned in float format (1.25 -> 1h 15mn)
function compute_duration_filt(t) {
//  if (t < 5)
//    return 1* STATUS.coeff;
  if (t < 4)
      return 0.5 * STATUS.coeff;            // ->0.5
  if (t < 10)
//    return ((t/5)* STATUS.coeff);           // 1 -> 2
    return ((t/7)* STATUS.coeff);
  if (t < 12)
    return ((t-8)* STATUS.coeff);           // 2 -> 4
  if (t < 16)
    return ((t/2-2)* STATUS.coeff);         // 4 -> 6
  if (t < 24)
    return ((t/4+2)* STATUS.coeff);         // 6 -> 8
  if (t < 27)
    return ((t*4/3-24)* STATUS.coeff)       // 8 -> 12
  if (t < 30)
    return ((t*4 - 96)* STATUS.coeff);      // 12 -> 24
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

  //print("[POOL_ABACUS]  STATUS.coeff = ", STATUS.coeff);

  let a = 0.00335 * STATUS.coeff;
  let b = -0.14953 * STATUS.coeff;
  let c = 2.43489 * STATUS.coeff;
  let d = -10.72859 * STATUS.coeff;

  return (  (a * Math.pow(new_t,3)) + ( b * Math.pow(new_t,2)) + ( c * new_t ) + d );

}



// compute the pump schedule for a given duration
// returns an array of start/stop times in float
// [ start1, stop1, start2, stop2, ... ]
function compute_schedule_filt_pivot(d) {
  let s = null;
  //let matin = Math.round(d)/2;
  let matin = d/2;
  let aprem = d - matin;
  // si l'heure de fin est supérieur 24, repositionner l'heure a partir de 00:00, on retranche 24
  let saprem = STATUS.next_noon + aprem;
  if ( saprem >= 24) {
    saprem = saprem - 24;
  }
  //s = [ STATUS.next_noon - matin, STATUS.next_noon + aprem ];
  s = [ STATUS.next_noon - matin, saprem ];

  STATUS.start = JSON.stringify(s[0]);
  STATUS.stop = JSON.stringify(s[1]);
  STATUS.stop_orig = JSON.stringify(STATUS.next_noon + aprem);

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
  
  print("[POOL] [NEW_DAY] update_new_day debug IF - current_time:", t, " <= update_time:", STATUS.update_time);
  print("[POOL] [NEW_DAY] temp - update_temp_max:", STATUS.temp_max, "update_temp_max_last:", STATUS.update_temp_max_last,"temp_yesterday:", STATUS.temp_yesterday, "temp_ext:", STATUS.temp_ext);

  if (t <= STATUS.update_time && STATUS.temp_today !== null){
    STATUS.tick_day++;
    print("[POOL_NEW_DAY] update_new_day is OK", STATUS.tick_day);
    // suivant le déclenchement du "new day", cela ne prend pas en compte la temperature max de la vielle, et donc la pompe démarre le matin
    // puis s'arrete sur une autre reprogrammation, car la température est moins élevé
    // donc pour test pour l'instant
    //FIXME
    //STATUS.temp_yesterday = STATUS.temp_max;
    STATUS.temp_yesterday = STATUS.temp_today;
    STATUS.temp_today = null;
    STATUS.update_time = t

    //FIXME TEST
    //quand la temeprature diminue d'un jour sur l'autre, le new day change la température de yesterday, mais pas la programation.
    // Du coup le matin lapompe fonctionne 10 min et met a jour la programation durant le fonctionnement, puis s'arrete et recommence en fonction de la prog.
    // Il faut que la programation soit mise à jour dès que le new day est updated.
    update_temp(false,false);
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

  let duration_abacus = compute_duration_filt(max);
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
    compute_switch_from_schedule();

    do_call(calls);
  }
}

function compute_switch_from_schedule(){

  if ((STATUS.sel_mode === "Auto") && ( STATUS.freeze_mode === false )){
    // compute the current switch state according to the schedule
    on = false;
    time = get_current_time();
    let j = false;
    let schedule24 = STATUS.schedule;
    if ( schedule24[1] < STATUS.next_noon ){
      schedule24[1] = schedule24[1] + 24;
    }
    for (let i = 0; i < schedule24.length; i++) {
      j = !j;
      print("[POOL SWITCH] time:", time ,"schedule24[i]");
      if (time >= schedule24[i])
        on = j;
    }
    print("[POOL SWITCH] time:", time ,"");

    let calls = [];
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

  // update temp only if pump is on.
  // let switchResult = Shelly.getComponentStatus("switch",0);
  // print("[POOL_update_temp] GETCOMPONENT-STATUS SWITCH :", switchResult.output);
  // if ( !switchResult.output ){
  //   return
  // }

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
  print("[POOL] update_temp() published lock_update =>  true");
  STATUS.lock_update = true;

  STATUS.temp = Math.round(STATUS.current_temp * 10) / 10;
  //update max only if pump is on
  let switchResult = Shelly.getComponentStatus("switch",0);
  print("[POOL_update_temp] GETCOMPONENT-STATUS SWITCH :", switchResult.output);
  if ( switchResult.output ){
    STATUS.temp_today = Math.max(STATUS.temp_today, STATUS.temp);
    STATUS.temp_max   = Math.max(STATUS.temp_today, STATUS.temp_yesterday);
  }


  //print("[POOL] update_temp - max today:", STATUS.temp_max, "today:", STATUS.temp_today, "yesterday:", STATUS.temp_yesterday);
  //print("[POOL] update_temp - update_temp_max:", STATUS.temp_max, "update_temp_max_last:", STATUS.update_temp_max_last, "temp_ext:", STATUS.temp_ext);

  STATUS.current_time = get_current_time();
  
  if ((STATUS.temp_max !== STATUS.update_temp_max_last) ||
      (STATUS.temp_ext < CONFIG.freeze_temp ) ||
      (STATUS.freeze_mode === true) ||
      (fromUpdateCoeff === true)  ||
      (nodisable === true) ) {

        update_temp_call();

  }else if( (STATUS.sel_mode === "Force on") || (STATUS.sel_mode === "Force off")){
    print("[POOL] Force ON or Off, lock_update =>  false");
    STATUS.lock_update = false;
    return;
  }else {
    print("[POOL] no temp change, skip update_pump, lock_update =>  false");
    STATUS.lock_update = false;
  }
}

function get_current_time(){
  print("[POOL] get_status current time");
  
  let result = {
    time: null,
  };
  let i = 1;

  while (result.time === null ){
    // use getComponentStatus (sync call) instead of call of "Sys.GetStatus" ( async call)
    result = Shelly.getComponentStatus("sys"); 
    print("[POOL] get_status tick: ", i);
    i++;
  }

  print("[POOL] get_current_time() time:", result.time);
  
  let time = result.time; // "HH:MM"
  

  // compute current time in float format (12h45 -> 12.75)
  let t = JSON.parse(time.slice(0,2)) + JSON.parse(time.slice(3,5)) / 60;

  return t;
}


function update_temp_call(){

  STATUS.update_time = STATUS.current_time;
  print("[POOL TIME] ", STATUS.update_time);
  // freeze_mode
  if (STATUS.temp_ext < CONFIG.freeze_temp){
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


Shelly.addEventHandler(
  function (data) {

    let re = JSON.stringify(data);
    print("EVENT", re);


    /**
    * Publish update on switch change on binary sensor
    */
    if (
      data.component === "switch:0" &&
      typeof data.info.output !== "undefined"
    ) {
      let _state_str = data.info.output ? "ON" : "OFF";
      MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);
  
    }

    // Event pour changement de température
    //let re = JSON.stringify(data);
    //print("EVENTTTTTT", re);
    if (data.info.event === "temperature_change") {
      if (data.info.id === CONFIG.shelly_id_temp_ext) {
        // changement de la temperature exterieur
        STATUS.temp_ext = data.info.tC;
        print("changement de la temperature exterieur");
      }
      if (data.info.id === CONFIG.shelly_id_temp_pool) {
        // changement de la temperature pool
        STATUS.current_temp = data.info.tC;
        print("changement de la temperature piscine");
      }
      //process mise à jour des temperature
      update_temp(false,false);
      publishState()
    }

    //event changement du switch et lock
    if (data.info.event === "toggle") {

      let result = Shelly.getComponentStatus("switch",0); 
      print("[POOL_] TOGGLE EVENT GETCOMPONENT-STATUS SWITCH :", result.output);

      let _state_str = result.output ? "ON" : "OFF";
      MQTT.publish(buildMQTTStateCmdTopics("binary_sensor", "state"), _state_str);

      STATUS.tick_lock++;
      print("[POOL] disable temp", STATUS.tick_lock);

      if (STATUS.disable_temp !== null)
        Timer.clear(STATUS.disable_temp);

      STATUS.disable_temp = Timer.set(
        600 * 1000,
        false,
        function () {
          print("[POOL] re-enable temp");
          STATUS.disable_temp = null;
        }
      );
    }

  }
);



/**
 * Activate periodic check for new day
 * 300000 = 5min
 */
 Timer.set(600000, true, update_new_day);

