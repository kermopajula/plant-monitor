// Collector process: scans for Mi Flora sensors on an interval and stores readings.
//
// Each cycle:
//  1. Passive scan: listen to advertisements for SCAN_SECONDS (stops early once
//     every adopted sensor has reported all four values). Firmware 3.x sends
//     readings this way, so no connection is needed.
//  2. Active fallback: adopted sensors that were heard but sent no readings
//     (older firmware) are connected to and read via GATT handles.
//  3. Device info: battery + firmware are read by connecting about once a day
//     (firmware 3.2.1+ no longer broadcasts battery).

import { config } from '../config';
import { SETTINGS, Store, type SensorRow } from '../db';
import { createLogger } from '../lib/log';
import { GattLayoutError, METRIC_KEYS, type PartialMeasurement } from '../lib/miflora';
import { errorMessage, retry, sleep } from '../lib/retry';
import { decidePoll } from '../lib/poll-policy';
import { intervalMinutes } from '../plants';
// './ble' is loaded in main(): noble opens the Bluetooth socket while loading and
// throws if that fails, which we want to report rather than crash on.
import type { Advert, FloraBle } from './ble';

const log = createLogger('collector');
const store = new Store(config.dbPath);
let ble: FloraBle;

/** If a cycle takes longer than this, BLE is probably wedged: exit and let PM2 restart us. */
const CYCLE_WATCHDOG_MS = 15 * 60_000;
/** After a failed battery/firmware read, wait this long before connecting for it again. */
const INFO_RETRY_MS = 6 * 3600_000;

interface Heard {
  rssi: number;
  localName: string | null;
  values: PartialMeasurement;
}

const isComplete = (v: PartialMeasurement | undefined) => !!v && METRIC_KEYS.every((k) => v[k] != null);
const hasAnyValue = (v: PartialMeasurement | undefined) => !!v && METRIC_KEYS.some((k) => v[k] != null);

async function runCycle(): Promise<Record<string, unknown>> {
  const started = Date.now();
  const adopted = store.listSensors(true);
  const heard = new Map<string, Heard>();

  await ble.scan(config.scanSeconds * 1000, (a: Advert) => {
    const h = heard.get(a.mac) ?? { rssi: a.rssi, localName: a.localName, values: {} };
    h.rssi = a.rssi;
    h.localName ??= a.localName;
    if (a.beacon) Object.assign(h.values, a.beacon.values);
    heard.set(a.mac, h);
    return adopted.length > 0 && adopted.every((s) => isComplete(heard.get(s.mac)?.values));
  });

  const now = Date.now();
  for (const [mac, h] of heard) {
    const isNew = !store.getSensor(mac);
    store.markSeen(mac, now, h.rssi, h.localName);
    if (isNew) log.info(`discovered new Mi Flora ${mac} (rssi ${h.rssi})`);
  }

  const summary = { passive: 0, active: 0, deviceInfo: 0, missing: 0, failed: 0 };
  for (const s of adopted) {
    const h = heard.get(s.mac);
    if (!h) {
      summary.missing++;
      log.warn(`${label(s)}: not heard during scan`);
      store.setError(s.mac, 'Not heard during the last scan (out of range or battery empty?)', now);
      continue;
    }
    const passive = hasAnyValue(h.values);
    if (passive) {
      store.insertReading(s.mac, now, h.values, 'passive');
      store.setMode(s.mac, 'passive');
      summary.passive++;
    }
    if (h.values.battery != null) store.setDeviceInfo(s.mac, { battery: h.values.battery }, now);

    const batteryFresh =
      h.values.battery != null || (s.battery_at != null && now - s.battery_at < config.batteryReadHours * 3600_000);
    const action = decidePoll({
      passive,
      batteryFresh,
      firmwareKnown: !!s.firmware,
      infoAttemptAt: s.info_attempt_at,
      now,
      infoRetryMs: INFO_RETRY_MS,
    });
    if (action === 'none') {
      // Keep a battery/firmware error visible until that read works.
      if (batteryFresh && s.firmware) store.setError(s.mac, null, now);
      continue;
    }

    store.markInfoAttempt(s.mac, now);
    try {
      const r = await retry(() => ble.poll(s.mac, action === 'data', s.firmware), {
        attempts: config.pollAttempts,
        baseDelayMs: 2000,
        onError: (err, attempt) => log.warn(`${label(s)}: poll attempt ${attempt} failed: ${errorMessage(err)}`),
        shouldRetry: (err) => !(err instanceof GattLayoutError),
      });
      const ts = Date.now();
      if (r.firmware && r.firmware !== s.firmware) log.info(`${label(s)}: firmware ${r.firmware}`);
      store.setDeviceInfo(s.mac, { battery: r.battery, firmware: r.firmware }, ts);
      if (r.battery != null || r.firmware) summary.deviceInfo++;
      if (r.values) {
        store.insertReading(s.mac, ts, r.values, 'active');
        store.setMode(s.mac, 'active');
        summary.active++;
      }
      if (r.infoError) {
        log.warn(`${label(s)}: could not read battery/firmware: ${r.infoError}`);
        store.setError(s.mac, `Could not read battery/firmware: ${r.infoError}`, ts);
      } else {
        store.setError(s.mac, null, ts);
      }
    } catch (err) {
      summary.failed++;
      const what = action === 'info' ? `Battery/firmware read failed (next try in ${INFO_RETRY_MS / 3600_000} h)` : 'Active read failed';
      const msg = `${what}: ${errorMessage(err)}`;
      log.error(`${label(s)}: ${msg}`);
      store.setError(s.mac, msg, Date.now());
    }
  }

  const result = { ...summary, heard: heard.size, adopted: adopted.length, durationMs: Date.now() - started };
  log.info(`cycle done: ${JSON.stringify(result)}`);
  return result;
}

