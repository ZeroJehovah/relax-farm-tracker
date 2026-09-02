# src 源码约束（relax-farm-tracker 扩展）

## 定位

本目录是浏览器扩展源码，公开仓库。只放代码与公开说明，不放账号、Cookie、令牌、密钥或内部抓包记录。

## 结构

```text
src/
├── manifest.json        # WebExtension 清单（MV3，Chrome 优先）
├── browser-shim.js      # browser/chrome 兼容层
├── background.js        # service worker：存储作物数据、徽章 + 提醒
├── content.js           # 内容脚本：被动 hook fetch/XHR + DOM 轮询兜底
├── popup.html/.css/.js  # 弹出面板
└── icons/               # SVG + PNG 图标
```

## 硬性约束

- 扩展**不主动发起任何网络请求**（不 fetch、不 XHR、不 WebSocket 到站点）。
- 不执行页面操作（不点击、不提交、不导航）。
- 数据只来自被动 hook 页面自身的请求响应；页面数据与本地记录冲突时以页面数据为准。
- 成熟时间可去重压缩数量。

## 加载方式（开发）

Chrome：`chrome://extensions` → 开启开发者模式 → 「加载已解压的扩展程序」选择 `src/`。

## 数据流

`content.js` hook 页面 `fetch`/`XHR`，捕获 `/api/farm/crops`（附 `/api/farm/plots` 的地块等级、`/api/farm/level`）→ `runtime.sendMessage` → `background.js` 合并存储（页面为准，缺失即视为已收获）→ 徽章倒计时 + 弹出面板聚合展示。

## MV3 service worker 注意事项

- 后台是 service worker，空闲会被休眠，内存态 `state` 不可跨唤醒保留，每次操作先 `ensureState()` 从 `storage.local` 加载。
- 周期工作由 `chrome.alarms`（`periodInMinutes: 1`，Chrome 最小粒度）驱动，徽章倒计时为分钟粒度。
- 异步事件监听（`onAlarm`/`notifications.onClicked`/`onInstalled`/`onStartup`）**必须返回 Promise**，否则 worker 会在异步完成前被挂起。

## 提醒

- `background.js` 持有 `state.reminders`，`evaluateReminders()` 在 alarm tick 与数据 ingest 后检查触发。
- 提醒相对「最近成熟时间」：`target = nearest ± seconds`；`lastFiredTarget` 防重复触发；收获/换种使 nearest 变化时旧触发点自动失效。
- 通知点击 → `openFarmTab()`（查已有农场标签页聚焦，否则新建）。