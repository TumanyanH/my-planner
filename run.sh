#!/usr/bin/env bash
# Planner runner. Usage:
#   ./run.sh          run with Node on this machine (development, or a VPS without Docker)
#   ./run.sh docker   build and run in Docker, reachable only from this machine (127.0.0.1)
#   ./run.sh https    Docker + Caddy with automatic HTTPS (needs DOMAIN in .env)
#   ./run.sh stop     stop the Docker containers
#   ./run.sh logs     follow the Docker logs
#   ./run.sh test     run the server tests
set -euo pipefail
cd "$(dirname "$0")"

# First run: create .env with a random password.
if [ ! -f .env ]; then
  pass="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)"
  tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  sed -e "s|^PLANNER_PASSWORD=.*|PLANNER_PASSWORD=${pass}|" -e "s|^TZ=.*|TZ=${tz:-UTC}|" .env.example > .env
  chmod 600 .env
  echo "Created .env"
  echo "  Password: ${pass}"
  echo "  Timezone: ${tz:-UTC}   (edit TZ in .env if this is not where you live)"
  echo
fi

mkdir -p data
export PUID="$(id -u)" PGID="$(id -g)"

case "${1:-node}" in
  node)
    command -v node >/dev/null || { echo "Node.js is not installed. Install Node 24+ or use: ./run.sh docker"; exit 1; }
    major="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$major" -ge 24 ] || { echo "Node 24 or newer is required (found $(node -v))."; exit 1; }
    set -a; . ./.env; set +a
    exec node server/server.js
    ;;
  docker) docker compose up -d --build; docker compose ps ;;
  https)
    grep -Eq '^DOMAIN=.+' .env || { echo "Set DOMAIN=your.domain in .env first (it must point at this server)."; exit 1; }
    docker compose --profile https up -d --build; docker compose --profile https ps
    ;;
  stop) docker compose --profile https down ;;
  logs) docker compose --profile https logs -f ;;
  test) exec node --test server/ ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
