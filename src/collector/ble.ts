// BLE access via @abandonware/noble. Only the collector process imports this:
// loading noble opens the HCI socket.

// noble exports a single Noble instance whose methods live on its prototype.
// `import * as` would copy only its own properties (losing on(), startScanningAsync(), ...),
// so take the module object as is.
import noble = require('@abandonware/noble');
import { needsModeChange } from '../lib/firmware';
import { createLogger } from '../lib/log';
import {
  HANDLE_FIRMWARE_BATTERY,
  HANDLE_MODE_CHANGE,
  HANDLE_REALTIME_DATA,
  isMiFlora,
  MODE_CHANGE_COMMAND,
  normalizeMac,
  parseFirmwareBattery,
  parseMiBeacon,
  parseRealtimeData,
  XIAOMI_SERVICE_UUID,
  type Measurement,
  type MiBeacon,
} from '../lib/miflora';
import { errorMessage, sleep, withTimeout } from '../lib/retry';

const log = createLogger('ble');

export interface Advert {
  mac: string;
  rssi: number;
  localName: string | null;
  beacon: MiBeacon | null;
}

export interface PollResult {
  battery: number;
  firmware: string;
  values: Measurement | null;
}

export interface BleTimeouts {
  connectMs: number;
  gattMs: number;
}

export async function waitForPoweredOn(timeoutMs: number): Promise<void> {
  if (noble._state === 'poweredOn') return;
  await withTimeout(
    new Promise<void>((resolve) => {
      const onState = (state: string) => {
        log.info(`adapter state: ${state}`);
        if (state === 'poweredOn') {
          noble.removeListener('stateChange', onState);
          resolve();
        }
      };
      noble.on('stateChange', onState);
    }),
    timeoutMs,
    'waiting for Bluetooth adapter',
  );
}

/** Calls `handler` if the adapter leaves the poweredOn state (e.g. hci0 went down). */
export function onAdapterLost(handler: (state: string) => void) {
  noble.on('stateChange', (state) => {
    if (state !== 'poweredOn') handler(state);
  });
}

export class FloraBle {
  /** Peripherals seen so far; noble needs the Peripheral object to connect. */
  private readonly peripherals = new Map<string, noble.Peripheral>();

  constructor(private readonly timeouts: BleTimeouts) {}

  /**
   * Scan for up to `durationMs`, calling `onAdvert` for every Mi Flora
   * advertisement. Stops early when `onAdvert` returns true.
   */
  async scan(durationMs: number, onAdvert: (a: Advert) => boolean): Promise<void> {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));

    const onDiscover = (p: noble.Peripheral) => {
      try {
        const adv = p.advertisement;
        const sd = adv.serviceData?.find((s) => s.uuid.toLowerCase() === XIAOMI_SERVICE_UUID);
        const beacon = sd ? parseMiBeacon(sd.data) : null;
        const rawMac = p.address && p.address !== 'unknown' ? p.address : beacon?.mac;
        if (!rawMac) return;
        const mac = normalizeMac(rawMac);
        if (!isMiFlora({ address: mac, localName: adv.localName, serviceData: adv.serviceData })) return;
        this.peripherals.set(mac, p);
        if (onAdvert({ mac, rssi: p.rssi, localName: adv.localName || null, beacon })) finish();
      } catch (err) {
        log.warn(`failed to handle advertisement: ${errorMessage(err)}`);
      }
    };

    noble.on('discover', onDiscover);
    const timer = setTimeout(finish, durationMs);
    try {
      // allowDuplicates: each advertisement carries just one value, we need them all.
      await withTimeout(noble.startScanningAsync([], true), 10000, 'start scanning');
      await done;
    } finally {
      clearTimeout(timer);
      noble.removeListener('discover', onDiscover);
      await withTimeout(noble.stopScanningAsync(), 5000, 'stop scanning').catch((err) =>
        log.warn(errorMessage(err)),
      );
    }
  }

  /**
   * Connect and read battery + firmware (handle 0x38) and, if `readData`,
   * the live sensor values (mode change on 0x33, then read 0x35).
   */
  async poll(mac: string, readData: boolean, knownFirmware: string | null): Promise<PollResult> {
    const p = this.peripherals.get(mac);
    if (!p) throw new Error('sensor has not been seen in a scan yet');
    const { connectMs, gattMs } = this.timeouts;

    try {
      await withTimeout(p.connectAsync(), connectMs, 'connect');
    } catch (err) {
      try {
        p.cancelConnect();
      } catch {
        /* ignore */
      }
      throw err;
    }

    try {
      const info = parseFirmwareBattery(await withTimeout(p.readHandleAsync(HANDLE_FIRMWARE_BATTERY), gattMs, 'read firmware/battery'));
      let values: Measurement | null = null;
      if (readData) {
        if (needsModeChange(info.firmware || knownFirmware)) {
          await withTimeout(p.writeHandleAsync(HANDLE_MODE_CHANGE, MODE_CHANGE_COMMAND, false), gattMs, 'mode change write');
          await sleep(200);
        }
        values = parseRealtimeData(await withTimeout(p.readHandleAsync(HANDLE_REALTIME_DATA), gattMs, 'read sensor data'));
      }
      return { ...info, values };
    } finally {
      await withTimeout(p.disconnectAsync(), 5000, 'disconnect').catch((err) => log.warn(`${mac}: ${errorMessage(err)}`));
    }
  }
}
