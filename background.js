// Load the browser/chrome compatibility shim first (MV3 service_worker is a
// single entry file, it does not auto-load the shim like the old scripts array
// did).
importScripts("browser-shim.js");

// Background (Chrome MV3 service worker): authoritative store of farm crop
// maturity data + reminder scheduling.
//
// Important: a service worker is suspended when idle, so we must NOT rely on
// in-memory state persisting between wakes. State is loaded from storage at
// the top of every operation, and periodic work is driven by chrome.alarms.
//
// This script only receives data pushed by the content script (which passively
// hooks the page's own requests). It never issues any network request.

const STORAGE_KEY = "farmState";
const MATURE_GHOST_MS = 5 * 60 * 1000; // keep just-harvested rows for this long
const FARM_URL = "https://cdk.hybgzs.com/entertainment/farm";
const FARM_URL_PATTERN = "*://cdk.hybgzs.com/entertainment/farm*";
const ALARM_NAME = "farm-tick";
const ALARM_PERIOD_MIN = 1; // chrome.alarms minimum period
const REMINDER_ALARM_PREFIX = "reminder-"; // per-reminder alarms
const REMINDER_NOTIFICATION_PREFIX = "farm-reminder-";

let state = defaultState();
let statePromise = null;
let reminderSeq = 0;

function defaultState() {
  return {
    crops: [], // [{id, seedName, plotIndex, level, maturesAt, isMature, harvested, ...}]
    plots: { totalSlots: 0, levels: {} },
    level: null,
    reminders: [], // [{id, enabled, mode:'before'|'after', seconds, lastFiredTarget}]
    updatedAt: 0,
    diag: {
      lastCropsAt: 0,
      cropsHits: 0,
      lastTickAt: 0,
      tickCount: 0,
      lastEvalAt: 0,
      evalCount: 0,
      reminderLog: [], // last 20 eval results
    },
  };
}

function nowMs() {
  return Date.now();
}

// Load once per worker lifetime; otherwise reuse the in-memory copy (kept in
// sync by persist()).
function ensureState() {
  if (!statePromise) {
    statePromise = browser.storage.local.get(STORAGE_KEY).then((obj) => {
      if (obj && obj[STORAGE_KEY]) {
        state = Object.assign(defaultState(), obj[STORAGE_KEY]);
      }
      return state;
    });
  }
  return statePromise;
}

function persist() {
  return browser.storage.local.set({ [STORAGE_KEY]: state });
}

function activeCrops(ts) {
  const t = ts || nowMs();
  return state.crops.filter(
    (c) => !c.harvested
  );
}

function nearestMaturesAt(crops) {
  if (!crops.length) return null;
  return crops.reduce((min, c) => (c.maturesAt < min ? c.maturesAt : min), crops[0].maturesAt);
}

// Compact minute-granularity badge text (Chrome badge shows ~4 chars).
//   ms <= 0            -> "熟"
//   0 < ms < 60s       -> "1m"
//   < 60 min           -> "Nm"  (whole minutes)
//   >= 60 min          -> ">1h"
// Morandi state colors, shared convention with the popup:
//   mature (red) / soon <=10min (orange) / otherwise (green).
const STATE_COLORS = {
  red: "#C05C5C",
  orange: "#C98F4B",
  green: "#7E9A7A",
};

function matureState(nearest, now) {
  if (nearest == null) return "gray";
  const diff = nearest - now;
  if (diff <= 0) return "red";
  if (diff <= 10 * 60 * 1000) return "orange";
  return "green";
}

function badgeText(ms) {
  if (ms <= 0) return { text: "熟", mature: true };
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 60) return { text: ">1h", mature: false };
  if (minutes <= 0) return { text: "1m", mature: false };
  return { text: `${minutes}m`, mature: false };
}

