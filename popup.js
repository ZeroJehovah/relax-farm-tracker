// Popup: crop maturity panel + reminder management.
// Reminders are anchored to the nearest (earliest) crop maturity; edit here by
// messaging the background (which owns the authoritative state).

const MATURE_GHOST_MS = 5 * 60 * 1000;

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClockSec(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function countdownText(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return "已成熟";
  const total = Math.floor(diff / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function isActive(c, t) {
  return !c.harvested && (c.maturesAt > t || t - c.maturesAt < MATURE_GHOST_MS);
}

function nearestMaturesAt(active) {
  if (!active.length) return null;
  return active.reduce((m, c) => (c.maturesAt < m ? c.maturesAt : m), active[0].maturesAt);
}

function reminderTarget(r, nearest) {
  if (nearest == null) return null;
  return r.mode === "after" ? nearest + r.seconds * 1000 : nearest - r.seconds * 1000;
}

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

// Morandi state colors, shared with background.js:
//   red (mature) / orange (<=10min) / green (otherwise).
const STATE_COLORS = {
  red: "#C05C5C",
  orange: "#C98F4B",
  green: "#7E9A7A",
};

function matureState(ms) {
  const now = Date.now();
  const diff = ms - now;
  if (diff <= 0) return "red";
  if (diff <= 10 * 60 * 1000) return "orange";
  return "green";
}

function cropIconUrl(seedId) {
  if (!seedId) return null;
  try {
    return browser.runtime.getURL("icons/crops/" + seedId + ".png");
  } catch (e) {
    return null;
  }
}

// ---- crop list (flat, ungrouped) ----

// Batch-planted crops share the same maturity moment but the API assigns each
// a slightly different millisecond timestamp. Cluster crops (same seed + same
// level) whose maturity times are within `GAP_MS` of each other so a batch
// collapses into a single row with a count, regardless of sub-second jitter or
// second-boundary crossing.
const GAP_MS = 1000;

function clusterCrops(list) {
  const sorted = list.slice().sort((a, b) => a.maturesAt - b.maturesAt);
  const clusters = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (
      last &&
      last.seedName === c.seedName &&
      last.seedId === c.seedId &&
      last.level === c.level &&
      c.maturesAt - last.maxMaturesAt <= GAP_MS
    ) {
      last.count += 1;
      last.maxMaturesAt = c.maturesAt;
    } else {
      clusters.push({
        seedId: c.seedId,
        seedName: c.seedName,
        level: c.level,
        maturesAt: c.maturesAt,
        maxMaturesAt: c.maturesAt,
        count: 1,
      });
    }
  }
  return clusters;
}

function renderCropRow(c) {
  const row = el("div", "row");
  const meta = el("div", "meta");
  const iconUrl = cropIconUrl(c.seedId);
  if (iconUrl) {
    const icon = el("img", "crop-icon");
    icon.src = iconUrl;
    icon.alt = "";
    meta.appendChild(icon);
  }
  if (c.level != null) {
    meta.appendChild(Object.assign(el("span", "lv"), { textContent: `Lv${c.level}` }));
  }
  meta.appendChild(Object.assign(el("span", "crop"), { textContent: c.seedName }));
  meta.appendChild(Object.assign(el("span", "crop-count"), { textContent: `×${c.count}` }));
  row.appendChild(meta);

  const state = matureState(c.maturesAt);
  const mature = state === "red";
  const times = el("div", "times");
  const rem = el("span", "time-rem state-" + state);
  rem.textContent = mature ? "已成熟" : countdownText(c.maturesAt);
  const abs = el("span", "time-abs");
  abs.textContent = fmtClock(c.maturesAt);
  times.appendChild(rem);
  times.appendChild(abs);
  row.appendChild(times);
  return row;
}

function renderCrops(state) {
  const now = Date.now();
  const active = (state.crops || []).filter((c) => isActive(c, now));
  const emptyEl = document.getElementById("empty");
  const groupsEl = document.getElementById("groups");
  const plotsPanelEl = document.getElementById("plots-panel");
  const nextEl = document.getElementById("next");

  if (!active.length) {
    emptyEl.removeAttribute("hidden");
    nextEl.setAttribute("hidden", "");
    plotsPanelEl.setAttribute("hidden", "");
    groupsEl.innerHTML = "";
    return null;
  }
  emptyEl.setAttribute("hidden", "");

  const nearest = nearestMaturesAt(active);
  const stateColor = matureState(nearest);
  const isMature = nearest <= now;
  nextEl.removeAttribute("hidden");
  nextEl.classList.remove("state-red", "state-orange", "state-green");
  nextEl.classList.add("state-" + stateColor);

  if (isMature) {
    nextEl.querySelector(".label").textContent = "已成熟作物";
    nextEl.querySelector("#next-time").textContent = `${active.filter((c) => c.maturesAt <= now).length} 块`;
    nextEl.querySelector("#next-time-abs").textContent = "";
  } else {
    nextEl.querySelector(".label").textContent = "最近成熟";
    nextEl.querySelector("#next-time").textContent = countdownText(nearest);
    nextEl.querySelector("#next-time-abs").textContent = fmtClock(nearest);
  }

  const clusters = clusterCrops(active).sort((a, b) => a.maturesAt - b.maturesAt);
  plotsPanelEl.removeAttribute("hidden");
  groupsEl.innerHTML = "";
  clusters.forEach((c) => groupsEl.appendChild(renderCropRow(c)));

  return nearest;
}

// ---- reminders ----

function reminderSig(reminders) {
  return (reminders || [])
    .map((r, i) => `${i}:${r.id}:${r.enabled}:${r.mode}:${r.seconds}`)
    .join("|");
}

let renderedRemSig = null;

function buildReminderRow(r) {
  const row = el("div", "rem-row" + (r.enabled ? "" : " off"));
  row.dataset.id = r.id;

  const toggle = el("button", "rem-toggle" + (r.enabled ? " on" : ""));
  toggle.type = "button";
  toggle.title = r.enabled ? "已启用" : "已禁用";
  toggle.addEventListener("click", () => {
    browser.runtime
      .sendMessage({ type: "updateReminder", id: r.id, patch: { enabled: !r.enabled } })
      .then(afterStateChange);
  });

  const mode = el("select", "rem-mode");
  ["before", "after"].forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = i === 0 ? "提前" : "滞后";
    if (r.mode === m) opt.selected = true;
    mode.appendChild(opt);
  });
  mode.addEventListener("change", () => {
    browser.runtime
      .sendMessage({ type: "updateReminder", id: r.id, patch: { mode: mode.value } })
      .then(afterStateChange);
  });

  const secs = el("input", "rem-secs");
  secs.type = "number";
  secs.min = "0";
  secs.step = "1";
  secs.value = String(r.seconds);
  secs.addEventListener("change", () => {
    const v = Number(secs.value);
    if (!Number.isFinite(v)) return;
    browser.runtime
      .sendMessage({ type: "updateReminder", id: r.id, patch: { seconds: v } })
      .then(afterStateChange);
  });
  const secsWrap = el("span", "rem-secs-wrap");
  secsWrap.appendChild(secs);
  secsWrap.appendChild(Object.assign(el("span", "rem-unit"), { textContent: "秒" }));

  const when = el("span", "rem-when");
  when.dataset.role = "when";
  when.textContent = "—";

  const actions = el("span", "rem-actions");

  const up = el("button", "rem-move");
  up.type = "button";
  up.textContent = "↑";
  up.title = "上移";
  up.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "moveReminder", id: r.id, dir: "up" }).then(afterStateChange);
  });

  const down = el("button", "rem-move");
  down.type = "button";
  down.textContent = "↓";
  down.title = "下移";
  down.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "moveReminder", id: r.id, dir: "down" }).then(afterStateChange);
  });

  const del = el("button", "rem-del");
  del.type = "button";
  del.textContent = "✕";
  del.title = "删除提醒";
  del.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "removeReminder", id: r.id }).then(afterStateChange);
  });

  actions.appendChild(up);
  actions.appendChild(down);
  actions.appendChild(del);

  row.appendChild(toggle);
  row.appendChild(mode);
  row.appendChild(secsWrap);
  row.appendChild(when);
  row.appendChild(actions);

  return row;
}

