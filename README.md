# Planner

A personal task manager: tasks with importance levels, repeating tasks, snooze and
quick actions, and a log of every interaction for a future agent to learn from.

This repository currently contains the **web app** and the **server**. Telegram, voice
notes, phone push notifications and calendar sync are not built yet (see [Roadmap](#roadmap)).

## Quick start

```bash
./run.sh
```

The first run creates `.env` with a random password and prints it. Then open
<http://localhost:8080> and sign in. Requires Node.js 24 or newer; nothing to install.

| Command           | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `./run.sh`        | Run with Node on this machine                                       |
| `./run.sh docker` | Build and run in Docker, reachable from this machine only           |
| `./run.sh https`  | Docker plus Caddy with automatic HTTPS (needs `DOMAIN` in `.env`)   |
| `./run.sh stop`   | Stop the Docker containers                                          |
| `./run.sh logs`   | Follow the Docker logs                                              |
| `./run.sh test`   | Run the server tests                                                |

## Configuration (`.env`)

| Variable           | Default     | Meaning                                                                                 |
| ------------------ | ----------- | --------------------------------------------------------------------------------------- |
| `PLANNER_PASSWORD` | (generated) | Password for the web app, 8+ characters. Changing it signs every device out.            |
| `TZ`               | system zone | Your timezone as an IANA name, e.g. `Europe/Berlin`. See the note below.                |
| `PORT`             | `8080`      | Port the app listens on.                                                                |
| `BIND`             | `127.0.0.1` | Docker only: address the port is published on.                                          |
| `DOMAIN`           | empty       | `./run.sh https` only: domain name pointing at the server.                              |
| `DATA_DIR`         | `./data`    | Where the database lives (Node mode; Docker always uses `./data`).                      |
| `COOKIE_SECURE`    | unset       | Set to `1` to force HTTPS-only cookies when your proxy does not send `X-Forwarded-Proto`. |

**Set `TZ` to where you live, not where the server is.** "Tomorrow" and repeating tasks
are calculated on the server in this timezone. A VPS is usually on UTC, so a fresh `.env`
created there will say `TZ=UTC` until you change it.

## Deploying on an Oracle Cloud VPS

HTTPS matters here: the password and session cookie travel with every request, and an
iPhone home-screen app needs a secure origin. The `https` mode handles certificates for you.

1. **Point a domain at the VPS.** Any domain or free subdomain (for example DuckDNS) with
   an A record to the instance's public IP.
2. **Open ports 80 and 443 in Oracle's network.** In the Oracle console: instance → subnet →
   security list → add ingress rules for TCP 80 and TCP 443 from `0.0.0.0/0`.
3. **Install Docker and get the code onto the server:**
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER     # then log out and back in
   git clone <your repo url> planner && cd planner
   ```
4. **Configure and start:**
   ```bash
   ./run.sh test          # optional, needs Node; skip if Node is not installed
   cp .env.example .env   # or let run.sh generate it, then edit
   nano .env              # set PLANNER_PASSWORD, TZ and DOMAIN
   ./run.sh https
   ```
5. Open `https://your-domain` on the iPhone in Safari, sign in, then Share → **Add to Home
   Screen**. The session lasts a year.

Notes for Oracle specifically:

- Oracle's Ubuntu images also ship host firewall rules that reject everything except SSH.
  Docker-published ports normally bypass them. If the site is unreachable after step 2, or
  if you run without Docker, open the ports on the host too:
  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```
- The image is built on the server, so both Ampere (ARM) and AMD shapes work.
- Containers restart automatically after a reboot (`restart: unless-stopped`).

### Without Docker

Install Node 24+, then run `./run.sh` under a process manager. A systemd unit:

```ini
# /etc/systemd/system/planner.service
[Unit]
Description=Planner
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/planner
ExecStart=/home/ubuntu/planner/run.sh
Restart=always

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now planner`. Put a reverse proxy with HTTPS (Caddy, nginx) in
front of port 8080; do not expose plain HTTP to the internet.

### Without a domain

`./run.sh docker` publishes the app on `127.0.0.1` only. Reach it through an SSH tunnel
(`ssh -L 8080:localhost:8080 user@vps`) or a private network such as Tailscale. Setting
`BIND=0.0.0.0` exposes plain HTTP publicly and is not recommended.

## Backup

Everything is in one SQLite database, `data/planner.db` (plus `-wal`/`-shm` files while
running). To back up safely while the server runs:

```bash
sqlite3 data/planner.db ".backup 'planner-backup.db'"
```

or stop the server and copy the `data/` folder. The Activity tab's **Export** button
downloads the whole event log as JSON.

## How it works

```
web/            the web app (plain HTML/CSS/JS, no build step)
server/
  server.js     HTTP: static files, sign-in, JSON API
  store.js      SQLite storage and every task rule
  reminders.js  the reminder loop
  store.test.js tests
```

Design decisions and the reasoning behind them:

- **Node with zero dependencies.** The server uses only what ships with Node: `node:http`
  and the built-in `node:sqlite`. There is no `npm install`, no build, and nothing to keep
  patched except Node itself. It idles at a few tens of MB of memory.
- **SQLite, one file.** This is a single-user app; a database server would only add
  things to run and back up.
- **The server owns the rules.** Completing a repeating task, snoozing, validating and
  logging all happen in `store.js`, not in the browser. The web app only renders state and
  sends actions. The Telegram bot will call the same functions, so both channels behave the
  same and produce the same log.
- **Every action is an event.** Each change writes a row to `events` in the same
  transaction as the change itself, with a `source` (`web`, `system`, later `telegram`).
  This is the raw material for the learning agent.
- **Reminders run on the server**, every 30 seconds, so they fire with no browser open.
  A task that passes its due time gets a `reminder_due` event listing the channels it was
  delivered to. There are no channels yet (the event says `channels: none`), and the web
  app shows the task as overdue. A reminder left untouched for an hour logs
  `reminder_ignored`. Telegram and push plug in as "notifiers" in `reminders.js`.
- **One password, signed cookie.** Sign-in sets an HTTP-only cookie signed with a key
  derived from the password. Ten wrong passwords lock sign-in for 15 minutes. Changing
  requests must be JSON and the cookie is `SameSite=Lax`, which blocks cross-site forgery.
- **Undo is server-side.** Each action returns a one-time token that restores the rows it
  touched. Tokens live in memory, so they do not survive a restart. The original events
  stay in the log and an `action_undone` event is added, which is itself a useful signal.

### Events

| Type                 | Extra data                                             |
| -------------------- | ------------------------------------------------------ |
| `task_created`       | `recur`, `recurringFrom` (when spawned by a completion) |
| `task_edited`        | `before` (previous title, notes, due, importance, repeat) |
| `importance_changed` | `from`, `to`                                           |
| `task_completed`     | `minutesVsDue` (negative = early), `snoozeCount`, `afterReminder` |
| `task_snoozed`       | `kind` (`1h`/`tomorrow`), `from`, `to`, `afterReminder` |
| `task_rescheduled`   | `from`, `to`, `afterReminder`                          |
| `task_reopened`, `task_deleted` |                                             |
| `reminder_due`       | `channels`                                             |
| `reminder_ignored`   | `remindedAt`                                           |
| `action_undone`      | `action`                                               |
| `data_imported`, `log_cleared` |                                              |

Every event also carries `at`, `source`, and the task's `title`, `importance` and `due`
at that moment.

### API

All routes are under `/api`, take and return JSON, and need the session cookie except
`login` and `health`. Routes that change something return `{ state, undo }`.

| Method & path                      | Body                                              |
| ---------------------------------- | ------------------------------------------------- |
| `POST /login`                      | `{ password }`                                    |
| `POST /logout`                     |                                                   |
| `GET /health`                      |                                                   |
| `GET /state`                       | returns `{ tasks, events (latest 500), eventCount }` |
| `POST /tasks`                      | `{ title, notes?, due?, importance?, recur? }`    |
| `PATCH /tasks/:id`                 | any of the fields above                           |
| `DELETE /tasks/:id`                |                                                   |
| `POST /tasks/:id/complete`         |                                                   |
| `POST /tasks/:id/reopen`           |                                                   |
| `POST /tasks/:id/snooze`           | `{ kind: "1h" \| "tomorrow" }`                    |
| `POST /tasks/:id/reschedule`       | `{ due }`                                         |
| `POST /undo/:token`                |                                                   |
| `GET /events.json`                 | full event log as a download                      |
| `DELETE /events`                   | clears the log                                    |
| `POST /import`                     | `{ tasks, events }`, only while the server has no tasks |

`due` is an ISO 8601 timestamp, `importance` is 1–4, and `recur` is
`{ type: "none" | "daily" | "weekdays" | "weekly" | "monthly", every: 1–365 }`.

### Moving from the browser-only version

Earlier versions kept tasks in the browser. The first time such a browser signs in to a
server that has no tasks, its tasks and log are uploaded automatically and the local copy
is kept under `planner.v1.imported`.

## Roadmap

Not built yet, in rough order:

1. Telegram bot: chat to create, edit and complete tasks; inline buttons (Done, Snooze 1h,
   Tomorrow, Reschedule) on reminders.
2. Voice notes in Telegram, transcribed into tasks with a summary reply.
3. Phone push notifications with the same quick actions.
4. Calendar sync.
5. The agent that reads the event log and decides what to remind about.
6. Dashboard tab.