function detailText(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}小时${m}分钟`;
  if (m > 0) return `${m}分钟`;
  return `${total}秒`;
}

function updateBadge() {
  const crops = activeCrops();
  const nearest = nearestMaturesAt(crops);
  let text = "";
  let color = "#9aa1b2";
  let title = "轻松农场 · 暂无种植";
  if (nearest != null) {
    const diff = nearest - nowMs();
    const p = badgeText(diff);
    text = p.text;
    title = p.mature
      ? `有作物已成熟（${crops.length} 块地）`
      : `最近成熟: ${crops.length} 块地 · 约 ${detailText(diff)}`;
    color = STATE_COLORS[matureState(nearest, nowMs())] || color;
  }
  return browser.browserAction
    .setBadgeText({ text })
    .catch(() => {})
    .then(() => browser.browserAction.setBadgeBackgroundColor({ color }))
    .catch(() => {})
    .then(() => browser.browserAction.setTitle({ title }))
    .catch(() => {});
}

function pruneCrops() {
  state.crops = state.crops.filter(
    (c) => !c.harvested || nowMs() - (c.harvestedAt || c.capturedAt) < MATURE_GHOST_MS
  );
}

// ---- reminders ----

function nextReminderId() {
  reminderSeq += 1;
  return "r" + nowMs() + "_" + reminderSeq;
}

function reminderTarget(reminder, nearest) {
  if (nearest == null) return null;
  return reminder.mode === "after"
    ? nearest + reminder.seconds * 1000
    : nearest - reminder.seconds * 1000;
}

// Keep one notification per reminder target. Reusing only the reminder id
// makes Chrome clear/replace an old, still-visible notification (especially
// with requireInteraction); Windows can keep that replacement in Notification
// Center without showing a distinct new toast.
function reminderNotificationId(reminder, target) {
  return REMINDER_NOTIFICATION_PREFIX + reminder.id + "-" + String(Math.trunc(target));
}

function fireNotification(reminder, target, cropsCount) {
  let message;
  if (reminder.mode === "after" || reminder.seconds <= 0) {
    message = "你的作物已成熟";
  } else {
    const sec = reminder.seconds;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    const part = h > 0 ? `${h}h${m}min` : `${m}min`;
    message = `你的作物即将成熟(~${part})`;
  }
  const notId = reminderNotificationId(reminder, target);
  return Promise.resolve()
    .then(() => browser.notifications.create(notId, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon128.png"),
      title: "轻松农场 · 作物提醒",
      message,
      requireInteraction: true,
    }))
    .then((createdId) => {
      // The shim intentionally resolves API errors to undefined for
      // compatibility with callback- and Promise-based Chrome APIs. Treat a
      // missing id as a failed delivery so the next evaluation can retry.
      // A successful id means Chrome accepted the notification; Windows may
      // still suppress the on-screen banner according to its notification and
      // focus settings.
      if (!createdId) throw new Error("notifications.create 未返回通知 ID");
      return createdId;
    });
}

async function openFarmTab() {
  try {
    const tabs = await browser.tabs.query({ url: FARM_URL_PATTERN });
    if (tabs && tabs.length) {
      const t = tabs[0];
      await browser.tabs.update(t.id, { active: true });
      if (browser.windows) {
        await browser.windows.update(t.windowId, { focused: true });
      }
    } else {
      await browser.tabs.create({ url: FARM_URL });
    }
  } catch (e) {
    try {
      await browser.tabs.create({ url: FARM_URL });
    } catch (e2) {
      /* ignore */
    }
  }
}

// Fire a notification that exactly mimics a real reminder, used to test that
// notifications are reachable/not blocked.
function fireTestReminder() {
  const message = "你的作物即将成熟(~5min)";
  // Use a fresh id every time so repeated tests always re-deliver a visible
  // notification (Chrome may merely replace a still-open notification with the
  // same id). requireInteraction keeps it on screen until the user acts, making
  // delivery unmistakable.
  return browser.notifications
    .create("farm-reminder-test-" + Date.now(), {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon128.png"),
      title: "轻松农场 · 作物提醒",
      message,
      requireInteraction: true,
    })
    .catch(() => {});
}

// Reminders are dynamically anchored to the current nearest maturity. If that
// nearest maturity changes (crop harvested, or a newer crop matures sooner),
// the reminder re-anchors and a stale trigger is naturally dropped.
function evaluateReminders() {
  const now = nowMs();
  const nearest = nearestMaturesAt(activeCrops(now));

  // Diagnostic logging
  state.diag = state.diag || {};
  state.diag.lastEvalAt = now;
  state.diag.evalCount = (state.diag.evalCount || 0) + 1;
  state.diag.reminderLog = state.diag.reminderLog || [];

  const jobs = [];
  const logEntry = {
    at: now,
    nearest: nearest,
    fired: [],
    failed: [],
    skipped: [],
  };

  for (const r of state.reminders) {
    if (!r.enabled) {
      logEntry.skipped.push({ id: r.id, reason: 'disabled' });
      continue;
    }
    const target = reminderTarget(r, nearest);
    if (target == null) {
      logEntry.skipped.push({ id: r.id, reason: 'no-target' });
      continue;
    }
    if (r.lastFiredTarget === target) {
      logEntry.skipped.push({ id: r.id, reason: 'already-fired', target });
      continue;
    }
    if (now >= target) {
      r.lastFiredTarget = target;
      const fired = { id: r.id, target, mode: r.mode, seconds: r.seconds };
      jobs.push(
        fireNotification(r, target, activeCrops(now).length)
          .then(() => {
            logEntry.fired.push(fired);
          })
          .catch((error) => {
            // Do not permanently consume a reminder when the OS/browser
            // rejects delivery. A later tick or page update should retry it.
            if (r.lastFiredTarget === target) r.lastFiredTarget = null;
            logEntry.failed.push({
              ...fired,
              error: error && error.message ? error.message : String(error || "unknown"),
            });
          })
      );
    } else {
      logEntry.skipped.push({ id: r.id, reason: 'not-yet', target, waitMs: target - now });
    }
  }

  // Keep last 20 evals
  state.diag.reminderLog.push(logEntry);
  if (state.diag.reminderLog.length > 20) {
    state.diag.reminderLog = state.diag.reminderLog.slice(-20);
  }

  return Promise.all(jobs).then(() => persist()).then(() => scheduleReminderAlarms(nearest));
}

// Schedule individual alarms for each active reminder to ensure they fire even
// if the periodic tick alarm fails.
function scheduleReminderAlarms(nearest) {
  if (!browser.alarms || typeof browser.alarms.create !== "function") return Promise.resolve();
  if (nearest == null) {
    return clearReminderAlarms();
  }

  const now = nowMs();
  const desired = new Map();

  for (const r of state.reminders) {
    if (!r.enabled) continue;
    const target = reminderTarget(r, nearest);
    if (target == null || target <= now || r.lastFiredTarget === target) continue;

    const alarmName = REMINDER_ALARM_PREFIX + r.id;
    desired.set(alarmName, target);
  }

  // Use the absolute `when` value instead of a rounded delay. The old
  // ceil(delayInMinutes) approach could move an alarm forward on every page
  // refresh, so a target near the next minute was repeatedly postponed.
  const getAll = browser.alarms && typeof browser.alarms.getAll === "function"
    ? browser.alarms.getAll.bind(browser.alarms)
    : () => Promise.resolve([]);
  return getAll().then((alarms) => {
    const existing = new Map(
      (alarms || [])
        .filter((a) => a && typeof a.name === "string" && a.name.startsWith(REMINDER_ALARM_PREFIX))
        .map((a) => [a.name, a])
    );
    const jobs = [];
    const clear = browser.alarms && typeof browser.alarms.clear === "function"
      ? browser.alarms.clear.bind(browser.alarms)
      : null;

    // Remove alarms for disabled/deleted reminders or stale targets.
    existing.forEach((alarm, name) => {
      if (!desired.has(name) && clear) {
        jobs.push(clear(name).catch(() => {}));
      }
    });

    desired.forEach((target, name) => {
      const alarm = existing.get(name);
      const scheduled = alarm && Number(alarm.scheduledTime);
      // Chrome may clamp a very near alarm by up to its minimum granularity;
      // keep a pending alarm in that case, but replace an absent/stale one.
      const isPending = Number.isFinite(scheduled) && scheduled > now;
      const isForThisTarget =
        isPending && scheduled >= target - 1000 && scheduled <= target + 2 * 60 * 1000;
      if (isForThisTarget) return;
      jobs.push(browser.alarms.create(name, { when: target }).catch(() => {}));
    });

    return Promise.all(jobs);
  }).catch(() => {
    // Older browser shims may not expose getAll/clear. Still install the
    // absolute-time alarms as a best-effort fallback.
    return Promise.all(
      Array.from(desired, ([name, target]) =>
        browser.alarms.create(name, { when: target }).catch(() => {})
      )
    );
  });
}

// Clear all reminder-specific alarms
function clearReminderAlarms() {
  if (!browser.alarms || typeof browser.alarms.getAll !== "function") return Promise.resolve();
  if (typeof browser.alarms.clear !== "function") return Promise.resolve();
  return browser.alarms.getAll().then((alarms) => {
    const jobs = alarms
      .filter((a) => a && typeof a.name === "string" && a.name.startsWith(REMINDER_ALARM_PREFIX))
      .map((a) => browser.alarms.clear(a.name).catch(() => {}));
    return Promise.all(jobs);
  }).catch(() => {});
}

function persistAndScheduleReminders() {
  const nearest = nearestMaturesAt(activeCrops());
  return persist().then(() => scheduleReminderAlarms(nearest));
}

function createReminder() {
  const r = {
    id: nextReminderId(),
    enabled: true,
    mode: "before",
    seconds: 60,
    lastFiredTarget: null,
  };
  state.reminders.push(r);
  return r;
}

function updateReminder(id, patch) {
  const r = state.reminders.find((x) => x.id === id);
  if (!r) return { ok: false };
  if (typeof patch.enabled === "boolean") r.enabled = patch.enabled;
  if (patch.mode === "before" || patch.mode === "after") r.mode = patch.mode;
  if (patch.seconds != null) {
    const s = Number(patch.seconds);
    if (Number.isFinite(s) && s >= 0) r.seconds = Math.floor(s);
  }
  if (patch.mode || patch.seconds != null) r.lastFiredTarget = null;
  return { ok: true };
}

function removeReminder(id) {
  const before = state.reminders.length;
  state.reminders = state.reminders.filter((x) => x.id !== id);
  return { ok: true, removed: before - state.reminders.length };
}

function moveReminder(id, dir) {
  const idx = state.reminders.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false };
  const to = idx + (dir === "up" ? -1 : 1);
  if (to < 0 || to >= state.reminders.length) return { ok: false };
  const arr = state.reminders.slice();
  const [item] = arr.splice(idx, 1);
  arr.splice(to, 0, item);
  state.reminders = arr;
  return { ok: true };
}

// ---- crop data ingest (page data is authoritative) ----

function ingestCrops(rawCrops, extra) {
  const crops = (rawCrops || []).map((c) => ({
    id: c.id,
    seedId: c.seedId,
    seedName: c.seedName,
    plotIndex: c.plotIndex,
    level: c.level == null ? null : Number(c.level),
    yieldMultiplier: c.yieldMultiplier,
    plantedAt: c.plantedAt,
    maturesAt: c.maturesAt ? Date.parse(c.maturesAt) : 0,
    isMature: !!c.isMature,
    remainingTime: c.remainingTime,
    harvested: !!c.isHarvested,
    capturedAt: nowMs(),
  }));

  const seen = new Set(crops.map((c) => c.id));
  const merged = crops.slice();
  for (const old of state.crops) {
    if (!seen.has(old.id) && !old.harvested) {
      merged.push(Object.assign({}, old, { harvested: true, harvestedAt: nowMs() }));
    }
  }

  state.crops = merged;
  if (extra) {
    if (extra.plots) state.plots = extra.plots;
    if (extra.level) state.level = extra.level;
  }
  state.updatedAt = nowMs();

  return updateBadge()
    .then(() => evaluateReminders())
    .then(() => persist());
}

function ingestPlots(plotsData) {
  if (!plotsData) return Promise.resolve();
  state.plots = {
    totalSlots: plotsData.totalSlots || state.plots.totalSlots,
    levels: plotsData.unlockedPlotLevels || {},
  };
  state.updatedAt = nowMs();
  return updateBadge().then(() => persist());
}

function ingestLevel(levelData) {
  if (!levelData) return Promise.resolve();
  state.level = levelData;
  state.updatedAt = nowMs();
  return persist();
}

// ---- alarm/tick ----

function tick() {
  const now = nowMs();
  state.diag = state.diag || {};
  state.diag.lastTickAt = now;
  state.diag.tickCount = (state.diag.tickCount || 0) + 1;

  pruneCrops();
  return updateBadge().then(() => evaluateReminders());
}

function ensureAlarm() {
  // Do not recreate the periodic alarm on every service-worker wake. Replacing
  // it repeatedly can keep moving the next tick forward and make the worker
  // miss the only evaluation window around a reminder target.
  if (!browser.alarms || typeof browser.alarms.get !== "function") {
    return browser.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  }
  return browser.alarms.get(ALARM_NAME).then((alarm) => {
    if (alarm && Number(alarm.periodInMinutes) > 0) return alarm;
    return browser.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  }).catch(() => {
    // Best effort for older implementations without alarms.get().
    return browser.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  });
}

// ---- lifecycle / IPC ----

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  const run = () => {
    switch (msg.type) {
      case "crops": {
        state.diag = state.diag || { lastCropsAt: 0, cropsHits: 0 };
        state.diag.lastCropsAt = nowMs();
        state.diag.cropsHits += 1;
        return ingestCrops(msg.data, msg.extra).then(() => ({ ok: true }));
      }
      case "plots":
        return ingestPlots(msg.data).then(() => ({ ok: true }));
      case "level":
        return ingestLevel(msg.data).then(() => ({ ok: true }));
      case "getState":
        return Promise.resolve({ ok: true, state });
      case "getDiag":
        return Promise.resolve({ ok: true, diag: state.diag || {} });
      case "addReminder": {
        const r = createReminder();
        return persistAndScheduleReminders().then(() => ({ ok: true, reminder: r, state }));
      }
      case "updateReminder": {
        const res = updateReminder(msg.id, msg.patch || {});
        return persistAndScheduleReminders().then(() => ({ ok: res.ok, state }));
      }
      case "removeReminder": {
        const res = removeReminder(msg.id);
        return persistAndScheduleReminders().then(() => ({ ok: res.ok, state }));
      }
      case "moveReminder": {
        const res = moveReminder(msg.id, msg.dir);
        return persistAndScheduleReminders().then(() => ({ ok: res.ok, state }));
      }
      case "openFarm":
        return openFarmTab().then(() => ({ ok: true }));
      case "testReminder":
        return fireTestReminder().then(() => ({ ok: true }));
      default:
        return Promise.resolve({ ok: true });
    }
  };
  return ensureState().then(run);
});

browser.notifications.onClicked.addListener(() => {
  return ensureState().then(openFarmTab);
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm) return undefined;
  const name = typeof alarm.name === "string" ? alarm.name : "";

  // Periodic tick alarm
  if (name === ALARM_NAME) {
    return ensureState().then(tick);
  }

  // Per-reminder alarm
  if (name.startsWith(REMINDER_ALARM_PREFIX)) {
    return ensureState().then(() => {
      // Force evaluation when a reminder alarm fires
      return evaluateReminders();
    });
  }

  return undefined;
});

browser.runtime.onInstalled.addListener(() => {
  return ensureState().then(() => ensureAlarm()).catch(() => {});
});
browser.runtime.onStartup.addListener(() => {
  return ensureState()
    .then(() => ensureAlarm())
    .then(() => evaluateReminders())
    .then(() => updateBadge())
    .catch(() => {});
});

// Boot: ensure state is loaded and the alarm is registered once the worker
// wakes (worker may have restarted without onInstalled/onStartup firing).
// The badge is re-rendered from persisted storage so the countdown appears
// immediately after a browser restart, even before the next alarm tick.
ensureState()
  .then(() => ensureAlarm())
  .then(() => evaluateReminders())
  .then(() => updateBadge())
  .catch(() => {});
