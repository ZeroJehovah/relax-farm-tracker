// Popup: crop maturity panel + reminder management.
// Reminders are anchored to the nearest (earliest) crop maturity; edit here by
// messaging the background (which owns the authoritative state).

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  return !c.harvested;
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

const CROP_IMAGE_ORIGIN = "https://cdk.hybgzs.com";
const CROP_ICON_CACHE_KEY = "farmIconCache";

let cropIconCache = {};
let cropIconCacheWrite = Promise.resolve();
const pendingCropIconFetches = new Map();

function isRemoteCropIconUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === CROP_IMAGE_ORIGIN &&
      /^\/farm\/crops\/[a-z0-9_-]+\.png$/i.test(parsed.pathname);
  } catch (e) {
    return false;
  }
}

function isImageDataUrl(value) {
  return typeof value === "string" && /^data:image\/png(?:;|,)/i.test(value);
}

const cropIconCacheReady = (async () => {
  try {
    const stored = await browser.storage.local.get(CROP_ICON_CACHE_KEY);
    const cache = stored && stored[CROP_ICON_CACHE_KEY];
    if (!cache || typeof cache !== "object") return;
    Object.entries(cache).forEach(([url, dataUrl]) => {
      if (isRemoteCropIconUrl(url) && isImageDataUrl(dataUrl)) {
        cropIconCache[url] = dataUrl;
      }
    });
  } catch (e) {
    // A missing or unavailable cache must not hide the crop list.
  }
})();

function persistCropIconCache() {
  const snapshot = { ...cropIconCache };
  cropIconCacheWrite = cropIconCacheWrite
    .catch(() => {})
    .then(() => browser.storage.local.set({ [CROP_ICON_CACHE_KEY]: snapshot }))
    .catch(() => {});
  return cropIconCacheWrite;
}

function forgetCropIcon(url) {
  if (!Object.prototype.hasOwnProperty.call(cropIconCache, url)) return;
  delete cropIconCache[url];
  persistCropIconCache();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (isImageDataUrl(reader.result)) resolve(reader.result);
      else reject(new Error("crop icon response is not an image"));
    };
    reader.onerror = () => reject(reader.error || new Error("failed to read crop icon"));
    reader.readAsDataURL(blob);
  });
}

function validateCropIconDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(dataUrl);
    image.onerror = () => reject(new Error("crop icon data is not a valid PNG"));
    image.src = dataUrl;
  });
}

async function fetchCropIconDataUrl(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(`crop icon request failed: ${response.status}`);
  const blob = await response.blob();
  if (!blob.size || (blob.type && !/^image\/png$/i.test(blob.type))) {
    throw new Error("crop icon response is not a PNG");
  }
  const imageBlob = blob.type ? blob : blob.slice(0, blob.size, "image/png");
  return blobToDataUrl(imageBlob).then(validateCropIconDataUrl);
}

function ensureCropIconData(url) {
  if (!url) return Promise.reject(new Error("missing crop icon URL"));
  if (cropIconCache[url]) return Promise.resolve(cropIconCache[url]);

  const pending = pendingCropIconFetches.get(url);
  if (pending) return pending;

  const request = fetchCropIconDataUrl(url)
    .then((dataUrl) => {
      cropIconCache[url] = dataUrl;
      // The cache has no expiry. The site is queried again only when this URL
      // has never been stored successfully or a stored image fails to decode.
      return persistCropIconCache().then(() => dataUrl);
    })
    .finally(() => pendingCropIconFetches.delete(url));
  pendingCropIconFetches.set(url, request);
  return request;
}

