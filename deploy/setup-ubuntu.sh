#!/usr/bin/env bash
# Trenches Scanner — one-shot setup for Ubuntu 22.04 / 24.04 LTS.
#
# Run it from INSIDE the cloned repo, as your normal (sudo-capable) login user:
#     bash deploy/setup-ubuntu.sh
#
# It installs Node.js, the build tools better-sqlite3 needs, the app's
# dependencies, and a systemd service that runs the scanner 24/7 (auto-restart,
# starts on boot). It does NOT start the scanner — you add your .env first.
set -euo pipefail

# Use sudo for privileged steps unless we're already root.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
export DEBIAN_FRONTEND=noninteractive

# Service should run as the human who invoked this, never as root when avoidable.
RUN_USER="${SUDO_USER:-$(id -un)}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
NODE_MAJOR=22

echo "==> Trenches Scanner setup"
echo "    run as user: $RUN_USER"
echo "    app dir:     $APP_DIR"
echo ""

# --- 1. base packages: git, curl, and the toolchain better-sqlite3 compiles with ---
echo "==> Installing base packages..."
$SUDO apt-get update -y
$SUDO apt-get install -y ca-certificates curl gnupg git build-essential python3

# --- 2. Node.js >= 20 via NodeSource (skip if a recent enough node is already here) ---
need_node=1
if command -v node >/dev/null 2>&1; then
  cur_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$cur_major" -ge 20 ]; then need_node=0; echo "==> Node $(node -v) already installed — keeping it"; fi
fi
if [ "$need_node" -eq 1 ]; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x from NodeSource..."
  if [ -n "$SUDO" ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  fi
  $SUDO apt-get install -y nodejs
fi
echo "    using node $(node -v), npm $(npm -v)"

# --- 3. install app dependencies as RUN_USER (so node_modules isn't root-owned) ---
echo "==> Installing app dependencies (npm install)..."
if [ "$(id -u)" -eq 0 ] && [ "$RUN_USER" != "root" ]; then
  $SUDO -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm install"
else
  ( cd "$APP_DIR" && npm install )
fi

# --- 4. write the systemd service ---
echo "==> Installing systemd service 'trenches-scanner'..."
NPM_BIN="$(command -v npm)"
$SUDO tee /etc/systemd/system/trenches-scanner.service >/dev/null <<UNIT
[Unit]
Description=Trenches Scanner - Pump.fun token scanner -> Telegram
After=network-online.target
Wants=network-online.target
# Never stop retrying: a trading scanner should always try to come back.
StartLimitIntervalSec=0

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NPM_BIN} start
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_ENV=production
Restart=always
RestartSec=10
# The app already handles SIGINT for a clean shutdown (closes DB + socket).
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable trenches-scanner >/dev/null 2>&1

echo ""
echo "=================================================================="
echo " Setup complete. Two steps left:"
echo ""
if [ ! -f "$APP_DIR/.env" ]; then
  echo " 1) Create your .env and paste in your 4 keys:"
  echo "      cp $APP_DIR/.env.example $APP_DIR/.env"
  echo "      nano $APP_DIR/.env"
else
  echo " 1) .env already exists — double-check your keys in it:"
  echo "      nano $APP_DIR/.env"
fi
echo ""
echo " 2) Start it (runs 24/7 and restarts on boot):"
echo "      $SUDO systemctl start trenches-scanner"
echo "      journalctl -u trenches-scanner -f     # watch it live (Ctrl+C to stop watching)"
echo "=================================================================="
