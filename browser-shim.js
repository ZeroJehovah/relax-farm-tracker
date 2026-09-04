// Minimal cross-browser shim so the same code runs on Firefox and Chromium.
// `browser` is guaranteed after this file loads.
//
// Important nuance: this file is loaded in BOTH the service worker (where all
// chrome.* APIs exist) and the content script (where only a few do — e.g.
// chrome.runtime/storage exist, but alarms/notifications/tabs/action do NOT).
// Every API must therefore be guarded: use a no-op when the underlying chrome.*
// namespace is absent, never let the shim throw during construction.
(function () {
  const hasChrome = typeof chrome !== "undefined" && !!chrome.runtime;
  const hasFullBrowser =
    typeof browser !== "undefined" &&
    !!browser.runtime &&
    !!browser.storage &&
    !!browser.browserAction &&
    !!browser.notifications &&
    !!browser.tabs;
  // Real Firefox exposes the full promise-based `browser` API — use it as-is.
  if (hasFullBrowser && !hasChrome) {
    return;
  }

  const noop = () => Promise.resolve(undefined);

  if (hasChrome) {
    // Wrap a chrome.* call that may be callback-based OR promise-based. In MV3
    // some APIs (chrome.action, chrome.alarms) are promise-based and ignore the
    // callback argument, so we resolve from whichever path settles first.
    function promisify(fn) {
      return (...args) =>
        new Promise((resolve) => {
          let settled = false;
          const finish = (val) => {
            if (!settled) {
              settled = true;
              resolve(val);
            }
          };
          let ret;
          try {
            ret = fn(...args, (...res) => {
              if (chrome.runtime.lastError) {
                finish(undefined);
                return;
              }
              finish(res.length <= 1 ? res[0] : res);
            });
          } catch (e) {
            finish(undefined);
            return;
          }
          if (ret && typeof ret.then === "function") {
            ret.then((v) => finish(v)).catch(() => finish(undefined));
          }
        });
    }
    const p = (ns, name, fallback) =>
      ns && typeof ns[name] === "function" ? promisify(ns[name].bind(ns)) : fallback;

    const storage = {
      local: {
        get: chrome.storage && chrome.storage.local
          ? promisify(chrome.storage.local.get.bind(chrome.storage.local))
          : async () => ({}),
        set: chrome.storage && chrome.storage.local
          ? promisify(chrome.storage.local.set.bind(chrome.storage.local))
          : noop,
      },
    };
    const runtime = {
      onMessage: chrome.runtime.onMessage,
      sendMessage: promisify(chrome.runtime.sendMessage.bind(chrome.runtime)),
      onInstalled: chrome.runtime.onInstalled || { addListener() {} },
      onStartup: chrome.runtime.onStartup || { addListener() {} },
      getURL: (path) => chrome.runtime.getURL(path),
      getManifest: () => chrome.runtime.getManifest(),
    };
    const alarms = {
      create: chrome.alarms ? p(chrome.alarms, "create", noop) : noop,
      get: chrome.alarms ? p(chrome.alarms, "get", async () => undefined) : async () => undefined,
      getAll: chrome.alarms ? p(chrome.alarms, "getAll", async () => []) : async () => [],
      clear: chrome.alarms ? p(chrome.alarms, "clear", noop) : noop,
      onAlarm: chrome.alarms ? chrome.alarms.onAlarm : { addListener() {} },
    };
    // The action/browserAction APIs only exist in the worker context; in the
    // content script we fall back to no-ops.
    const actionNs = chrome.action || chrome.browserAction;
    const browserAction = {
      setBadgeText: p(actionNs || null, "setBadgeText", noop),
      setBadgeBackgroundColor: p(actionNs || null, "setBadgeBackgroundColor", noop),
      setTitle: p(actionNs || null, "setTitle", noop),
    };
    const notifications = {
      create: chrome.notifications ? p(chrome.notifications, "create", noop) : noop,
      onClicked: chrome.notifications ? chrome.notifications.onClicked : { addListener() {} },
    };
    const tabs = {
      query: chrome.tabs ? p(chrome.tabs, "query", async () => []) : async () => [],
      update: chrome.tabs ? p(chrome.tabs, "update", noop) : noop,
      create: chrome.tabs ? p(chrome.tabs, "create", noop) : noop,
    };
    const windows = {
      update: chrome.windows ? p(chrome.windows, "update", noop) : noop,
    };

    self.browser = { storage, runtime, alarms, browserAction, notifications, tabs, windows };
    return;
  }

  // Fallback: no browser API at all (should not happen in a real context).
  const evt = { addListener() {} };
  self.browser = {
    storage: { local: { get: async () => ({}), set: noop } },
    runtime: { onMessage: evt, sendMessage: noop, onInstalled: evt, onStartup: evt, getURL: () => "" },
    alarms: { create: noop, get: async () => undefined, getAll: async () => [], clear: noop, onAlarm: evt },
    browserAction: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
    notifications: { create: noop, onClicked: evt },
    tabs: { query: async () => [], update: noop, create: noop },
    windows: { update: noop },
  };
})();
