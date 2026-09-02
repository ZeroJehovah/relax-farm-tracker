// Content script injected by the manifest into the page's MAIN world at
// document_start (manifest "world": "MAIN"). This runs synchronously before any
// page script, so it reliably wraps the page's own fetch/XMLHttpRequest — a
// plain isolated-world content script would not see the page calls, and inline
// scripts are blocked by the site's CSP (no 'unsafe-inline').
//
// It passively observes responses of the farm API and reports them back to the
// isolated-world content.js through window.postMessage. It never issues any
// request of its own.

(function () {
  if (window.__farmHookInstalled) return;
  window.__farmHookInstalled = true;

  var CHANNEL = "__farm_tracker__";
  var CROPS_RE = /\/api\/farm\/crops(\?|$)/;
  var PLOTS_RE = /\/api\/farm\/plots(\?|$)/;
  var LEVEL_RE = /\/api\/farm\/level(\?|$)/;
  var BATCH_RE = /\/api\/batch(\?|$)/;

  var latestPlots = null;
  var latestLevel = null;
  var lastCropsSig = "";
  var lastCropsTime = 0;

  function report(type, data, extra) {
    try {
      var msg = { type: type, data: data };
      if (extra) { msg.extra = extra; }
      msg[CHANNEL] = true;
      window.postMessage(msg, "*");
    } catch (e) {}
  }

  // The per-plot "地块等级" shown in the UI (e.g. "地块等级 Lv7") is NOT the
  // plots' unlock level (unlockedPlotLevels); it is derived from each crop's
  // yieldMultiplier: Lv = (yieldMultiplier - 1) * 3 + 1  (1 -> Lv1, 3 -> Lv7).
  function levelFromMultiplier(m) {
    if (m == null || m === "") return null;
    return Math.round((Number(m) - 1) * 3) + 1;
  }

  function attachLevel(arr) {
    return arr.map(function (c) {
      var o = Object.assign({}, c);
      o.level = levelFromMultiplier(c.yieldMultiplier);
      return o;
    });
  }

  function handleCrops(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return; }
    var arr = data && data.data;
    if (!Array.isArray(arr)) return;
    var sig = JSON.stringify(arr.map(function (c) {
      return [c.id || "", c.maturesAt || "", c.isHarvested ? 1 : 0];
    }).sort());
    var t = Date.now();
    if (sig === lastCropsSig && t - lastCropsTime < 1000) return;
    lastCropsSig = sig;
    lastCropsTime = t;
    report("crops", attachLevel(arr), {
      plots: latestPlots || undefined,
      level: latestLevel || undefined
    });
  }

  function handlePlots(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (data && data.data && data.data.unlockedPlotLevels) {
      latestPlots = data.data;
      report("plots", data.data);
    }
  }

  function handleLevel(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (data && data.data) {
      latestLevel = data.data;
      report("level", data.data);
    }
  }

  function route(url, text) {
    if (!url) return;
    if (CROPS_RE.test(url)) handleCrops(text);
    else if (PLOTS_RE.test(url)) handlePlots(text);
    else if (LEVEL_RE.test(url)) handleLevel(text);
  }

  // /api/batch merges several endpoints into one request. Its body lists
  // {id, path} items; its response is NDJSON where each line is
  // {"id":..., "status":..., "body": <the endpoint's JSON>}. We map each
  // request item path to its id, then dispatch each response line to the
  // matching handler using the line's wrapped `body`.
  function handleBatch(reqBody, respText) {
    var idToKind = {};
    try {
      var req = JSON.parse(reqBody || "{}");
      var items = req.items || [];
      for (var i = 0; i < items.length; i++) {
        var p = items[i].path || "";
        var id = String(items[i].id);
        if (CROPS_RE.test(p)) idToKind[id] = "crops";
        else if (PLOTS_RE.test(p)) idToKind[id] = "plots";
        else if (LEVEL_RE.test(p)) idToKind[id] = "level";
      }
    } catch (e) {
      idToKind = {};
    }

    var lines = String(respText || "").split("\n");
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j].trim();
      if (!line) continue;
      var obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      var id = String(obj.id);
      var kind = idToKind[id];
      if (!kind || !obj.body) continue;
      var bodyText = JSON.stringify(obj.body);
      if (kind === "crops") handleCrops(bodyText);
      else if (kind === "plots") handlePlots(bodyText);
      else if (kind === "level") handleLevel(bodyText);
    }
  }

  // --- fetch ---
  // Next.js/Turbopack also patches globalThis.fetch when its bundle loads, which
  // happens AFTER our document_start hook. That overwrites our wrapper and would
  // drop tracked requests. So we re-wrap aggressively (short timer + key DOM
  // milestones) so our wrapper stays on the outermost layer:
  //   our wrapper -> whatever Next installed -> native fetch.
  function wrapFetch() {
    var f = window.fetch;
    if (!f || f.__farmWrapped) return;
    function wrapped(input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var reqBody = init && init.body;
      var p = f.apply(this, arguments);
      if (url) {
        Promise.resolve(p).then(function (res) {
          try {
            if (res && res.clone && typeof res.headers === "object") {
              var ct = res.headers.get("content-type") || "";
              var isBatch = BATCH_RE.test(url);
              if (ct.indexOf("json") !== -1 || isBatch) {
                res.clone().text().then(function (text) {
                  if (isBatch) handleBatch(reqBody, text);
                  else route(url, text);
                });
              }
            }
          } catch (e) {}
        });
      }
      return p;
    }
    wrapped.__farmWrapped = true;
    window.fetch = wrapped;
  }
  wrapFetch();
  var rewrapTimer = setInterval(wrapFetch, 100);
  function onMilestone() { wrapFetch(); }
  // Rewrap at key parse/render milestones and after initial hydration, then
  // stop the aggressive timer once the page settles.
  window.addEventListener("DOMContentLoaded", onMilestone, true);
  window.addEventListener("load", onMilestone, true);
  setTimeout(function () {
    if (window.__farmHookInstalled) clearInterval(rewrapTimer);
  }, 10000);

  // --- XHR ---
  var oOpen = XMLHttpRequest.prototype.open;
  var oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__farmUrl = url;
    return oOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    this.__farmBody = body;
    this.addEventListener("load", function () {
      try {
        var url = self.__farmUrl || "";
        var text = self.responseText;
        if (BATCH_RE.test(url)) handleBatch(self.__farmBody, text);
        else route(url, text);
      } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };
})();