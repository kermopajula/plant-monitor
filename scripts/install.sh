#!/usr/bin/env bash
# Plant Monitor installer for Raspberry Pi OS.
#
# Sets up everything: system packages, Node.js, Bluetooth, permissions,
# dependencies, build, .env, PM2 and start-at-boot. Safe to run again at any
# time, e.g. after `git pull` or a Node upgrade.
#
# Usage:  ./scripts/install.sh [--yes] [--skip-tests]
#   --yes         don't ask questions (use defaults, keep existing .env values)
#   --skip-tests  don't run the unit tests

set -euo pipefail

ASSUME_YES=0
RUN_TESTS=1
for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=1 ;;
    --skip-tests) RUN_TESTS=0 ;;
    -h | --help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
MIN_NODE_MAJOR=22
INTERACTIVE=0
if [[ $ASSUME_YES -eq 0 && -t 0 ]]; then INTERACTIVE=1; fi

# --- output helpers ---------------------------------------------------------

if [[ -t 1 ]]; then
  B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'
else
  B='' G='' Y='' R='' N=''
fi
STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%d] %s%s\n' "$B" "$STEP" "$*" "$N"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die() {
  printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2
  exit 1
}
trap 'die "Install failed at step $STEP (line $LINENO). Fix the problem above and run the script again; finished steps are skipped or repeated safely."' ERR

ask() { # ask "Question" "default" -> echoes answer
  local reply=''
  if [[ $INTERACTIVE -eq 1 ]]; then read -r -p "  $1 " reply </dev/tty || true; fi
  printf '%s' "${reply:-$2}"
}
confirm() { # confirm "Question" -> 0 for yes (default yes)
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ $INTERACTIVE -eq 0 ]] && return 1
  local r
  r="$(ask "$1 [Y/n]" y)"
  [[ "$r" =~ ^[Yy] ]]
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Reads/writes KEY=value lines in .env without breaking on special characters.
env_get() { node -e 'const fs=require("fs");const m=fs.readFileSync(".env","utf8").match(new RegExp("^"+process.argv[1]+"=(.*)$","m"));process.stdout.write(m?m[1].trim():"")' "$1"; }
env_set() {
  node -e '
    const fs = require("fs");
    const [key, value] = process.argv.slice(1);
    let s = fs.readFileSync(".env", "utf8");
    const re = new RegExp("^#?\\s*" + key + "=.*$", "m");
    s = re.test(s) ? s.replace(re, () => key + "=" + value) : s.replace(/\n?$/, "\n" + key + "=" + value + "\n");
    fs.writeFileSync(".env", s);' "$1" "$2"
}

# --- 0. sanity checks -------------------------------------------------------

printf '%s🪴 Plant Monitor installer%s  (%s)\n' "$B" "$N" "$APP_DIR"

[[ "$(uname -s)" == Linux ]] || die "This script is for Raspberry Pi OS (Linux)."
if [[ $EUID -eq 0 ]]; then
  die "Run this as your normal user (e.g. pi), not with sudo. It asks for sudo itself where needed, and PM2 must run as your user."
fi
command -v sudo >/dev/null || die "sudo is required."
command -v apt-get >/dev/null || die "apt-get not found: this script supports Raspberry Pi OS / Debian."
if ! grep -qi 'raspberry' /proc/device-tree/model 2>/dev/null; then
  warn "This does not look like a Raspberry Pi. Continuing anyway."
fi
echo "  Some steps need administrator rights; enter your password if sudo asks."
sudo -v

# --- 1. system packages -----------------------------------------------------

