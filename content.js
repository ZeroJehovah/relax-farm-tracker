// Content script (isolated world): forwards the page-world hook's reports to
// the background.
//
// hook.js is injected by the manifest in MAIN world (document_start), so it can
// wrap the page's own fetch/XHR and report via window.postMessage. This script
// only listens for those messages and forwards them — it never issues requests
// or touches the page.

(function () {
  if (window.__farmTrackerBridge) return;
  window.__farmTrackerBridge = true;

  const CHANNEL = "__farm_tracker__";

  function forward(msg) {
    try {
      const p = browser.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* background may not be ready */
    }
  }

  window.addEventListener("message", (ev) => {
    if (!ev.data || typeof ev.data !== "object" || ev.data[CHANNEL] !== true) return;
    const d = ev.data;
    if (!d || !d.type) return;
    forward({ type: d.type, data: d.data, extra: d.extra });
  });
})();