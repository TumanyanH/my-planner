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

# First run: create .env from the template.
if [ ! -f .env ]; then
  tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  sed -e "s|^TZ=.*|TZ=${tz:-UTC}|" .env.example > .env
  chmod 600 .env
  echo "Created .env"
  echo "  Timezone: ${tz:-UTC}   (edit TZ in .env if this is not where you live)"
  echo "  Edit .env now: set GOOGLE_CLIENT_ID and ALLOWED_EMAIL (see README.md), then run again."
  echo
  exit 0
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