step "System packages (Bluetooth, build tools)"
PKGS=(bluetooth bluez libbluetooth-dev libudev-dev build-essential python3 libcap2-bin rfkill curl ca-certificates)
missing=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if ((${#missing[@]})); then
  echo "  Installing: ${missing[*]}"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
fi
ok "packages installed"

# --- 2. Node.js -------------------------------------------------------------

step "Node.js ${MIN_NODE_MAJOR}+"
if [[ "$(node_major)" -lt $MIN_NODE_MAJOR ]]; then
  current="$(command -v node >/dev/null && node -v || echo none)"
  node_path="$(command -v node || true)"
  if [[ -n "$node_path" && "$node_path" == "$HOME"/* ]]; then
    die "Node $current comes from a version manager (nvm?). Install Node ${MIN_NODE_MAJOR}+ with it, e.g. 'nvm install ${MIN_NODE_MAJOR} && nvm alias default ${MIN_NODE_MAJOR}', then run this script again."
  fi
  if [[ "$(uname -m)" == armv6l ]]; then
    die "Node $current is too old, and this Pi (ARMv6: Pi 1 / Zero / Zero W) has no official Node ${MIN_NODE_MAJOR} packages. Install an unofficial build from https://unofficial-builds.nodejs.org, then run this script again."
  fi
  confirm "Node.js is $current; this app needs ${MIN_NODE_MAJOR}+. Install Node ${MIN_NODE_MAJOR} LTS from NodeSource now?" ||
    die "Node.js ${MIN_NODE_MAJOR}+ is required."
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  hash -r
  [[ "$(node_major)" -ge $MIN_NODE_MAJOR ]] || die "Node.js install did not work (found $(node -v 2>/dev/null || echo none))."
fi
ok "node $(node -v) ($(command -v node))"

if ! command -v pm2 >/dev/null; then
  echo "  Installing PM2"
  if [[ -w "$(npm prefix -g)/lib" ]]; then npm install -g pm2 >/dev/null; else sudo npm install -g pm2 >/dev/null; fi
  hash -r
fi
ok "pm2 $(pm2 --version 2>/dev/null | tail -n1)"

# --- 3. Bluetooth -----------------------------------------------------------

step "Bluetooth adapter"
# (Subshells keep messages from missing tools/hardware out of the output.)
(sudo rfkill unblock bluetooth) >/dev/null 2>&1 || true
(sudo systemctl enable --now bluetooth) >/dev/null 2>&1 || warn "could not start the bluetooth service"
if [[ -e /sys/class/bluetooth/hci0 ]]; then
  (sudo hciconfig hci0 up || true) >/dev/null 2>&1
  (timeout 10 bluetoothctl power on || true) >/dev/null 2>&1
  ok "hci0 present and switched on"
else
  warn "No Bluetooth adapter (hci0) found. Is Bluetooth disabled in /boot/firmware/config.txt (dtoverlay=disable-bt)?"
fi

# --- 4. app dependencies & build -------------------------------------------

step "App dependencies and build (native modules may take a few minutes on a Pi)"
# Reinstall only when the lockfile or Node version changed (rebuilding native modules is slow on a Pi).
STAMP="$(sha256sum <package-lock.json | cut -c1-16)-$(node -v)"
if [[ "$(cat node_modules/.install-stamp 2>/dev/null)" == "$STAMP" ]]; then
  ok "dependencies up to date"
else
  npm ci --no-audit --no-fund --loglevel=error
  echo "$STAMP" >node_modules/.install-stamp
  ok "dependencies installed"
fi
npm run build --silent
ok "built into dist/"
if [[ $RUN_TESTS -eq 1 ]]; then
  npm test --silent >/tmp/plant-monitor-tests.log 2>&1 || die "Unit tests failed, see /tmp/plant-monitor-tests.log"
  ok "unit tests pass"
fi

# --- 5. Bluetooth permission for Node --------------------------------------

step "Bluetooth permission for Node (raw HCI access without root)"
NODE_BIN="$(readlink -f "$(command -v node)")"
if getcap "$NODE_BIN" 2>/dev/null | grep -q cap_net_raw; then
  ok "already set on $NODE_BIN"
else
  sudo setcap cap_net_raw,cap_net_admin+eip "$NODE_BIN"
  getcap "$NODE_BIN" | grep -q cap_net_raw || die "setcap did not work on $NODE_BIN"
  ok "granted cap_net_raw,cap_net_admin to $NODE_BIN"
fi

# --- 6. configuration (.env) -----------------------------------------------

step "Configuration (.env)"
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "created .env from .env.example"
fi
chmod 600 .env # holds API keys
mkdir -p data

PORT="$(env_get PORT)"
PORT="${PORT:-3000}"
HOSTNAME_LOCAL="$(hostname).local"
if [[ -z "$(env_get DASHBOARD_URL)" ]]; then
  env_set DASHBOARD_URL "http://${HOSTNAME_LOCAL}:${PORT}"
  ok "DASHBOARD_URL=http://${HOSTNAME_LOCAL}:${PORT} (link used in notifications)"
fi

if [[ -z "$(env_get PLANTBOOK_API_KEY)" ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    echo "  Species search needs a free Open Plant Book key: sign up at https://open.plantbook.io → API keys."
    key="$(ask "Paste your Open Plant Book API key (Enter to skip, add it to .env later):" "")"
    if [[ -n "$key" ]]; then env_set PLANTBOOK_API_KEY "$key"; ok "Open Plant Book key saved"; fi
  fi
  [[ -n "$(env_get PLANTBOOK_API_KEY)" ]] || warn "No Open Plant Book key yet: species search is off until you set PLANTBOOK_API_KEY in .env (re-run this script or 'pm2 restart plant-web --update-env')."
else
  ok "Open Plant Book key is set"
fi

if [[ -z "$(env_get NTFY_URL)$(env_get WEBHOOK_URL)$(env_get RESEND_API_KEY)" ]]; then
  if [[ $INTERACTIVE -eq 1 ]] && confirm "Set up phone notifications with ntfy (free app, no account needed)?"; then
    topic="plants-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    env_set NTFY_URL "https://ntfy.sh/${topic}"
    ok "NTFY_URL=https://ntfy.sh/${topic}"
    echo "    Install the ntfy app on your phone and subscribe to the topic: ${B}${topic}${N}"
    echo "    (Keep it private: anyone who knows the topic can read it.)"
  else
    warn "Alerts are off. To enable them, set NTFY_URL, WEBHOOK_URL or RESEND_* in .env (see README → Alerts)."
  fi
else
  ok "alerts configured"
fi

# Validate the config the same way the app will, so typos show up now.
node -e 'require("./dist/src/config")' || die ".env has an invalid value (see the error above)."

# --- 7. PM2 ------------------------------------------------------------------

step "Start with PM2 and enable start at boot"
START_MS="$(date +%s%3N)"
PM2_LOG=/tmp/plant-monitor-pm2.log
pm2 startOrReload ecosystem.config.js --update-env >"$PM2_LOG" 2>&1 || die "PM2 could not start the app, see $PM2_LOG"
pm2 save >>"$PM2_LOG" 2>&1
ok "plant-collector and plant-web running"
PM2_BIN="$(command -v pm2)"
if systemctl is-enabled "pm2-${USER}" >/dev/null 2>&1; then
  ok "start at boot already enabled (pm2-${USER}.service)"
else
  sudo env "PATH=$PATH:$(dirname "$(command -v node)")" "$PM2_BIN" startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true
  if systemctl is-enabled "pm2-${USER}" >/dev/null 2>&1; then
    pm2 save >/dev/null
    ok "start at boot enabled (pm2-${USER}.service)"
  else
    warn "Could not enable start at boot. Run 'pm2 startup', run the command it prints, then 'pm2 save'."
  fi
fi

# --- 8. checks ---------------------------------------------------------------

step "Checking that everything works"
web_ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/settings" >/dev/null 2>&1; then web_ok=1 && break; fi
  sleep 1
done
if [[ $web_ok -eq 1 ]]; then ok "dashboard responds on port ${PORT}"; else warn "dashboard did not respond yet, check: pm2 logs plant-web"; fi

# The collector records its state (with a timestamp) in the database; the API exposes it.
ble_state="waiting"
for _ in $(seq 1 45); do
  ble_state="$(curl -fsS "http://127.0.0.1:${PORT}/api/settings" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = s ? JSON.parse(s).collector : null;
      if (!c || c.at < Number(process.argv[1])) return console.log("waiting");
      console.log(c.state === "error" ? "error: " + c.error : "ok");
    });' "$START_MS" 2>/dev/null || echo waiting)"
  [[ "$ble_state" == waiting ]] || break
  sleep 1
done
case "$ble_state" in
  ok) ok "collector is using the Bluetooth adapter" ;;
  error*) warn "collector has a Bluetooth problem (${ble_state#error: }). See: pm2 logs plant-collector, README → Troubleshooting" ;;
  *) warn "collector has not reported yet, check: pm2 logs plant-collector" ;;
esac

trap - ERR
SCAN_SECONDS="$(env_get SCAN_SECONDS)"
SCAN_SECONDS="${SCAN_SECONDS:-90}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

${G}${B}Done!${N} Open the dashboard on your phone (same Wi-Fi):

    http://${HOSTNAME_LOCAL}:${PORT}${IP:+   or   http://${IP}:${PORT}}

Next: go to ${B}Setup${N}, press ${B}Scan now${N} and add your sensors. The first scan takes about ${SCAN_SECONDS} s.

Useful commands:
    pm2 status                     what is running
    pm2 logs plant-collector       Bluetooth / sensor logs
    nano .env                      settings, then: pm2 restart all --update-env
    git pull && ./scripts/install.sh   update (safe to re-run any time)
EOF