function cropIconUrls(crop) {
  const urls = [];
  const seedId = typeof crop.seedId === "string" && /^[a-z0-9_-]+$/i.test(crop.seedId)
    ? crop.seedId : null;

  // seedImage is normally a base path, e.g. /farm/crops/starfruit. The
  // site's mature sprite is <base>_s4.png. Derive it from seedId as well so
  // crops saved before seedImage was recorded work immediately after upgrading.
  for (const source of [crop.seedImage, seedId ? `/farm/crops/${seedId}` : null]) {
    if (typeof source !== "string" || !source.trim()) continue;
    try {
      const url = new URL(source, CROP_IMAGE_ORIGIN);
      // Only load the site's static PNG sprites, never API paths or other hosts.
      if (url.origin !== CROP_IMAGE_ORIGIN || url.username || url.password || url.search || url.hash) continue;
      if (!/^\/farm\/crops\/[a-z0-9_-]+(?:\.png)?$/i.test(url.pathname)) continue;
      if (!/\.png$/i.test(url.pathname)) url.pathname += "_s4.png";
      urls.push(url.href);
      break;
    } catch (e) {
      // Ignore malformed page data and try the seedId-derived path.
    }
  }

  if (seedId) urls.push(browser.runtime.getURL(`icons/crops/${seedId}.png`));
  urls.push(browser.runtime.getURL("icons/icon48.png"));
  return urls;
}

function cropIconSources(crop) {
  const urls = cropIconUrls(crop);
  const remoteIndex = urls.findIndex(isRemoteCropIconUrl);
  const remoteUrl = remoteIndex >= 0 ? urls[remoteIndex] : null;
  const fallbackUrls = urls.slice();
  if (remoteIndex >= 0) fallbackUrls.splice(remoteIndex, 1);
  return { remoteUrl, fallbackUrls };
}

// Lucide (MIT) inline icons, 24x24 stroke viewBox.
const LUCIDE = {
  "chevron-up":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
  "chevron-down":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  "trash-2":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
};

function iconBtn(name) {
  const b = el("button", "");
  b.type = "button";
  b.innerHTML = LUCIDE[name];
  b.querySelector("svg").setAttribute("aria-hidden", "true");
  return b;
}

// ---- crop list (flat, ungrouped) ----

