// Fills a database with fake sensors and 30 days of readings so the dashboard
// can be tried without hardware:  npm run demo  then  npm run demo:web
// Refuses to touch a database that already has sensors.

import { config } from '../config';
import { Store } from '../db';

const store = new Store(config.dbPath);
if (store.listSensors().length) {
  console.error(`${config.dbPath} already has sensors; refusing to add demo data. Set DB_PATH to a new file.`);
  process.exit(1);
}

const now = Date.now();
const DAY = 86400_000;
const STEP = 20 * 60_000;

const plants = [
  { mac: 'C4:7C:8D:6A:00:01', name: 'Monstera in the living room', species: 'Monstera deliciosa', fw: '3.2.1', battery: 87, dry: 1.4, light: 9000,
    ranges: { moisture: [15, 60], conductivity: [350, 2000], lux: [2500, 30000], temperature: [12, 32] } },
  { mac: 'C4:7C:8D:6A:00:02', name: 'Basil on the kitchen window', species: 'Ocimum basilicum', fw: '2.7.0', battery: 54, dry: 4.5, light: 30000,
    ranges: { moisture: [20, 60], conductivity: [350, 2000], lux: [4000, 70000], temperature: [10, 35] } },
  { mac: 'C4:7C:8D:6A:00:03', name: 'Fern in the hallway', species: 'Nephrolepis exaltata', fw: '3.2.4', battery: 12, dry: 2.2, light: 900,
    ranges: { moisture: [30, 70], conductivity: [300, 1500], lux: [1500, 20000], temperature: [12, 30] } },
];

const insert = store.db.transaction(() => {
  for (const [i, p] of plants.entries()) {
    store.markSeen(p.mac, now - 5 * 60_000, -60 - i * 8, 'Flower care');
    store.updateSensor(p.mac, {
      adopted: 1,
      name: p.name,
      species: p.species,
      ranges_source: 'custom',
      ranges: Object.fromEntries(Object.entries(p.ranges).map(([k, [min, max]]) => [k, { min, max }])) as never,
    });
    store.setDeviceInfo(p.mac, { battery: p.battery, firmware: p.fw }, now - 3 * 3600_000);
    store.setMode(p.mac, p.fw.startsWith('3') ? 'passive' : 'active');

    let moisture = 55;
    for (let t = now - 30 * DAY; t <= now - 5 * 60_000; t += STEP) {
      moisture -= (p.dry / 72) * (0.7 + Math.random() * 0.6);
      if (moisture < 14 + i * 4 && Math.random() < 0.02) moisture = 58 + Math.random() * 6; // watered
      const hour = new Date(t).getHours() + new Date(t).getMinutes() / 60;
      const sun = Math.max(0, Math.sin(((hour - 6) / 14) * Math.PI));
      const temperature = 19 + 3 * sun + Math.random() * 0.6;
      const lux = Math.round(p.light * sun * (0.6 + Math.random() * 0.5));
      const conductivity = Math.round(150 + moisture * 14 + Math.random() * 40);
      store.insertReading(p.mac, t, { temperature: Math.round(temperature * 10) / 10, moisture: Math.round(moisture), conductivity, lux }, 'demo');
    }
  }
  store.markSeen('C4:7C:8D:6A:00:99', now - 60_000, -88, 'Flower care');
});
insert();
console.log(`Demo data written to ${config.dbPath}`);
store.close();