const label = (s: SensorRow) => (s.name ? `${s.name} (${s.mac})` : s.mac);

let status: Record<string, unknown> = {};
/** Shown on the setup page so you can tell whether the collector is alive. */
function setStatus(patch: Record<string, unknown>) {
  status = { ...status, error: null, ...patch, at: Date.now(), pid: process.pid };
  store.setSetting(SETTINGS.collectorStatus, JSON.stringify(status));
}

async function main() {
  log.info(`starting; db=${config.dbPath}`);
  try {
    const { FloraBle, onAdapterLost, waitForPoweredOn } = require('./ble') as typeof import('./ble');
    ble = new FloraBle({ connectMs: config.connectTimeoutMs, gattMs: config.gattTimeoutMs });
    onAdapterLost((state) => {
      log.error(`Bluetooth adapter state changed to "${state}", exiting so PM2 restarts the collector`);
      process.exit(1);
    });
    await waitForPoweredOn(30_000);
  } catch (err) {
    setStatus({ state: 'error', error: errorMessage(err) });
    log.error(
      `${errorMessage(err)}. Is Bluetooth enabled and does node have cap_net_raw? Re-run ./scripts/install.sh or see README → Troubleshooting.`,
    );
    process.exit(1);
  }

  let lastScanRequest = store.getSetting(SETTINGS.scanRequestedAt);
  for (;;) {
    const cycleStart = Date.now();
    setStatus({ state: 'scanning', cycleStartedAt: cycleStart });
    const watchdog = setTimeout(() => {
      log.error('cycle watchdog fired, exiting so PM2 restarts the collector');
      process.exit(1);
    }, CYCLE_WATCHDOG_MS);
    try {
      const result = await runCycle();
      setStatus({ state: 'idle', lastCycleAt: cycleStart, lastCycle: result });
    } catch (err) {
      log.error(`cycle failed: ${errorMessage(err)}`);
      setStatus({ state: 'error', lastCycleAt: cycleStart, error: errorMessage(err) });
    } finally {
      clearTimeout(watchdog);
    }

    // Wait for the next cycle, re-reading the interval so changes on the setup
    // page apply without a restart; a "scan now" request starts one immediately.
    for (;;) {
      await sleep(5000);
      const req = store.getSetting(SETTINGS.scanRequestedAt);
      if (req !== lastScanRequest) {
        lastScanRequest = req;
        log.info('scan requested from the setup page');
        break;
      }
      if (Date.now() - cycleStart >= intervalMinutes(store) * 60_000) break;
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} received, shutting down`);
    store.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
