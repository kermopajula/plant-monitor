// Read-only diagnostics for one sensor: prints its advertisement, every GATT
// service/characteristic (reading the readable ones) and the raw handles that
// return data. Nothing is written to the sensor.
//
// Run via `npm run inspect -- <MAC>` (scripts/inspect.sh pauses the collector,
// since only one program can use the Bluetooth adapter at a time).

import '../config'; // loads .env (e.g. NOBLE_HCI_DEVICE_ID) before noble starts
import { isMiFlora, normalizeMac, parseMiBeacon, XIAOMI_SERVICE_UUID } from '../lib/miflora';
import { errorMessage, withTimeout } from '../lib/retry';
import noble = require('@abandonware/noble');

const target = process.argv[2] ? normalizeMac(process.argv[2]) : null;
const SCAN_MS = 30_000;

const hex = (b: Buffer) => b.toString('hex').replace(/(..)/g, '$1 ').trim();
const ascii = (b: Buffer) => b.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
const show = (b: Buffer) => (b.length ? `${hex(b)}  |${ascii(b)}|  (${b.length} bytes)` : '(empty)');

async function poweredOn() {
  if (noble._state === 'poweredOn') return;
  await withTimeout(
    new Promise<void>((resolve) => noble.on('stateChange', (s) => s === 'poweredOn' && resolve())),
    15_000,
    'waiting for the Bluetooth adapter',
  );
}

function printAdvert(p: noble.Peripheral) {
  const a = p.advertisement;
  console.log(`\n== Advertisement of ${normalizeMac(p.address)} ==`);
  console.log(`name:          ${a.localName ?? '(none)'}`);
  console.log(`rssi:          ${p.rssi} dBm   connectable: ${p.connectable}   address type: ${p.addressType}`);
  console.log(`service uuids: ${(a.serviceUuids ?? []).join(', ') || '(none)'}`);
  for (const sd of a.serviceData ?? []) {
    console.log(`service data:  ${sd.uuid}: ${hex(sd.data)}`);
    if (sd.uuid.toLowerCase() === XIAOMI_SERVICE_UUID) {
      const b = parseMiBeacon(sd.data);
      if (b) {
        console.log(
          `  MiBeacon:    product 0x${b.productId.toString(16).padStart(4, '0')}, frame control 0x${sd.data.readUInt16LE(0).toString(16)}, ` +
            `encrypted ${b.encrypted}, values ${JSON.stringify(b.values)}`,
        );
      }
    }
  }
  if (a.manufacturerData) console.log(`manufacturer:  ${hex(a.manufacturerData)}`);
}

async function findPeripheral(): Promise<noble.Peripheral | null> {
  const seen = new Map<string, noble.Peripheral>();
  return new Promise((resolve) => {
    const done = (p: noble.Peripheral | null) => {
      clearTimeout(timer);
      noble.removeListener('discover', onDiscover);
      noble.stopScanningAsync().finally(() => resolve(p));
    };
    const onDiscover = (p: noble.Peripheral) => {
      const mac = normalizeMac(p.address);
      if (target) {
        if (mac === target) done(p);
      } else if (isMiFlora({ address: mac, localName: p.advertisement.localName, serviceData: p.advertisement.serviceData }) && !seen.has(mac)) {
        seen.set(mac, p);
        console.log(`found ${mac}  ${p.advertisement.localName ?? ''}  ${p.rssi} dBm`);
      }
    };
    const timer = setTimeout(() => {
      if (!target) console.log(seen.size ? '\nRun again with one of these MACs for details.' : 'No Mi Flora sensors heard.');
      done(null);
    }, SCAN_MS);
    noble.on('discover', onDiscover);
    noble.startScanningAsync([], true).catch((err) => {
      console.error(`scan failed: ${errorMessage(err)}`);
      done(null);
    });
  });
}

async function main() {
  await poweredOn();
  console.log(target ? `Scanning up to ${SCAN_MS / 1000} s for ${target}...` : `Scanning ${SCAN_MS / 1000} s for Mi Flora sensors...`);
  const p = await findPeripheral();
  if (!p) {
    if (target) console.log(`${target} was not heard. Move it closer to the Pi and try again.`);
    return;
  }
  printAdvert(p);

  console.log('\n== Connecting ==');
  await withTimeout(p.connectAsync(), 20_000, 'connect');
  try {
    console.log('connected');
    console.log('\n== GATT services and characteristics ==');
    try {
      const { services } = await withTimeout(p.discoverAllServicesAndCharacteristicsAsync(), 30_000, 'discover services');
      if (!services.length) console.log('(no services)');
      for (const sv of services) {
        console.log(`service ${sv.uuid}${sv.name ? ` (${sv.name})` : ''}`);
        for (const c of sv.characteristics ?? []) {
          let value = '';
          if (c.properties.includes('read')) {
            value = await withTimeout(c.readAsync(), 5_000, 'read')
              .then(show)
              .catch((err) => `read failed: ${errorMessage(err)}`);
          }
          console.log(`  char ${c.uuid.padEnd(32)} [${c.properties.join(', ')}] ${value}`);
        }
      }
    } catch (err) {
      console.log(`discovery failed: ${errorMessage(err)}`);
    }

    console.log('\n== Raw handles 0x01-0x60 that return data ==');
    let any = false;
    for (let h = 0x01; h <= 0x60; h++) {
      try {
        const buf = await withTimeout(p.readHandleAsync(h), 3_000, 'read');
        if (buf.length) {
          any = true;
          console.log(`  0x${h.toString(16).padStart(2, '0')}: ${show(buf)}`);
        }
      } catch {
        /* unreadable or timed out */
      }
      if (p.state !== 'connected') {
        console.log(`  (sensor disconnected at handle 0x${h.toString(16)})`);
        break;
      }
    }
    if (!any) console.log('  (none)');
  } finally {
    await withTimeout(p.disconnectAsync(), 5_000, 'disconnect').catch(() => undefined);
  }
  console.log('\nDone. Nothing was written to the sensor.');
}

main()
  .catch((err) => {
    console.error(`\nError: ${errorMessage(err)}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 200));