// Batch-planted crops share the same maturity moment but the API assigns each
// a slightly different millisecond timestamp. Cluster crops (same seed + same
// level) whose maturity times are within `GAP_MS` of each other so a batch
// collapses into a single row with a count, regardless of sub-second jitter or
// second-boundary crossing.
const GAP_MS = 1000;
let renderedCropsSig = null;

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
      if (!last.seedImage && c.seedImage) last.seedImage = c.seedImage;
    } else {
      clusters.push({
        seedId: c.seedId,
        seedName: c.seedName,
        seedImage: c.seedImage,
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
  const icon = el("img", "crop-icon");
  const { remoteUrl, fallbackUrls } = cropIconSources(c);
  let fallbackIndex = 0;
  let currentSource = "";
  let usingCachedIcon = false;
  icon.alt = "";
  icon.referrerPolicy = "no-referrer";

  const setSource = (source, cached) => {
    currentSource = source;
    usingCachedIcon = cached;
    icon.hidden = false;
    icon.src = source;
  };
  const showNextFallback = () => {
    if (fallbackIndex >= fallbackUrls.length) {
      icon.hidden = true;
      currentSource = "";
      return;
    }
    setSource(fallbackUrls[fallbackIndex++], false);
  };

  icon.addEventListener("error", () => {
    // Ignore a late error from a source that was already replaced.
    if ((icon.currentSrc || icon.src) !== currentSource) return;
    if (usingCachedIcon && remoteUrl) {
      usingCachedIcon = false;
      forgetCropIcon(remoteUrl);
      showNextFallback();
      ensureCropIconData(remoteUrl)
        .then((dataUrl) => {
          if (icon.isConnected) setSource(dataUrl, true);
        })
        .catch(() => {});
      return;
    }
    showNextFallback();
  });

  const cachedDataUrl = remoteUrl && cropIconCache[remoteUrl];
  if (cachedDataUrl) {
    setSource(cachedDataUrl, true);
  } else {
    showNextFallback();
    if (remoteUrl) {
      ensureCropIconData(remoteUrl)
        .then((dataUrl) => {
          if (icon.isConnected) setSource(dataUrl, true);
        })
        .catch(() => {});
    }
  }
  meta.appendChild(icon);
  if (c.level != null) {
    meta.appendChild(Object.assign(el("span", "lv"), { textContent: `Lv${c.level}` }));
  }
  meta.appendChild(Object.assign(el("span", "crop"), { textContent: c.seedName }));
  meta.appendChild(Object.assign(el("span", "crop-count"), { textContent: `×${c.count}` }));
  row.appendChild(meta);

  const times = el("div", "times");
  times.appendChild(el("span", "time-rem"));
  times.appendChild(el("span", "time-abs"));
  row.appendChild(times);
  updateCropRowTimes(row, c.maturesAt);
  return row;
}

function updateCropRowTimes(row, maturesAt) {
  const rem = row.querySelector(".time-rem");
  rem.className = "time-rem state-" + matureState(maturesAt);
  rem.textContent = countdownText(maturesAt);
  row.querySelector(".time-abs").textContent = fmtClock(maturesAt);
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
    renderedCropsSig = null;
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
  const sig = JSON.stringify(clusters);
  // Keep image elements (and their fallback choice) while only the countdown
  // changes. Rebuilding them every second would restart failed image requests.
  if (renderedCropsSig !== sig) {
    groupsEl.replaceChildren(...clusters.map(renderCropRow));
    renderedCropsSig = sig;
  } else {
    clusters.forEach((c, i) => updateCropRowTimes(groupsEl.children[i], c.maturesAt));
  }

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

  const mins = el("input", "rem-secs");
  mins.type = "number";
  mins.min = "0";
  mins.step = "1";
  mins.value = String(Math.round(r.seconds / 60));
  mins.addEventListener("change", () => {
    const v = Number(mins.value);
    if (!Number.isFinite(v) || v < 0) return;
    browser.runtime
      .sendMessage({ type: "updateReminder", id: r.id, patch: { seconds: Math.round(v * 60) } })
      .then(afterStateChange);
  });
  const secsWrap = el("span", "rem-secs-wrap");
  secsWrap.appendChild(mins);
  secsWrap.appendChild(Object.assign(el("span", "rem-unit"), { textContent: "分" }));

  const when = el("span", "rem-when");
  when.dataset.role = "when";
  when.textContent = "—";

  const actions = el("span", "rem-actions");

  const up = iconBtn("chevron-up");
  up.className = "rem-move";
  up.title = "上移";
  up.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "moveReminder", id: r.id, dir: "up" }).then(afterStateChange);
  });

  const down = iconBtn("chevron-down");
  down.className = "rem-move";
  down.title = "下移";
  down.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "moveReminder", id: r.id, dir: "down" }).then(afterStateChange);
  });

  const del = iconBtn("trash-2");
  del.className = "rem-del";
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
    when.textContent = fmtClock(target);
  });
}

function afterStateChange() {
  renderedRemSig = null;
  main();
}

async function main() {
  let state;
  try {
    const [res] = await Promise.all([
      browser.runtime.sendMessage({ type: "getState" }),
      cropIconCacheReady,
    ]);
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
    updatedEl.textContent = `(${fmtClock(updatedAt)})`;
    dot.classList.add("online");
  } else {
    updatedEl.textContent = "尚未记录数据";
  }

  const nearest = renderCrops(state);
  renderReminders(state);
  renderReminderPreviews(state, nearest);

  const stickyCB = document.getElementById("notify-sticky");
  if (stickyCB) {
    const sticky = !!(state && state.notifySticky);
    if (stickyCB.checked !== sticky) stickyCB.checked = sticky;
  }
}

document.getElementById("add-reminder").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "addReminder" }).then(afterStateChange);
});

document.getElementById("open-farm").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "openFarm" }).then(() => window.close());
});

document.getElementById("test-reminder").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "testReminder" });
});

const notifyStickyEl = document.getElementById("notify-sticky");
if (notifyStickyEl) {
  notifyStickyEl.addEventListener("change", () => {
    browser.runtime
      .sendMessage({ type: "setNotifySticky", sticky: notifyStickyEl.checked })
      .then(afterStateChange);
  });
}

main();
setInterval(() => main(), 1000);
window.addEventListener("focus", () => {
  renderedRemSig = null;
  main();
});
