# shelly-pool-pump

Automatic pool filtration with a Shelly Plus 1 and two temperature probes: the filtration time
follows the water temperature, it is centred on the solar noon, and the pipes are protected
against frost. The Shelly decides alone. It keeps working without network, MQTT or Home
Assistant, and resumes after a power cut. Home Assistant, when present, displays the state and
changes the settings through MQTT discovery.

Version 2.1 (`pool.js`). Tested on a Shelly Plus 1 (Gen2), firmware 1.7.1, with the Shelly Plus
Add-on and two DS18B20 probes.

- [How it works](#how-it-works)
- [Hardware and wiring](#hardware-and-wiring)
- [Installation](#installation)
- [Configuration](#configuration)
- [Home Assistant](#home-assistant)
- [Daily use](#daily-use)
- [Upgrading from v1, rolling back](#upgrading-from-v1-rolling-back)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works

Every 10 seconds the script reads the clock, the two probes and the relay, then decides whether
the pump must run.

**Filtration time.** It comes from the highest water temperature of today and yesterday, times
a coefficient (default 1), capped at 23 h:

| Water | Hours |
|---|---|
| below 4 °C | 0.5 |
| 4 – 10 °C | t / 7 |
| 10 – 12 °C | t − 8 |
| 12 – 16 °C | t / 2 − 2 |
| 16 – 24 °C | t / 4 + 2 |
| 24 – 27 °C | 4t / 3 − 24 |
| 27 – 30 °C | 4t − 96 |
| 30 °C and more | 23 |

The water probe sits on the pipe. When the pump stops, it measures the water left in the pipe,
which is at room temperature. So the day's maximum is only taken after **5 minutes of
running**, once pool water flows past the probe. Using yesterday's maximum as well avoids
filtering too little in the morning, before the water has warmed up.

**Placement.** The run is centred on the **solar noon**, when the sun heats the water most and
algae grow fastest. The script computes the solar noon from the Shelly location, so no
external service is needed. Example: 9 h 20 of filtration around 13:43 runs from 09:04 to 18:24.
The window may cross midnight.

```
00:00          09:04            13:43            18:24          24:00
  |--------------[=======filtration=======]---------------------|
                          solar noon
```

**Frost protection.** The second probe measures the air around the pump and filter, for
example in the technical room.

- **Entry and exit.** Below 0.5 °C the protection becomes active; above 1 °C it stops. The two
  thresholds are different so that the pump does not keep switching on and off around one value.
- **Short cycles.** While active, the pump runs **15-minute cycles** whenever the still water in
  the pipe cools down to 2 °C. The colder the room, the faster the pipe cools, so the cycles
  get closer on their own.
- **Extended cycles.** If the pool water itself is very cold, a cycle lasts as long as needed.
- **Continuous run.** Below −5 °C the pump runs non-stop, until the air is back above −4.5 °C.

In a simulated frosty night (room from +5 to −6 °C), this ran the pump for 4.5 h, against
10.5 h for a "run continuously below 0.5 °C" rule, and the pipe never went under 1.5 °C. All
thresholds can be changed.

**Priorities.** From strongest to weakest:

1. Frost protection. It can only start the pump, never stop it.
2. Force on / Force off.
3. Manual switching (button, Shelly app, web UI). It lasts until the next planned change.
4. Auto, the filtration window.

**Without network.** The clock comes, in this order, from:

1. NTP;
2. the `Date` header of a small web answer from your router or another local server, if you
   configure one;
3. an estimate from the last time saved (saved every hour).

With no time at all, the script filters right after start-up, then once every 24 hours.
Settings, today's and yesterday's maxima and the last known time are stored on the Shelly,
in its key-value store (KVS), so a power cut loses nothing.

**Robustness.**

- **Errors never stop the script.** On the Shelly, any uncaught error stops a script. Here every
  entry point catches its errors and reports them in a diagnostic, and every input is
  validated.
- **Watchdog.** A Shelly schedule restarts the script every 30 minutes if it ever stops.

## Hardware and wiring

- **Controller:** Shelly Plus 1. Its dry contact drives the coil of the contactor that powers
  the pump.
- **Shelly Plus Add-on** with 2 × DS18B20
  probes:
  - **air** probe, in the air around the pump and filter (the technical room);
  - **water** probe, on the pipe close to the pump, insulated from the room air if possible.

> ⚠️ **Never power the pump directly from the Shelly.** The starting current of a pump motor
> can damage the Shelly (reboots, or worse, fire). As with the old mechanical timer in the
> electrical panel, the Shelly must only switch a **contactor**, and the contactor switches
> the pump. For the same reason a Shelly Plus 1PM cannot measure the pump's energy here: use
> a Shelly EM with a clamp for that.

## Installation

1. **Firmware.** Update the Shelly to 1.7 or later (web UI > Settings > Firmware).
2. **Probes.** In the web UI, under Add-on > Peripherals, add the two DS18B20 probes. Note
   their ids: by default the script expects **100 for the air** and **101 for the water**.
   Warm one probe in your hand to tell which is which.
3. **Location and time.** In Settings > Location, check the time zone and the coordinates. The
   longitude sets the solar noon. Under Settings > SNTP, the default server is fine; a local
   NTP server keeps the clock right when the internet is down.
4. **MQTT (for Home Assistant).**
   - In Settings > MQTT, enable MQTT and set your broker (for example the Mosquitto add-on of
     Home Assistant).
   - The Shelly's own "RPC / status notifications over MQTT" are not needed.
   - In Home Assistant, the MQTT integration must be set up.
5. **Script.**
   - Open Scripts > Create script, paste [`pool.js`](pool.js), save and **start** it.
   - **Enable "Run on startup".**
   - Or, from a computer with Node 20+: `node tools/shelly.mjs deploy pool.js --name pool_pump --autostart`
     (set `SHELLY_HOST` if the Shelly is not at 192.168.1.142).
6. **Check.** The script log shows `[pool] start 2.1.0`, then `loaded: …` and `clock: ntp`. In
   Home Assistant, a `pool_pump` device appears with its entities.
7. **Only one pool script at a time.** Scripts share about 25 KB of memory on the Plus 1; this
   one uses about 14 KB. Stop and disable any other pool script, such as the v1.

## Configuration

### Installation settings: KVS `pool_site` (optional)

The defaults suit the setup described above. To change them, store a JSON object with **only
the fields to change** in KVS key `pool_site`, then restart the script. These settings survive
script updates, so you never have to edit the code.

| Field | Default | Meaning |
|---|---|---|
| `switch_id` | `0` | relay driving the contactor |
| `air_id` | `100` | id of the air probe |
| `water_id` | `101` | id of the water probe |
| `name` | `"pool_pump"` | Home Assistant device name and `unique_id` prefix (lowercase, digits, `_`). **Do not change it once the entities exist**: they would be duplicated |
| `longitude` | `null` | overrides the Shelly location |
| `time_urls` | `[]` | up to 3 URLs used to read the time from the `Date` header when NTP fails. **Only URLs with a very small answer**, such as an error page of your router: a large page exhausts the script memory and stops it |
| `mqtt` | `true` | publish the state and accept commands over MQTT |
| `ha_discovery` | `true` | announce the entities to Home Assistant |
| `ha_prefix` | `"homeassistant"` | MQTT discovery prefix |

To write it, run one of these commands, then restart the script:

```
node tools/shelly.mjs site '{"time_urls":["http://192.168.1.1/x404"]}'
curl -X POST http://<shelly>/rpc -d '{"id":1,"method":"KVS.Set","params":{"key":"pool_site","value":{"water_id":102}}}'
```

Invalid or unknown fields are ignored, and the diagnostic reports them.

### Pool settings: from Home Assistant (stored in KVS `pool_cfg`)

| Setting (Home Assistant name) | Default | Range |
|---|---|---|
| Running mode | Auto | Auto / Force on / Force off |
| coeff de filtration | 1 | 0.6 – 1.6, step 0.1 |
| Hors-gel entrée sous (freeze protection on below, room air) | 0.5 °C | −2 – 3 °C |
| Hors-gel sortie au-dessus de (off above) | 1 °C | always at least 0.5 °C above the entry |
| Hors-gel seuil tuyau (pipe threshold starting a cycle) | 2 °C | 1 – 5 °C |
| Hors-gel durée cycle (cycle length) | 15 min | 5 – 60 min |
| Hors-gel marche continue sous (continuous run below) | −5 °C | −10 – 0 °C |

The Shelly is the reference. A value sent from Home Assistant is checked, snapped to the
range and step, saved on the Shelly, then published back.

## Home Assistant

Entities of the `pool_pump` device:

| Entity | Content |
|---|---|
| Pool Pump | the pump runs |
| Running mode, coeff de filtration | settings (above) |
| Duration | filtration hours of the day |
| Start, Stop | current or next filtration window (timestamps, empty in Force modes) |
| Mode | `summer`, or `freeze` while the frost protection is active |
| Now, Exterieur | water probe, air probe |
| Max, Yesterday | max used for the duration, yesterday's max |
| Diagnostic | overall state + attributes (below) |
| Hors-gel … | the 5 frost settings (device configuration section) |

All entities show as unavailable when the Shelly is offline.

Example card. With `format: time`, Start and Stop show `18:24` instead of "in 3 hours":

```yaml
type: entities
title: Pool
entities:
  - select.pool_pump_running_mode
  - binary_sensor.pool_pump_pool_pump
  - sensor.pool_pump_duration
  - entity: sensor.pool_pump_start
    format: time
  - entity: sensor.pool_pump_stop
    format: time
  - sensor.pool_pump_now
  - sensor.pool_pump_max
  - sensor.pool_pump_exterieur
  - sensor.pool_pump_mode
  - number.pool_pump_coeff_de_filtration
  - sensor.pool_pump_diagnostic
```

<!-- Screenshots of the v2 card, the device configuration section and the diagnostic attributes go here. -->

## Daily use

- **Auto** is the normal mode. **Force on** and **Force off** hold the pump on or off until you
  switch back to Auto. Frost protection still starts the pump in Force off.
- **Manual switching** (button, Shelly app or web UI, `switch` entity of the Shelly
  integration) is respected until the next change the plan foresees:
  - stopped during the window, the pump stays off until the planned stop time;
  - started in the evening, it keeps running until the next day's planned stop.
- **Diagnostic** states, in order of importance:

  | State | Meaning |
  |---|---|
  | `hors_gel` | frost protection active |
  | `sonde_eau_hs`, `sonde_air_hs` | water or air probe missing or out of range (−30 – 60 °C) |
  | `position_absente` | no longitude: set the Shelly location |
  | `attente_heure` | no clock yet, filtering from start-up |
  | `heure_estimee` | clock estimated from the last saved time |
  | `ok` | all good |

  Its attributes give the clock source, both probes, a manual switching in progress, the last
  error and the error count, KVS writes, memory used and the relay's internal temperature
  (alert above 85 °C).

- **When a probe fails:**
  - without the water probe, frost protection runs 15 minutes per hour (30 below −3 °C);
  - without the air probe, the still pipe water decides;
  - without both, it runs 15 minutes per hour if the last air reading was below 3 °C.

## Upgrading from v1, rolling back

At its first start, v2 takes over from v1 by itself:

- it reads yesterday's maximum from the v1 key `pool_temp_max`;
- it deletes the v1 keys (`pool_temp_max`, `coeff`, `temp`);
- it **deletes the v1 `Switch.Set` schedules** and creates its watchdog schedule;
- it clears the commands v1 left retained on the broker;
- it updates the Home Assistant entities in place: same `unique_id`, so the history and cards
  are kept.

Mode and coefficient start at Auto and 1: set them again from Home Assistant if needed.
The v1 needed a Home Assistant token and IP for the solar noon; v2 needs neither.

To go back to v1:

1. Stop and disable the v2 script.
2. **Delete the watchdog schedule** (the one calling `Script.Start`), or it restarts v2 every
   30 minutes.
3. Enable and start v1. It recreates its schedules at its next update.

## Troubleshooting

- **The script stopped by itself.** The script log tells why; the watchdog restarts it within
  30 minutes. Check that no other script runs (memory): `node tools/shelly.mjs status` shows
  the memory of each script.
- **Wrong times.** Check the Shelly location (longitude) and time zone. The diagnostic
  attribute `time_source` should be `ntp`.
- **No entities in Home Assistant.**
  - Check the MQTT connection of the Shelly and that `mqtt` and `ha_discovery` are not
    disabled in `pool_site`.
  - Restarting the script republishes everything.
- **`Exterieur` reads the room, not the outside.** That is expected: frost protection needs the
  temperature around the pipes.

## Development

The script runs on the Shelly engine, a JavaScript subset: no arrow functions, no template
literals, no `Array.shift`, at most 5 timers.

A simulated Shelly for Node and the tests live in [`test/`](test/); they need Node 20+ and no
dependency:

```
node --test "test/*.test.js"
```

They cover the computations (15 unit tests), 20 behaviour scenarios (summer day, power cut without network,
frosty nights, probe failures, manual switching, corrupted storage, custom installation…) and a
chaos test with random API failures. `tools/shelly.mjs` deploys and watches the script on a
real device (`status`, `deploy`, `site`, `compare`, `eval`, `logs`).

Based on the Shelly script of ggilles
([forum thread](https://www.shelly-support.eu/forum/index.php?thread/14810-script-randomly-killed-on-shelly-plus-1pm/)),
with many changes. Thanks to the Shelly team for the fixes they made along the way.
