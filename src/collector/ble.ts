// BLE access via @abandonware/noble. Only the collector process imports this:
// loading noble opens the HCI socket.

// noble exports a single Noble instance whose methods live on its prototype.
// `import * as` would copy only its own properties (losing on(), startScanningAsync(), ...),
// so take the module object as is.
import noble = require('@abandonware/noble');
import { needsModeChange } from '../lib/firmware';
import { createLogger } from '../lib/log';
import {
  CHAR_FIRMWARE_BATTERY,
  CHAR_MODE_CHANGE,
  CHAR_REALTIME_DATA,
  DATA_SERVICE_UUID,
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
  battery: number | null;
  firmware: string | null;
  /** Why battery/firmware could not be read (readings may still have worked). */
  infoError: string | null;
  values: Measurement | null;
}

const hex = (h: number) => `0x${h.toString(16).padStart(2, '0')}`;

/**
 * Reads/writes one connected sensor. Uses the raw GATT handles first; if a
 * handle returns no data (the sensor answered with an error), switches to
 * looking the characteristics up by UUID for the rest of the connection.
 */
class SensorGatt {
  private chars: Map<string, noble.Characteristic> | null = null;

  constructor(
    private readonly p: noble.Peripheral,
    private readonly mac: string,
    private readonly gattMs: number,
    public byUuid: boolean,
  ) {}

  private async characteristic(uuid: string): Promise<noble.Characteristic> {
    if (!this.chars) {
      const { characteristics } = await withTimeout(
        this.p.discoverSomeServicesAndCharacteristicsAsync([DATA_SERVICE_UUID], []),
        this.gattMs * 2,
        'discover characteristics',
      );
      this.chars = new Map(characteristics.map((c) => [c.uuid.toLowerCase(), c]));
    }
    const c = this.chars.get(uuid);
    if (!c) {
      const found = [...this.chars.keys()].join(', ') || 'none';
      throw new Error(`characteristic ${uuid} not found in service ${DATA_SERVICE_UUID} (found: ${found})`);
    }
    return c;
  }

  async read(what: string, handle: number, uuid: string): Promise<Buffer> {
    if (!this.byUuid) {
      const buf = await withTimeout(this.p.readHandleAsync(handle), this.gattMs, `read ${what}`);
      if (buf.length) return buf;
      log.info(`${this.mac}: handle ${hex(handle)} returned no data, reading characteristic ${uuid} instead`);
      this.byUuid = true;
    }
    const c = await this.characteristic(uuid);
    const buf = await withTimeout(c.readAsync(), this.gattMs, `read ${what}`);
    if (!buf.length) throw new Error(`${what}: sensor returned no data (handle ${hex(handle)} and characteristic ${uuid})`);
    return buf;
  }

  async write(what: string, handle: number, uuid: string, data: Buffer): Promise<void> {
    if (this.byUuid) {
      const c = await this.characteristic(uuid);
      await withTimeout(c.writeAsync(data, false), this.gattMs, what);
    } else {
      await withTimeout(this.p.writeHandleAsync(handle, data, false), this.gattMs, what);
    }
  }
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
  /** Sensors whose handle reads failed: go straight to characteristics next time. */
  private readonly useUuid = new Set<string>();

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
      const gatt = new SensorGatt(p, mac, gattMs, this.useUuid.has(mac));
      let battery: number | null = null;
      let firmware: string | null = null;
      let infoError: string | null = null;
      try {
        const info = parseFirmwareBattery(await gatt.read('firmware/battery', HANDLE_FIRMWARE_BATTERY, CHAR_FIRMWARE_BATTERY));
        battery = info.battery;
        firmware = info.firmware || null;
      } catch (err) {
        // Without readings to fetch there is nothing left to do; otherwise still read them.
        if (!readData) throw err;
        infoError = errorMessage(err);
      }
      let values: Measurement | null = null;
      if (readData) {
        if (needsModeChange(firmware || knownFirmware)) {
          await gatt.write('mode change write', HANDLE_MODE_CHANGE, CHAR_MODE_CHANGE, MODE_CHANGE_COMMAND);
          await sleep(200);
        }
        values = parseRealtimeData(await gatt.read('sensor data', HANDLE_REALTIME_DATA, CHAR_REALTIME_DATA));
      }
      if (gatt.byUuid) this.useUuid.add(mac);
      return { battery, firmware, infoError, values };
    } finally {
      await withTimeout(p.disconnectAsync(), 5000, 'disconnect').catch((err) => log.warn(`${mac}: ${errorMessage(err)}`));
    }
  }
}
