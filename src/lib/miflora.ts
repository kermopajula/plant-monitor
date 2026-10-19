// Mi Flora protocol: MiBeacon advertisement parsing (passive) and GATT payloads (active).

export interface Measurement {
  temperature: number | null; // °C
  moisture: number | null; // %
  conductivity: number | null; // µS/cm
  lux: number | null; // lx
}

export type PartialMeasurement = Partial<Measurement> & { battery?: number };

export const METRIC_KEYS = ['temperature', 'moisture', 'conductivity', 'lux'] as const;

export const XIAOMI_SERVICE_UUID = 'fe95';
export const MIFLORA_PRODUCT_ID = 0x0098;
export const MIFLORA_NAMES = ['flower care', 'flower mate'];
export const MIFLORA_MAC_PREFIXES = ['C4:7C:8D'];

// GATT handles (see README).
export const HANDLE_MODE_CHANGE = 0x33;
export const HANDLE_REALTIME_DATA = 0x35;
export const HANDLE_FIRMWARE_BATTERY = 0x38;
export const MODE_CHANGE_COMMAND = Buffer.from([0xa0, 0x1f]);

// The same values by GATT UUID (data service 0x1204). Handle numbers can differ
// between firmware versions; these UUIDs are the fallback when a handle read fails.
export const DATA_SERVICE_UUID = '1204';
export const CHAR_MODE_CHANGE = '1a00';
export const CHAR_REALTIME_DATA = '1a01';
export const CHAR_FIRMWARE_BATTERY = '1a02';

/** The sensor's GATT layout differs from the known one: retrying will not help. */
export class GattLayoutError extends Error {}

export interface MiBeacon {
  productId: number;
  frameCounter: number;
  mac: string | null;
  encrypted: boolean;
  values: PartialMeasurement;
}

export function formatMac(bytes: Buffer | number[]): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
}

export function normalizeMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return mac.toUpperCase();
  return hex.match(/../g)!.join(':');
}

/** Parse the 0xFE95 service data of a Xiaomi MiBeacon advertisement. Returns null if malformed. */
export function parseMiBeacon(buf: Buffer): MiBeacon | null {
  if (buf.length < 5) return null;
  const frameControl = buf.readUInt16LE(0);
  const encrypted = (frameControl & 0x08) !== 0;
  const hasMac = (frameControl & 0x10) !== 0;
  const hasCapability = (frameControl & 0x20) !== 0;
  const hasObject = (frameControl & 0x40) !== 0;

  const result: MiBeacon = {
    productId: buf.readUInt16LE(2),
    frameCounter: buf[4],
    mac: null,
    encrypted,
    values: {},
  };

  let i = 5;
  if (hasMac) {
    if (buf.length < i + 6) return null;
    result.mac = formatMac(Buffer.from(buf.subarray(i, i + 6)).reverse());
    i += 6;
  }
  if (hasCapability) {
    if (buf.length < i + 1) return null;
    const capability = buf[i];
    i += 1;
    if (capability & 0x20) i += 2; // IO capability bytes
  }
  if (!hasObject || encrypted) return result;

  while (i + 3 <= buf.length) {
    const type = buf.readUInt16LE(i);
    const len = buf[i + 2];
    const data = buf.subarray(i + 3, i + 3 + len);
    if (data.length < len) break;
    decodeObject(type, data, result.values);
    i += 3 + len;
  }
  return result;
}

function decodeObject(type: number, d: Buffer, out: PartialMeasurement): void {
  switch (type) {
    case 0x1004:
      if (d.length >= 2) out.temperature = d.readInt16LE(0) / 10;
      break;
    case 0x1007:
      if (d.length >= 3) out.lux = d[0] | (d[1] << 8) | (d[2] << 16);
      break;
    case 0x1008:
      if (d.length >= 1) out.moisture = d[0];
      break;
    case 0x1009:
      if (d.length >= 2) out.conductivity = d.readUInt16LE(0);
      break;
    case 0x100a:
      if (d.length >= 1) out.battery = d[0];
      break;
  }
}

export interface AdvertisementLike {
  address?: string;
  localName?: string;
  serviceData?: { uuid: string; data: Buffer }[];
}

/** Heuristic: is this advertisement from a Mi Flora sensor? */
export function isMiFlora(adv: AdvertisementLike): boolean {
  const name = adv.localName?.toLowerCase() ?? '';
  if (MIFLORA_NAMES.includes(name)) return true;
  const sd = adv.serviceData?.find((s) => s.uuid.toLowerCase() === XIAOMI_SERVICE_UUID);
  if (sd && sd.data.length >= 4 && sd.data.readUInt16LE(2) === MIFLORA_PRODUCT_ID) return true;
  const mac = adv.address ? normalizeMac(adv.address) : '';
  return MIFLORA_MAC_PREFIXES.some((p) => mac.startsWith(p));
}

/** Handle 0x38: byte 0 = battery %, bytes 2.. = ASCII firmware version, e.g. "3.2.1". */
export function parseFirmwareBattery(buf: Buffer): { battery: number; firmware: string } {
  if (buf.length < 3) throw new Error(`firmware/battery payload too short (${buf.length} bytes)`);
  const firmware = buf
    .subarray(2)
    .toString('ascii')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
  return { battery: buf[0], firmware };
}

/**
 * Handle 0x35 (after mode change): temperature int16 LE /10, 1 unknown byte,
 * light uint32 LE, moisture uint8, conductivity uint16 LE.
 */
export function parseRealtimeData(buf: Buffer): Measurement {
  if (buf.length < 10) throw new Error(`realtime payload too short (${buf.length} bytes)`);
  if (buf.subarray(0, 6).equals(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]))) {
    throw new Error('sensor returned placeholder data: mode change was not applied');
  }
  const m: Measurement = {
    temperature: buf.readInt16LE(0) / 10,
    lux: buf.readUInt32LE(3),
    moisture: buf[7],
    conductivity: buf.readUInt16LE(8),
  };
  if (m.moisture! > 100 || m.temperature! < -40 || m.temperature! > 80) {
    throw new Error(`implausible reading: ${JSON.stringify(m)}`);
  }
  return m;
}
