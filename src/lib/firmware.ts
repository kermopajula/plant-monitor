// Firmware detection and advice for Xiaomi Mi Flora (HHCCJCY01) sensors.

export interface FirmwareVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export type AdviceLevel = 'info' | 'update-recommended' | 'caution';

export interface FirmwareAdvice {
  level: AdviceLevel;
  title: string;
  message: string;
}

export interface FirmwareInfo {
  version: string | null;
  /** e.g. "2.x", "3.x" or "unknown" */
  family: string;
  /** Firmware 3.x sends readings in BLE advertisements (no connection needed). */
  broadcastsReadings: boolean;
  /** 3.x below 3.2.1 also broadcasts battery level; 3.2.1+ does not. */
  broadcastsBattery: boolean;
  /** 2.6.6+ needs the 0xA0 0x1F mode-change write before handle 0x35 returns live data. */
  needsModeChange: boolean;
  advice: FirmwareAdvice | null;
}

/** Below this version the realtime data handle can be read without a mode change. */
export const MODE_CHANGE_MIN_VERSION = '2.6.6';
/** From this version on, battery is no longer included in advertisements. */
export const NO_BATTERY_BROADCAST_VERSION = '3.2.1';
/** Versions some users have reported as unreliable. */
export const FLAKY_VERSIONS = ['3.2.4'];

export const UPDATE_STEPS: readonly string[] = [
  'Install the official "Flower Care" app by HHCC on your phone.',
  'Make sure the app has internet access (use mobile data if your home network blocks it).',
  'Hold the phone within about 10 cm of the sensor.',
  'Add the sensor in the app and wait for it to sync.',
  'Accept the firmware update prompt and keep the phone close until it finishes.',
  'Remove the sensor from the app again so it does not compete with the Pi for the sensor.',
];

export const UPDATE_WARNINGS: readonly string[] = [
  'Firmware updates cannot be reverted.',
  'Some users have reported firmware 3.2.4 behaving flakily, so the very latest version is not necessarily better.',
];

export function parseFirmware(raw: string | null | undefined): FirmwareVersion | null {
  if (!raw) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: m[0] };
}

/** Returns <0, 0 or >0 like a sort comparator. */
export function compareFirmware(a: FirmwareVersion, b: FirmwareVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function atLeast(v: FirmwareVersion, min: string): boolean {
  return compareFirmware(v, parseFirmware(min)!) >= 0;
}

/** Unknown firmware is treated as needing the mode change: the write is harmless on old versions. */
export function needsModeChange(raw: string | null | undefined): boolean {
  const v = parseFirmware(raw);
  return v ? atLeast(v, MODE_CHANGE_MIN_VERSION) : true;
}

export function broadcastsReadings(raw: string | null | undefined): boolean {
  const v = parseFirmware(raw);
  return v ? v.major >= 3 : false;
}

export function broadcastsBattery(raw: string | null | undefined): boolean {
  const v = parseFirmware(raw);
  return v ? v.major >= 3 && !atLeast(v, NO_BATTERY_BROADCAST_VERSION) : false;
}

export function describeFirmware(raw: string | null | undefined): FirmwareInfo {
  const v = parseFirmware(raw);
  if (!v) {
    return {
      version: null,
      family: 'unknown',
      broadcastsReadings: false,
      broadcastsBattery: false,
      needsModeChange: true,
      advice: null,
    };
  }
  let advice: FirmwareAdvice | null = null;
  if (v.major < 3) {
    advice = {
      level: 'update-recommended',
      title: `Firmware ${v.raw}: consider updating to 3.x`,
      message:
        'Firmware 3.x broadcasts readings passively, so the Pi does not need to connect to the sensor. ' +
        'That is more reliable and saves battery.',
    };
  } else if (FLAKY_VERSIONS.includes(v.raw)) {
    advice = {
      level: 'caution',
      title: `Firmware ${v.raw}: reported as flaky`,
      message: 'Some users have reported this version behaving flakily. If readings drop out, that may be why.',
    };
  }
  return {
    version: v.raw,
    family: `${v.major}.x`,
    broadcastsReadings: v.major >= 3,
    broadcastsBattery: broadcastsBattery(v.raw),
    needsModeChange: needsModeChange(v.raw),
    advice,
  };
}