function renderReminders(state) {
  const reminders = state.reminders || [];
  const sig = reminderSig(reminders);
  const listEl = document.getElementById("rem-list");
  if (renderedRemSig !== sig) {
    renderedRemSig = sig;
    listEl.innerHTML = "";
    if (!reminders.length) {
      const empty = el("div", "rem-empty");
      empty.textContent = "暂无提醒";
      listEl.appendChild(empty);
    } else {
      reminders.forEach((r) => listEl.appendChild(buildReminderRow(r)));
    }
  }
}

function renderReminderPreviews(state, nearest) {
  (state.reminders || []).forEach((r) => {
    const row = document.querySelector(`.rem-row[data-id="${r.id}"]`);
    if (!row) return;
    const when = row.querySelector('[data-role="when"]');
    if (!when) return;
    if (!r.enabled) {
      when.textContent = "已禁用";
      return;
    }
    const target = reminderTarget(r, nearest);
    if (target == null) {
      when.textContent = "无作物";
      return;
    }
    when.textContent = `预计提醒 ${fmtClockSec(target)}`;
  });
}

function afterStateChange() {
  renderedRemSig = null;
  main();
}

async function main() {
  let state;
  try {
    const res = await browser.runtime.sendMessage({ type: "getState" });
    state = (res && res.state) || { crops: [], reminders: [] };
  } catch (e) {
    state = { crops: [], reminders: [] };
  }

  try {
    const v = browser.runtime.getManifest().version;
    document.getElementById("ver").textContent = v;
  } catch (e) {}

  const updatedAt = state.updatedAt || 0;
  const updatedEl = document.getElementById("updated-at");
  const dot = document.getElementById("status-dot");
  if (updatedAt) {
    const diag = state.diag || {};
    let t = `更新于 ${fmtClock(updatedAt)}`;
    if (diag.lastCropsAt) {
      t += ` · crops 命中 ${diag.cropsHits} 次（${fmtClock(diag.lastCropsAt)}）`;
    } else {
      t += " · 未收到 crops 消息";
    }
    updatedEl.textContent = t;
    dot.classList.add("online");
  } else {
    updatedEl.textContent = "尚未记录数据";
  }

  const nearest = renderCrops(state);
  renderReminders(state);
  renderReminderPreviews(state, nearest);
}

document.getElementById("add-reminder").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "addReminder" }).then(afterStateChange);
});

document.getElementById("open-farm").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "openFarm" }).then(() => window.close());
});

document.getElementById("test-reminder").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "testReminder" }).then(() => window.close());
});

main();
setInterval(() => main(), 1000);
window.addEventListener("focus", () => {
  renderedRemSig = null;
  main();
});