# Planner

A personal task manager: tasks with importance levels, repeating tasks, snooze and
quick actions, and a log of every interaction for a future agent to learn from.

This repository currently contains the **web app** and the **server**. Telegram, voice
notes, phone push notifications and calendar sync are not built yet (see [Roadmap](#roadmap)).

## Quick start

```bash
./run.sh
```

The first run creates `.env` and stops so you can fill it in: set `GOOGLE_CLIENT_ID` and
`ALLOWED_EMAILS` (see [Google sign-in](#google-sign-in)). Run it again, open <http://localhost:8080> and sign in. Requires Node.js 24 or
newer; nothing to install.

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
| `GOOGLE_CLIENT_ID` | empty       | OAuth client ID for Google sign-in (the default sign-in method).                         |
| `ALLOWED_EMAILS`   | empty       | Google accounts allowed in, comma separated. Required with `GOOGLE_CLIENT_ID`. (`ALLOWED_EMAIL` still works.) |
| `TZ`               | system zone | Your timezone as an IANA name, e.g. `Europe/Berlin`. See the note below.                |
| `PORT`             | `8080`      | Port the app listens on.                                                                |
| `BIND`             | `127.0.0.1` | Docker only: address the port is published on.                                          |
| `DOMAIN`           | empty       | `./run.sh https` only: domain name pointing at the server.                              |
| `DATA_DIR`         | `./data`    | Where the database lives (Node mode; Docker always uses `./data`).                      |
| `COOKIE_SECURE`    | unset       | Set to `1` to force HTTPS-only cookies when your proxy does not send `X-Forwarded-Proto`. |

**Set `TZ` to where you live, not where the server is.** "Tomorrow" and repeating tasks
are calculated on the server in this timezone. A VPS is usually on UTC, so a fresh `.env`
created there will say `TZ=UTC` until you change it.

## Google sign-in

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create a
   project, configure the OAuth consent screen (External; add your own account as a test
   user), then **Create credentials → OAuth client ID → Web application**.
2. Under **Authorized JavaScript origins** add the exact address you open the app at, for
   example `https://92-5-32-249.sslip.io` (and `http://localhost:8080` for local use).
   No redirect URI is needed.
3. Put the client ID in `.env` as `GOOGLE_CLIENT_ID` and your Google address as
   `ALLOWED_EMAILS`, then restart (`./run.sh https`).

The server checks Google's signature on the sign-in token, that it was issued for your client
ID, that the email is verified, and that it is in `ALLOWED_EMAILS`. Any other Google account
is refused. There is no password sign-in.

### Accounts

Every task and every activity-log event belongs to one account (`user_id`), and the server
filters every query by the signed-in account, so accounts never see or change each other's
data. To add a person, put their Google address in `ALLOWED_EMAILS` and restart; their
account is created on first sign-in. Removing an address locks them out on their next
request. Their data stays in the database.

Upgrading from a single-user database: on first start the tasks and log that already exist
are adopted by whichever account signs in first, so sign in with your own account first.

## Deploying on an Oracle Cloud VPS

HTTPS matters here: the session cookie travels with every request, and an
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
   nano .env              # set GOOGLE_CLIENT_ID, ALLOWED_EMAILS, TZ and DOMAIN
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
- **Accounts, signed cookie.** Google sign-in sets an HTTP-only
  cookie naming the account, signed with a random secret kept in `data/session.key`. Changing
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
`login`, `login/google`, `config` and `health`. Routes that change something return `{ state, undo }`.

| Method & path                      | Body                                              |
| ---------------------------------- | ------------------------------------------------- |
| `GET /config`                      | returns `{ google }`, the client ID (no sign-in needed) |
| `POST /login/google`               | `{ credential }` (Google ID token)                |
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
