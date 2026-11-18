// Reminder loop. Runs on the server so reminders fire even when no browser is open.
// A "notifier" is any async function (task) => void that delivers a reminder somewhere.
// None exist yet: Telegram and push will be added to `notifiers` later, and the web app
// simply shows due tasks as overdue. Every reminder is logged with the channels it reached.
'use strict';

function startReminders(store, { intervalMs = 30000, notifiers = {} } = {}) {
  async function tick() {
    let due;
    try { due = store.collectDue(); }
    catch (e) { console.error('reminder check failed:', e.message); return; }
    for (const task of due) {
      const delivered = [];
      for (const [name, send] of Object.entries(notifiers)) {
        try { await send(task); delivered.push(name); }
        catch (e) { console.error(`notifier ${name} failed:`, e.message); }
      }
      store.logReminder(task, delivered);
    }
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { startReminders };
