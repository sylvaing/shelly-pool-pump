# Tests

Simulated Shelly Gen2 runtime and tests for `../pool.js` (v2). Node 20+, no dependency.

```
node --test "test/*.test.js"
```

| File | Role |
|---|---|
| `shelly_sim.js` | simulated runtime: clock, KVS, schedules, relay, probes, MQTT, fault injection; trims `Array.shift`, `padStart`, `Number.isFinite` like firmware 1.7.1 |
| `helpers.js` | boot / reboot / run helpers and relay history tools |
| `unit.test.js` | pure functions: duration table, solar noon, window, freeze logic, validation |
| `scenarios.test.js` | 20 behaviour scenarios (incl. custom `pool_site`, MQTT off, no location) + a chaos test (random API failures) |
| `smoke.js` | verbose run: migration from the v1 script, then two days (`node test/smoke.js`) |

Device side, `tools/shelly.mjs` (same Node, no dependency) uploads and watches the script:
`status`, `deploy pool.js --name <name> [--dry-run] [--autostart]`, `site [json]`, `compare <id>` (v2 decisions
vs the v1 schedules), `eval`, `logs`, `stop|start|delete <id>`.
