print("[POOL] start");

let status = {
  temp: null,
  temp_ext:null,
  temp_max: null,
  temp_today: null,
  temp_yesterday: null,
  next_noon: 12,
  freeze_mode: false,


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
  let coeff = 1;

  let a = 0.00335 * coeff;
  let b = -0.14953 * coeff;
  let c = 2.43489 * coeff;
  let d = -10.72859 * coeff;

  return (  (a * Math.pow(new_t,3)) + ( b * Math.pow(new_t,2)) + ( c * new_t ) + d );

}

// calcul de l'heure pivot pour répartir la programmation de la pompe
// en fonction du zenith du soleil

function update_next_noon(d){
  // il faut aller chercher la valeur de sHA sun.sun next_noon
  // en premier lieu publier next_noon sur MQTT
  // ensuite récupérer la valeur
  // la traiter en converstion si necessaire
  // exemple plus bas:
  //let time = result.time; // "HH:MM"
  //      print("[POOL] time", time);
  // compute current time in float format (12h45 -> 12.75)
  //let t = JSON.parse(time.slice(0,2)) + JSON.parse(time.slice(3,5)) / 60;

  print("[POOL] date pivot", d);
  let new_d = JSON.parse(d.slice(0,2)) + JSON.parse(d.slice(3,5)) / 60;
  status.next_noon = new_d;
  print("[POOL] new_date pivot", new_d);
}

// compute the pump schedule for a given duration
// returns an array of start/stop times in float
// [ start1, stop1, start2, stop2, ... ]

function compute_schedule_filt(d) {
  let s = null;
  if (d < 2) {
    s = [ 9, 9+d ];
  } else if (d < 8) {
    s = [ 9, 10, 14, 14+d-1 ];
  } else if (d < 11) {
    s = [ 9, 11, 14, 14+d-2 ];
  } else if (d < 14) {
    s = [ 9, 9+d-9, 14, 23];
  } else if (d < 15) {
    s = [ 9, 9+d ];
  } else if (d < 18) {
    s = [ 24-d, 0 ];
  } else if (d < 24) {
    s = [ 6, d-18 ];
  } else {
    s = [ 6 ];
  }
  
  return s;
}

function compute_schedule_filt_pivot(d) {
  let s = null;
  let matin = Math.round(d)/2;
  let aprem = d - matin;
  s = [ status.next_noon - matin, status.next_noon + aprem ];

  let h = Math.floor(s[0]);
  let m = Math.floor((s[0]- h)*60);
  status.start = JSON.stringify(h) +":" + JSON.stringify(m);
  h = Math.floor(s[1]);
  m = Math.floor((s[1]- h)*60);
  status.stop= JSON.stringify(h) +":" + JSON.stringify(m);

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

//function to publish info on MQTT and use this in HA
function publish_mqtt_info(){


  print("[POOL] publish MQTT");
  //MQTT.publish(topic, message, qos, retain)
  //start
  //stop
  //duration
  //mode ( freeze/summer)
  //status
  let mode;
  if (status.freeze_mode === true){
    mode = 'freeze';
  }else{
    mode = 'summer';
  }
  let dur = status.duration;
  MQTT.publish(
    "pool_pump/info",
    '{\"start\":\"' + status.start +
    '\",\"stop\":\"' + status.stop +
    '\",\"duration\":\"' + JSON.stringify(status.duration) +
    '\",\"mode\":\"' + mode +
    '\"}',
    1,
    true
  )
/*
    '{\"start\":\"' + status.schedule[0] +
    '\",\"stop\":\"' + status.schedule[1] +
    '\",\"duration\":\"' + status.duration +
    '\",\"mode\":\"' + mode +
    '\"}',
    0,
    false
  */
}

// compute & configure pump schedule
// TODO force on  when duration==24
// TODO force off when duration==0  
// TODO freeze mode if cur < 1

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

function update_temp(obj) {
  status.tick_temp++;
  update_next_noon(obj.next_noon);
  let temp = obj.temperature;
  let temp_ext = obj.temperature_ext;
  status.temp_ext = temp_ext

  print("[POOL] update_temp", status.tick_temp, temp);

  if (status.disable_temp !== null) {
    print("[POOL] update disabled");
    return;
  }

  if (status.lock_update) {
    print("[POOL] update_temp locked");
    return;
  }
  status.lock_update = true;

  status.temp = Math.round(temp * 10) / 10;
  status.temp_today = Math.max(status.temp_today, status.temp);
  status.temp_max   = Math.max(status.temp_today, status.temp_yesterday);

  print("[POOL] update_temp - max:", status.temp_max, "today:", status.temp_today, "yesterday:", status.temp_yesterday);

  
  if ((status.temp_max !== status.update_temp_max_last) || (status.temp_ext < 2 ) || (status.freeze_mode === true))  {
    Shelly.call (
      "Sys.GetStatus",
      {},
      function (result) {
        let time = result.time; // "HH:MM"
        print("[POOL] time", time);

        // compute current time in float format (12h45 -> 12.75)
        let t = JSON.parse(time.slice(0,2)) + JSON.parse(time.slice(3,5)) / 60;

        if (t < status.update_time)
          update_new_day();

        // freeze_mode
        if (status.temp_ext < 2){
          print("[POOL] Mode hivernage - temp : ", status.temp_ext);
          status.freeze_mode = true;
          update_pump_hivernage();
          //publish_mqtt_info()
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
        publish_mqtt_info()
      }
    );
  }
  else {
    print("[POOL] no temp change, skip update_pump");
  }
//}
  status.lock_update = false;
  


}

// receives update from Pool Sensor
// - trigger all temperature and pump updates

MQTT.subscribe(
  "ha/pool",
  function (topic, msg) {
    status.tick_mqtt++;
    print("[POOL] mqtt", topic);
    let obj = JSON.parse(msg);
    if ((obj.next_noon === undefined) || (obj.temperature === undefined) || (obj.temperature_ext === undefined))  {
      return;
    }
    update_temp(obj);
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
        60 * 1000,
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
        print("[POOL] tick", result.time);
        status.time = result.time;
        status.uptime = result.uptime;
      }
    );
  }
);

