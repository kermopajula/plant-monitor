# 🪴 Plant Monitor

A self-hosted monitor for Xiaomi **Mi Flora (HHCCJCY01)** plant sensors, running on a Raspberry Pi with its
built-in Bluetooth. No Home Assistant, no cloud. It has two parts:

- **Collector**: finds the sensors and reads moisture, fertility (conductivity), light, temperature and battery
  on an interval (20 minutes by default).
- **Dashboard**: a phone-friendly web page with one card per plant. Each card shows current values against the
  plant's ideal ranges, a status, battery, firmware and 7/30-day charts. There are also setup pages and optional
  alerts.

```
            BLE adverts / GATT                     SQLite (WAL)                 HTTP :3000
Mi Flora ─────────────────────▶ plant-collector ───────────────▶ plants.db ◀──────────── plant-web ◀── phone
                                 (PM2 process)                               (PM2 process: dashboard,
                                                                              setup, API, alerts)
```

## Contents

- [Hardware & OS prerequisites](#hardware--os-prerequisites)
- [Install](#install)
- [Bluetooth permissions for Node](#bluetooth-permissions-for-node)
- [Configuration (.env)](#configuration-env)
- [Open Plant Book API key](#open-plant-book-api-key)
- [Run with PM2](#run-with-pm2)
- [Using it](#using-it)
- [Sensor firmware](#sensor-firmware)
- [How readings are collected](#how-readings-are-collected)
- [Alerts](#alerts)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Library choices](#library-choices)

## Hardware & OS prerequisites

- A Raspberry Pi with built-in Bluetooth (Pi 3/4/5, Zero W/2 W) running Raspberry Pi OS.
- One or more Mi Flora sensors in Bluetooth range (one room is fine; walls and distance shorten the range).
- **Node.js 22 LTS or newer.** Check with `node -v`. The SQLite driver needs Node 22 or newer.
- Build tools and Bluetooth headers. The BLE and SQLite libraries are native modules. Prebuilt binaries usually
  exist; when they don't, these packages let them compile:

```bash
sudo apt update
sudo apt install -y bluetooth bluez libbluetooth-dev libudev-dev build-essential python3
```

## Install

**One command.** Log in to the Pi as your normal user (not root) and run:

```bash
git clone https://github.com/kermopajula/plant-monitor.git ~/plant-monitor
cd ~/plant-monitor
./scripts/install.sh
```

The script takes a few minutes the first time, mostly compiling the Bluetooth and SQLite modules. It does
everything in the sections below for you:

1. Installs the system packages (BlueZ, Bluetooth headers, build tools, `setcap`).
2. Checks for Node.js 22+. If it is missing or older, it offers to install Node 22 LTS. It installs PM2 if needed.
3. Unblocks and switches on the Bluetooth adapter.
4. Installs the dependencies, builds the app and runs the unit tests.
5. Gives Node permission to use Bluetooth without root (`setcap`, see below).
6. Creates `.env` (only readable by you) and asks for your Open Plant Book key. It can also set up phone alerts
   with a private ntfy topic.
7. Starts both processes with PM2 and enables start at boot (`pm2 startup` + `pm2 save`).
8. Checks that the dashboard answers and the collector can use Bluetooth, then prints the dashboard address.

**Run it again any time.** It is safe to re-run: finished steps are skipped, and your `.env` is kept. Re-run it
after `git pull` (to update), after a Node upgrade (to restore the Bluetooth permission), or when something is
not working: the checks at the end tell you what is wrong. A re-run takes about 15 seconds when nothing changed.

Options: `--yes` asks no questions (for scripted installs), `--skip-tests` skips the unit tests, `--help`.

The script supports Raspberry Pi OS (and other Debian-based systems with `apt`). Two cases need a manual step,
and the script stops with instructions:
- If Node comes from **nvm**, update it with nvm (`nvm install 22`).
- **Pi 1 and Pi Zero/Zero W (ARMv6)** need an unofficial Node build.

### Manual install

If you prefer to do it by hand, these are the steps the script performs:

```bash
sudo apt install -y bluetooth bluez libbluetooth-dev libudev-dev build-essential python3 libcap2-bin
npm ci
npm run build
npm test                 # optional
sudo setcap cap_net_raw,cap_net_admin+eip $(eval readlink -f $(which node))
cp .env.example .env && chmod 600 .env
nano .env                # at least set PLANTBOOK_API_KEY, see below
pm2 start ecosystem.config.js
pm2 startup              # run the command it prints
pm2 save
```

The sections below explain each part.

## Bluetooth permissions for Node

The collector talks to the Bluetooth controller (HCI) directly. Raw HCI access needs root, unless you give the
`node` binary the network capability:

```bash
sudo setcap cap_net_raw,cap_net_admin+eip $(eval readlink -f $(which node))
```

The install script does this for you, and so does `npm run setcap`.

- `readlink -f` resolves symlinks. That matters with nvm or `/usr/bin/node` links, because the capability has to
  be on the real binary.
- **Run it again after every Node upgrade.** A new binary has no capability.
- `cap_net_raw` is the one noble needs. `cap_net_admin` avoids permission errors on some systems when the
  adapter is configured.
- Check it with `getcap $(eval readlink -f $(which node))`.

Make sure Bluetooth is not blocked and the adapter is up:

```bash
rfkill list bluetooth        # "Soft blocked: no"; if yes: sudo rfkill unblock bluetooth
sudo hciconfig hci0 up
```

Leave the system `bluetoothd` running. noble works alongside it. If the adapter keeps getting reset, see
[Troubleshooting](#troubleshooting).

## Configuration (.env)

Both processes read `.env` from the project directory. Every setting is documented in
[`.env.example`](.env.example). The main ones:

| Variable | Default | Meaning |
|---|---|---|
| `PLANTBOOK_API_KEY` | – | Open Plant Book token, used for species search |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the dashboard listens |
| `READ_INTERVAL_MINUTES` | `20` | Default interval (can be changed on the setup page) |
| `SCAN_SECONDS` | `90` | How long each scan listens for advertisements |
| `BATTERY_READ_HOURS` | `24` | How often to connect for battery/firmware |
| `NTFY_URL`, `WEBHOOK_URL`, `RESEND_*` | – | Alert channels (optional); email is a daily digest |
| `ALERT_AFTER_MINUTES` | `120` | How long a value must stay out of range before an alert |
| `DB_PATH` | `data/plants.db` | SQLite database file |

Restart after changing `.env`: `pm2 restart ecosystem.config.js --update-env`.

## Open Plant Book API key

Species names and ideal ranges come from [Open Plant Book](https://open.plantbook.io):

1. Create a free account at <https://open.plantbook.io>.
2. Open your profile's **API keys** section and generate a key (token).
3. Put it in `.env`: `PLANTBOOK_API_KEY=your-token`, then restart `plant-web`.

Each species is cached in the database after you pick it, so the API is only called while you search and assign
species. Without a key everything else still works: you can enter ideal ranges by hand on the setup page, and
until you set ranges, generic houseplant defaults are used.

## Run with PM2

```bash
npm run build
pm2 start ecosystem.config.js   # starts plant-collector and plant-web
pm2 status
pm2 logs                        # or: npm run logs
```

To start everything at boot:

```bash
pm2 startup     # prints a "sudo env PATH=... pm2 startup ..." command: copy and run it
pm2 save        # saves the current process list so it comes back after a reboot
```

Run `pm2 save` again whenever you add or remove PM2 processes.

To update after a `git pull`: `npm ci && npm run build && pm2 reload ecosystem.config.js`.

The collector deliberately **exits** when the Bluetooth adapter disappears or a cycle hangs for more than
15 minutes. PM2 then restarts it with exponential backoff. That is more reliable than trying to recover a wedged
BLE stack in-process.

## Using it

Open `http://<pi-address>:3000` on your phone, e.g. `http://raspberrypi.local:3000`. Add it to your home screen
for an app-like icon.

1. **Setup → New sensors.** Sensors heard by the Pi show up here with their MAC address and signal strength.
   Press **Scan now** if one is missing. Holding the sensor near the Pi helps if it is far away.
2. Give each sensor a **name** (e.g. "Monstera in the living room") and press **Add**.
3. **Search a species** (e.g. "monstera") and pick a result. Its ideal min/max moisture, conductivity, light and
   temperature are filled in automatically. You can edit them afterwards.
4. Adjust the **read interval** and **alert delay** under *Settings* if you like.

The dashboard refreshes every minute. A plant's status is one of **OK**, **Needs water**, **Needs fertilizer**,
**Too dark**, **Too bright**, **Too cold** or **Too hot**. Two extras cover the opposite ends: **Too wet** and
**Too much fertilizer**. A plant shows **No recent data** after missing about three reads.

> **Light is judged on the brightest reading of the last 24 hours**, not the current value. Otherwise every
> plant would be "too dark" at night. The card shows both values.

**Security:** the dashboard has no login. It is meant for your home network only, so do not port-forward it to
the internet. Write requests must be JSON, so other websites you visit cannot change your settings through your
browser.

## Sensor firmware

The firmware version is read from each sensor and shown on its card and on the setup page.

**Firmware 2.x (or older):** the dashboard recommends updating to 3.x. Firmware 3.x **broadcasts its readings
passively**, so the Pi only has to listen and never connects. That is more reliable and saves battery. With 2.x
the Pi has to connect to the sensor for every reading.

**How to update** (only possible with the official app):

1. Install the official **"Flower Care"** app by **HHCC** on your phone.
2. Make sure the app has **internet access**. Use mobile data if your home network blocks it.
3. Hold the phone **within about 10 cm** of the sensor.
4. **Add the sensor** in the app and **wait for it to sync**.
5. **Accept the firmware update prompt** and keep the phone close until it finishes.
6. **Remove the sensor from the app** afterwards, so the phone does not compete with the Pi for the sensor.

> ⚠️ **Firmware updates cannot be reverted.**
> ⚠️ Some users have reported **firmware 3.2.4** behaving flakily, so updating to the very latest version is
> not necessarily better. The dashboard flags 3.2.4 sensors.

Firmware differences that matter here:

| Firmware | Readings | Battery |
|---|---|---|
| < 2.6.6 | Connect and read handle `0x35` directly | Handle `0x38` |
| 2.6.6 – 2.x | Connect, write `0xA0 0x1F` to handle `0x33`, then read `0x35` | Handle `0x38` |
| 3.0 – 3.2.0 | Broadcast (passive) | Broadcast |
| 3.2.1 + | Broadcast (passive) | **Not** broadcast: read via `0x38` about once a day |

## How readings are collected

Each cycle (every `interval` minutes):

1. **Passive scan** for up to `SCAN_SECONDS`. The collector listens to the Xiaomi MiBeacon advertisements
   (service data `0xFE95`). Each advertisement carries one value (temperature, light, moisture, conductivity or
   battery), so values are collected over the scan window. The scan stops early once every added sensor has
   reported all four.
2. **Active fallback.** A sensor that was heard but broadcast no readings (older firmware) gets a connection.
   The collector reads battery/firmware from handle `0x38`, writes the mode change `0xA0 0x1F` to handle `0x33`
   (firmware ≥ 2.6.6), then reads the 16-byte sensor data from handle `0x35`. Placeholder or implausible data is
   rejected.
3. **Daily device info.** If battery is older than `BATTERY_READ_HOURS` or the firmware is unknown, the collector
   connects once to read handle `0x38`. Passive-only sensors therefore get a connection about once a day.

All BLE operations have timeouts. Connections are retried `POLL_ATTEMPTS` times with backoff (2 s, 4 s, …) and
are always disconnected afterwards. A failure is stored on the sensor and shown on its card. A scan can also
yield only some of the four values; the reading is then stored as is, and the dashboard uses the newest value of
each metric.

Readings are stored in SQLite (`data/plants.db`) with timestamp, sensor MAC and source (`passive`/`active`).

## Alerts

Alerts are optional and pluggable. Set any of these in `.env` and restart `plant-web`:

- **ntfy**: `NTFY_URL=https://ntfy.sh/<a-hard-to-guess-topic>`, then subscribe to the same topic in the ntfy app.
  Add `NTFY_TOKEN` for protected or self-hosted servers.
- **Webhook**: `WEBHOOK_URL=https://hooks.slack.com/services/...`. Alerts are POSTed as `{"text": "...",
  "title": ..., "message": ..., "kind": ...}`, which works directly with Slack incoming webhooks.
- **Email via [Resend](https://resend.com)**, as a **daily digest**: create an API key in Resend and set
  `RESEND_API_KEY`, `RESEND_FROM` and `RESEND_TO` (comma-separated for several recipients). Instead of one email
  per alert, alerts are queued and sent **once a day** at `RESEND_DIGEST_TIME` (default `08:00`, in the Pi's
  time zone; check with `timedatectl`). The email lists every problem since the previous digest, grouped by
  plant, and says whether each one is still ongoing or resolved by now. No email is sent on days without new
  problems. If the Pi is off at that time, the digest goes out when it is back; if sending fails, it is retried
  every few minutes. `RESEND_FROM` must use a domain you have verified in Resend. For a quick test without a
  domain, `onboarding@resend.dev` works, but Resend then only delivers to your own account's email address.

How it behaves:

- A problem must last at least `ALERT_AFTER_MINUTES` (also editable on the setup page) before an alert is sent
  (ntfy/webhook) or queued for the next daily digest (email).
- **Each problem is notified once.** No repeats while it persists, even across restarts, because the state is
  stored in the database.
- A problem only counts as resolved after it has been fine for the same amount of time. That keeps a value
  hovering around a limit from alerting over and over. Set `ALERT_SEND_RESOLVED=true` to get a message when a
  problem is resolved.
- A sensor going silent produces a "No recent data" alert.
- Use **Send test alert** on the setup page to check the configuration. It sends right away on every channel,
  including email.

To add another channel, implement the `Notifier` interface in `src/lib/notifiers.ts` and register it in
`createNotifiers`.

## Troubleshooting

First try re-running `./scripts/install.sh`: it repairs packages, permissions and PM2, then reports what is still
wrong.

| Symptom | Things to check |
|---|---|
| Collector log says `waiting for Bluetooth adapter timed out` | `rfkill list`, `sudo hciconfig hci0 up`, `setcap` (see above), `NOBLE_HCI_DEVICE_ID` if you use a USB dongle |
| `EPERM` / `Operation not permitted` | Missing Bluetooth permission, e.g. after a Node upgrade: re-run `./scripts/install.sh` |
| `EAFNOSUPPORT, Address family not supported` | No Bluetooth adapter: check `ls /sys/class/bluetooth` and that `dtoverlay=disable-bt` is not in `/boot/firmware/config.txt` |
| Sensor never shows up | Move it closer, press **Scan now**, check its battery (CR2032). Close the Flower Care app on your phone: a connected phone stops the sensor from advertising |
| "Not heard during the last scan" | Range or battery. Increase `SCAN_SECONDS` if it only happens sometimes |
| "Active read failed: connect timed out" | Range/interference. The Pi's built-in radio shares its antenna with Wi‑Fi, so a wired Ethernet connection or a USB BLE dongle can help |
| Readings for some values are missing | 3.x sensors broadcast each value separately. A longer `SCAN_SECONDS` collects more of them per cycle |
| Collector shows "has not reported yet" on the setup page | `pm2 status`, `pm2 logs plant-collector` |
| Species search fails | `PLANTBOOK_API_KEY` set? Does the Pi have internet access? |

Set `DEBUG_LOG=true` for more verbose logs.

## Development

```bash
npm run build          # compile
npm test               # build + unit tests (node:test)
npm run demo           # create data/demo.db with fake sensors and 30 days of data
npm run demo:web       # dashboard on http://localhost:3001 using the demo database
npm run dev:web        # web server with the real database
npm run dev:collector  # collector in the foreground (needs Bluetooth)
```

The demo needs no Bluetooth, so you can work on the dashboard on any computer.

Project layout:

```
src/
  config.ts            env/.env handling
  db.ts                SQLite schema, migrations and queries
  plants.ts            builds the per-plant view (values, ranges, status, firmware)
  collector/
    index.ts           scan/poll cycle, scheduling, watchdog
    ble.ts             noble wrapper: scanning, connect + handle read/write
  web/
    index.ts           routes, static files
    http.ts            tiny router on node:http
    alerter.ts         periodic alert evaluation
  lib/                 pure logic (unit tested)
    miflora.ts         MiBeacon + GATT payload parsing
    firmware.ts        firmware detection and advice
    status.ts          range checks and plant status
    alerts.ts          alert de-duplication state machine
    digest.ts          daily email digest: schedule and aggregation
    plantbook.ts       Open Plant Book client
    notifiers.ts       ntfy, webhook, Resend email
    retry.ts           timeouts and retries
  tools/demo.ts        demo data generator
public/                dashboard + setup pages (plain HTML/JS/CSS, Chart.js)
test/                  unit tests
```

API (JSON): `GET /api/plants`, `GET /api/plants/:mac/history?days=7|30`, `GET /api/sensors`,
`PUT /api/sensors/:mac` (`adopted`, `name`, `species`, `ranges`), `POST /api/sensors/:mac/species` (`pid`),
`DELETE /api/sensors/:mac`, `GET /api/species/search?q=`, `GET|PUT /api/settings`, `POST /api/scan`,
`POST /api/alerts/test`.

## Library choices

| Need | Choice | Why |
|---|---|---|
| BLE | `@abandonware/noble` | Maintained noble fork. It talks HCI directly and supports reading/writing raw GATT handles, which the Mi Flora protocol needs |
| Storage | `better-sqlite3` | Synchronous, fast, zero-config. WAL mode lets the two processes share one file |
| Web server | **`node:http`** instead of Fastify/Express | There are only a few JSON routes and static files, which a ~100-line router covers. One less dependency tree to install and audit on the Pi |
| Charts | `chart.js` | Served from `node_modules` by the Pi itself, so the dashboard works without internet |
| `.env` | **`process.loadEnvFile`** (built into Node) instead of `dotenv` | No dependency needed |
| Tests | **`node:test`** instead of Jest/Vitest | Built into Node |
| TypeScript | `tsc` → CommonJS in `dist/` | PM2 runs plain JS, so no runtime transpiler is needed on the Pi |

Runtime dependencies: `@abandonware/noble`, `better-sqlite3`, `chart.js`. Dev: `typescript` and type packages.

`npm audit` reports advisories in `tar`, pulled in through noble's build-time helper `node-pre-gyp`. It is only
used when installing native modules from the npm registry, not at runtime.
