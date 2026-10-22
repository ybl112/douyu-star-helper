// ==UserScript==
// @name         斗鱼全民星推荐自动领取
// @namespace    local.douyu.star.helper
// @version      2.0.5
// @description  后台自动领取全民星推荐活动红包，支持奖池筛选、到账统计及每日上限自动停止。
// @homepageURL  https://github.com/ybl112/douyu-star-helper
// @supportURL   https://github.com/ybl112/douyu-star-helper/issues
// @downloadURL  https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.user.js
// @updateURL    https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.meta.js
// @match        https://www.douyu.com/*
// @noframes
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_info
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @grant        window.close
// @license      MIT
// ==/UserScript==

/*
 * Independently implemented controller. Protocol field mapping and dynamic
 * CSRF configuration were adapted from ienone/douyu-qmx-pro (MIT):
 * https://github.com/ienone/douyu-qmx-pro
 * Reference revision: 93accebf2983a49811ee218da7adf50547408575
 * Upstream credits ysl-ovo's original userscript as its origin:
 * https://greasyfork.org/zh-CN/scripts/532514
 * See README.md and THIRD_PARTY_NOTICES.md for reference scope and licenses.
 *
 * MIT License -- Copyright (c) 2025 ienone
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/* global GM_getValue, GM_setValue, GM_deleteValue, GM_addValueChangeListener, GM_removeValueChangeListener, GM_registerMenuCommand, GM_openInTab, GM_info, GM_xmlhttpRequest, unsafeWindow */
(function () {
  'use strict';

  const BASE = '/japi/livebiznc/web/anchorstardiscover';
  const DEFAULTS = Object.freeze({ minCoins: 10000, concurrency: 2, scanSeconds: 60,
    probeCount: 24, maxWait: 600, dailyCap: 0, compact: true });
  const number = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const dayKey = (at = Date.now()) => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  const safeId = value => /^\d{1,15}$/.test(String(value || '')) ? String(value) : '';
  const keyOf = bag => `${bag.rid}:${bag.id}`;
  function normalizePayload(payload) {
    if (payload && typeof payload.data === 'string' && payload.data.length <= 1048576) {
      try {
        const data = JSON.parse(payload.data);
        if (data && typeof data === 'object' && !Array.isArray(data)) return { ...payload, data };
      } catch { /* Keep malformed data unknown rather than inventing a result. */ }
    }
    return payload;
  }
  const RELEASE = Object.freeze({ name: '斗鱼全民星推荐自动领取', namespace: 'local.douyu.star.helper',
    downloadURL: 'https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.user.js',
    metadataURL: 'https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.meta.js' });

  function compareVersions(a, b) {
    const parts = value => {
      if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) throw new Error('版本号格式异常');
      return value.split('.').map(Number);
    };
    const left = parts(a), right = parts(b);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
    return 0;
  }

  function parseUpdateMeta(text) {
    if (typeof text !== 'string' || text.length > 32768 ||
        !/^\/\/ ==UserScript==\r?\n[\s\S]*?\/\/ ==\/UserScript==\s*$/.test(text)) throw new Error('版本信息格式异常');
    const field = name => text.match(new RegExp(`^// @${name} +([^\\r\\n]+)`, 'm'))?.[1].trim();
    if (field('name') !== RELEASE.name || field('namespace') !== RELEASE.namespace ||
        field('downloadURL') !== RELEASE.downloadURL) throw new Error('版本信息不属于本脚本');
    const version = field('version'); compareVersions(version, version);
    return version;
  }

  function fetchRelease(send, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    return new Promise((resolve, reject) => {
      let handle, settled = false;
      const finish = (callback, result) => {
        if (settled) return;
        settled = true; clearTimer(timer); callback(result);
      };
      // Anonymous requests may use fetch internally, so keep our own timeout as well.
      const timer = setTimer(() => {
        finish(reject, new Error('检查超时，请稍后重试'));
        try { handle?.abort(); } catch { /* Already completed. */ }
      }, 15000);
      try {
        handle = send({ method: 'GET', url: RELEASE.metadataURL, anonymous: true, nocache: true,
          revalidate: true, timeout: 15000, headers: { Accept: 'text/plain' },
          onload(response) {
            try {
              const final = new URL(response.finalUrl || RELEASE.metadataURL), expected = new URL(RELEASE.metadataURL);
              if (response.status !== 200 || final.origin !== expected.origin || final.pathname !== expected.pathname) {
                throw new Error('无法读取版本信息，请稍后重试');
              }
              finish(resolve, parseUpdateMeta(response.responseText));
            } catch (error) { finish(reject, error); }
          },
          onerror: () => finish(reject, new Error('网络连接失败，请稍后重试')),
          ontimeout: () => finish(reject, new Error('检查超时，请稍后重试')),
          onabort: () => finish(reject, new Error('检查已取消')) });
      } catch { finish(reject, new Error('检查失败，请确认油猴允许访问更新地址')); }
    });
  }

  function clampPosition(position, size, viewport) {
    return { x: Math.round(Math.max(8, Math.min(number(position?.x, 18), Math.max(8, viewport.width - size.width - 8)))),
      y: Math.round(Math.max(8, Math.min(number(position?.y, 18), Math.max(8, viewport.height - size.height - 8)))) };
  }

  function bindDrag(handle, { rect, viewport, move, save, now = () => Date.now() }) {
    let drag = null, suppressUntil = 0;
    const down = event => {
      if (drag || event.isPrimary === false || event.button !== 0 ||
          (event.target !== handle && event.target.closest?.('button,a,input,select,textarea,summary'))) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: rect(), moved: false };
      try { handle.setPointerCapture(event.pointerId); } catch { drag = null; }
    };
    const moving = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true; event.preventDefault();
      move(clampPosition({ x: drag.start.x + dx, y: drag.start.y + dy }, rect(), viewport()));
    };
    const end = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const finished = drag; drag = null;
      if (finished.moved) {
        suppressUntil = now() + 500;
        const position = clampPosition(rect(), rect(), viewport()); move(position); save(position);
      }
      try { if (handle.hasPointerCapture(finished.id)) handle.releasePointerCapture(finished.id); } catch { /* Released by browser. */ }
    };
    const click = event => {
      if (event.detail !== 0 && now() < suppressUntil) {
        suppressUntil = 0; event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    const events = { pointerdown: down, pointermove: moving, pointerup: end, pointercancel: end, lostpointercapture: end };
    for (const [name, fn] of Object.entries(events)) handle.addEventListener(name, fn);
    handle.addEventListener('click', click, true);
    return () => {
      if (drag) end({ pointerId: drag.id });
      for (const [name, fn] of Object.entries(events)) handle.removeEventListener(name, fn);
      handle.removeEventListener('click', click, true);
    };
  }

  function registeredWorker(task, lease, at) {
    return Boolean(task && !task.revoked && safeId(task.rid) && safeId(task.bagId) && task.owner &&
      task.owner === lease?.owner && task.expires >= at && lease.until >= at - 90000);
  }

  function backgroundFrames(page, doc, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const nativeFrame = page.requestAnimationFrame, nativeCancel = page.cancelAnimationFrame;
    if (typeof nativeFrame !== 'function' || typeof nativeCancel !== 'function') return () => {};
    const pending = new Map(); let sequence = 1000000000, disposed = false;
    const hidden = () => doc.visibilityState === 'hidden' || doc.hidden === true;
    const finish = (record, timestamp) => {
      if (disposed || !pending.delete(record.id)) return;
      clearTimer(record.timer); nativeCancel.call(page, record.native);
      record.callback.call(page, timestamp);
    };
    const arm = record => {
      if (record.timer !== null) return;
      // Let the real official callback run at most once/second while Chrome suspends rAF.
      // This changes scheduling only, never visibility, clocks or packet time values.
      record.timer = setTimer(() => {
        record.timer = null;
        if (hidden()) finish(record, page.performance.now());
      }, 1000);
    };
    function requestFrame(callback) {
      if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame requires a function');
      const record = { id: ++sequence, callback, timer: null, native: null };
      pending.set(record.id, record);
      record.native = nativeFrame.call(page, timestamp => finish(record, timestamp));
      if (hidden()) arm(record);
      return record.id;
    }
    function cancelFrame(id) {
      const record = pending.get(id);
      if (!record) { nativeCancel.call(page, id); return; }
      pending.delete(id); clearTimer(record.timer); nativeCancel.call(page, record.native);
    }
    const visibility = () => {
      for (const record of pending.values()) {
        if (hidden()) arm(record);
        else { clearTimer(record.timer); record.timer = null; }
      }
    };
    try { page.requestAnimationFrame = requestFrame; page.cancelAnimationFrame = cancelFrame; }
    catch {
      if (page.requestAnimationFrame === requestFrame) page.requestAnimationFrame = nativeFrame;
      return () => {};
    }
    doc.addEventListener('visibilitychange', visibility);
    return () => {
      if (disposed) return;
      disposed = true; doc.removeEventListener('visibilitychange', visibility);
      for (const record of pending.values()) { clearTimer(record.timer); nativeCancel.call(page, record.native); }
      pending.clear();
      if (page.requestAnimationFrame === requestFrame) page.requestAnimationFrame = nativeFrame;
      if (page.cancelAnimationFrame === cancelFrame) page.cancelAnimationFrame = nativeCancel;
    };
  }

  function options(raw = {}) {
    const s = { ...DEFAULTS, ...raw };
    for (const [key, min, max] of [['minCoins', 0, 10000000], ['concurrency', 1, 6],
      ['scanSeconds', 30, 600], ['probeCount', 6, 60], ['maxWait', 30, 1800], ['dailyCap', 0, 500]]) {
      s[key] = Math.round(Math.min(max, Math.max(min, number(s[key], DEFAULTS[key]))));
    }
    s.compact = Boolean(s.compact);
    return s;
  }

  function prizes(list) {
    // Protocol mapping adapted from upstream RedBagState.js (ptype/prizeType 9=coins, 2=starlight).
    // https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/features/redbag/RedBagState.js
    return (Array.isArray(list) ? list : []).reduce((sum, item) => {
      const n = Math.max(0, number(item.num));
      const type = number(item.prizeType ?? item.ptype, -1);
      if (type === 9) sum.coins += n;
      if (type === 2) sum.stars += n;
      return sum;
    }, { coins: 0, stars: 0 });
  }

  function compareBags(a, b) {
    return b.pool.coins - a.pool.coins || b.pool.stars - a.pool.stars || a.id - b.id;
  }

  function parseBags(payload, rid, receivedAt) {
    payload = normalizePayload(payload);
    // Response schema reference: upstream docs/DOUYU_REDPACKET_API.md; independently rechecked 2026-10-22.
    // https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/docs/DOUYU_REDPACKET_API.md
    if (!payload || payload.error === undefined || payload.error === null || Number(payload.error) !== 0 || !Array.isArray(payload.data?.redBagList)) {
      throw new Error('红包列表响应格式变化，或接口拒绝请求');
    }
    return payload.data.redBagList.filter(item => Number(item.status) === 0 && safeId(item.id) &&
      typeof item.code === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(item.code)).map(item => ({
      rid: safeId(rid), id: Number(item.id), code: item.code,
      name: String(payload.data.anchorName || rid).slice(0, 50),
      pool: prizes(item.prizeList), receivedAt
    })).filter(item => item.rid);
  }

  function classify(payload) {
    payload = normalizePayload(payload);
    // Error-code reference: upstream classifySnatchResponse; local stop conditions and validation differ.
    // https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/features/redbag/RedBagState.js
    if (!payload || payload.error === undefined || payload.error === null || !Number.isFinite(Number(payload.error))) return 'unknown';
    const error = Number(payload.error), msg = String(payload.msg || '');
    if (error === 0) return Array.isArray(payload.data?.prizeList) ? 'success' : 'unknown';
    if (/上限|限额/.test(msg) && /每日|今日|当天|领取|次数|金币|达到/.test(msg)) return 'limit';
    if (/登录|鉴权|csrf|token|凭证/i.test(msg) || error === -9) return 'auth';
    if (/验证|风控|操作频繁|请求频繁|账号异常|禁止参与|限制参与/.test(msg)) return 'risk';
    if (/已领取|领取过|重复领取/.test(msg)) return 'already';
    if (error === 12001 || /已派完|已抢完|已结束|已过期|抢光/.test(msg)) return 'exhausted';
    if (error === 12006) return 'waiting';
    return 'unknown';
  }

  function readOfficialTimer(doc, bagId, at) {
    if (!safeId(bagId)) return null;
    // Read the current official per-packet DOM, never waitSec or createTime.
    // Verified against live-new-anchor-support-preset_6221876.js, BagReady.js.
    const marker = doc.getElementById(`LiveNewAnchorSupportT-bagReadySvga-${bagId}`);
    const bag = marker?.closest('.LiveNewAnchorSupportT-singleBag');
    if (!bag) return null;
    const text = bag.querySelector('.LiveNewAnchorSupportT-singleBag--btn')?.textContent.trim();
    const match = text?.match(/^(\d{1,4})\s*秒后可抢$/);
    if (match && Number(match[1]) > 0) return { bagId: String(bagId), state: 'countdown',
      remainingSec: Number(match[1]), observedAt: at, source: 'official-dom' };
    const button = bag.querySelector('.LiveNewAnchorSupportT-singleBag--btnOpen');
    if (!text && button && button.style.display !== 'none' && !button.hidden) return {
      bagId: String(bagId), state: 'available', remainingSec: 0, observedAt: at, source: 'official-dom' };
    return null;
  }

  function observedTimer(worker, bagId, at) {
    const timer = worker?.timer;
    if (!timer || timer.source !== 'official-dom' || String(timer.bagId) !== String(bagId) ||
        !Number.isFinite(timer.observedAt) || at - timer.observedAt > 5000 || timer.observedAt > at + 1000 ||
        !Number.isInteger(timer.remainingSec) || timer.remainingSec < 0 || timer.remainingSec > 9999 ||
        !['countdown', 'available'].includes(timer.state) || (timer.state === 'available') !== (timer.remainingSec === 0)) return null;
    return { ...timer };
  }

  async function claimInRoom(api, rid, bagId) {
    const payload = normalizePayload(await api.room(rid));
    if (payload?.error != null && Number(payload.error) !== 0) return payload;
    const bags = parseBags(payload, rid, Date.now());
    const original = payload.data.redBagList.find(item => Number(item.id) === Number(bagId));
    if (original && Number(original.status) === 3) return { localState: 'ended' };
    const bag = bags.find(item => item.id === Number(bagId));
    if (!bag) return { localState: 'missing' };
    return api.claim(bag);
  }

  function workerReply(payload) {
    payload = normalizePayload(payload);
    if (['ended', 'missing', 'waiting'].includes(payload?.localState)) return { localState: payload.localState };
    const result = classify(payload);
    const messages = { limit: '已达到每日领取上限', auth: '请重新登录', risk: '需要验证',
      already: '已领取', exhausted: '红包已结束', waiting: '稍等会儿才能抢', success: 'success', unknown: '未知响应' };
    return { error: payload?.error, msg: messages[result], data: {
      ...(Array.isArray(payload?.data?.prizeList) ? { prizeList: payload.data.prizeList.map(item => ({
        num: number(item.num), prizeType: number(item.prizeType ?? item.ptype, -1)
      })) } : {})
    } };
  }

  class WorkerBridge {
    constructor(deps) { Object.assign(this, deps); this.pending = new Map(); }
    claim(token, bagId) {
      const key = this.key(token), task = this.get(key);
      if (!task) return Promise.reject(new Error('工作页任务已取消'));
      if (!task.ready) return Promise.resolve({ localState: 'waiting' });
      if ([...this.pending.values()].some(item => item.token === token)) return Promise.reject(new Error('该工作页正在领取'));
      const requestId = this.id();
      return new Promise((resolve, reject) => {
        let listener, timeout;
        const finish = (error, payload) => {
          if (!this.pending.has(requestId)) return;
          this.pending.delete(requestId); this.unlisten(listener); this.clearTimer(timeout);
          if (error) reject(error); else resolve(payload);
        };
        listener = this.listen(key, (_key, _old, value) => {
          if (!value || value.revoked) { finish(new Error('工作页任务已取消')); return; }
          if (value.response?.requestId !== requestId) return;
          if (value.response.error) finish(new Error(value.response.error));
          else finish(null, value.response.payload);
        });
        timeout = this.setTimer(() => finish(new Error('工作页未及时响应领取请求')), 90000);
        this.pending.set(requestId, { token, cancel: () => finish(new Error('领取请求已取消')) });
        try {
          // Only the bag id is shared. The worker obtains code and CSRF values locally.
          this.set(key, { ...task, command: { requestId, bagId, at: this.now() }, response: null });
        } catch (error) { finish(error); }
      });
    }
    cancelAll() { for (const item of [...this.pending.values()]) item.cancel(); }
  }

  function csrfConfig(source) {
    // Adapted from extractDouyuCsrfConfig (MIT), with additional field-name validation.
    // https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/platform/douyu/CsrfConfig.js
    const text = String(source).replaceAll('\\"', '"').replaceAll("\\'", "'");
    const read = key => text.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']*)["']`))?.[1] || '';
    const field = read('tn'), tokenKey = read('tvk'), prefix = read('cookie_pre');
    const cookie = prefix && tokenKey && !tokenKey.startsWith(prefix) ? prefix + tokenKey : tokenKey;
    return /^[a-zA-Z0-9_]{1,60}$/.test(field) && /^[a-zA-Z0-9_]{1,100}$/.test(cookie)
      ? { field, cookie } : null;
  }

  function freshDB(old = {}, now = Date.now()) {
    const db = { records: [], done: [], retryAfter: {}, day: dayKey(now), requests: 0, claims: 0, coins: 0, stars: 0,
      stopped: null, ...old, ...(old.day !== dayKey(now)
        ? { day: dayKey(now), requests: 0, claims: 0, coins: 0, stars: 0, done: [], retryAfter: {}, stopped: null } : {}) };
    if (db.schemaVersion !== 2) {
      const terminal = new Set(), unfinished = new Set();
      for (const record of db.records) {
        if (!safeId(record.rid) || !safeId(record.bagId)) continue;
        const key = `${record.rid}:${record.bagId}`;
        (['success', 'exhausted', 'already'].includes(record.kind) ? terminal : unfinished).add(key);
      }
      db.done = db.done.filter(key => !unfinished.has(key) || terminal.has(key));
      db.schemaVersion = 2;
    }
    return db;
  }

  class Engine {
    constructor(deps) {
      Object.assign(this, deps);
      this.jobs = new Map(); this.candidates = []; this.inFlight = new Map();
      this.running = false; this.generation = 0; this.discovering = false; this.ticking = false;
      this.nextScan = 0; this.failures = 0; this.notice = '尚未启动';
      this.db = freshDB(this.loadDB(), this.now()); this.saveDB(this.db);
    }
    settings() { return options(this.loadSettings()); }
    persist() { this.saveDB(this.db); }
    log(kind, text, extra = {}) {
      this.db.records.unshift({ at: this.now(), kind, text: String(text).slice(0, 160), ...extra });
      this.db.records = this.db.records.slice(0, 300); this.persist();
    }
    current(gen) { return this.running && gen === this.generation; }
    async start() {
      if (this.running) return;
      this.db = freshDB(this.loadDB(), this.now());
      if (this.db.stopped && ['limit', 'cap'].includes(this.db.stopped.kind)) {
        this.notice = this.db.stopped.text; this.persist(); return false;
      }
      if (this.settings().dailyCap && this.db.claims >= this.settings().dailyCap) {
        this.stop('cap', '已达到自定每日领取次数，已停止'); return false;
      }
      this.running = true; this.generation++; this.nextScan = 0; this.failures = 0;
      this.db.stopped = null; this.persist(); this.notice = '正在查询活动房间';
      this.log('start', `开始后台找包，金币奖池门槛 ${this.settings().minCoins}`);
      return true;
    }
    stop(kind = 'manual', text = '已手动停止') {
      this.running = false; this.generation++; this.notice = text;
      for (const job of this.jobs.values()) { job.tab?.close(); this.revoke(job.token); }
      this.jobs.clear(); this.inFlight.clear(); this.candidates = [];
      this.abort?.();
      this.db.stopped = { day: dayKey(this.now()), kind, text };
      this.log('stop', text); this.onStop?.(kind);
    }
    finish(job, kind, text, reward) {
      job.tab?.close(); this.revoke(job.token); this.jobs.delete(job.key);
      if (['success', 'exhausted', 'already'].includes(kind)) {
        if (!this.db.done.includes(job.key)) this.db.done.push(job.key);
        delete this.db.retryAfter[job.key];
      } else {
        this.db.retryAfter[job.key] = this.now() + 300000;
      }
      this.db.done = this.db.done.slice(-3000);
      if (kind === 'success') {
        this.db.claims++; this.db.coins += reward.coins; this.db.stars += reward.stars;
      }
      this.log(kind, text, { rid: job.rid, bagId: job.id, ...(reward || {}) });
    }
    async discover(gen) {
      if (this.discovering || !this.current(gen)) return;
      this.discovering = true;
      try {
        const s = this.settings(), payload = await this.api.square();
        if (!this.current(gen)) return;
        if (!payload || payload.error == null || Number(payload.error) !== 0 || !Array.isArray(payload.data?.redBagList)) {
          const outcome = classify(payload);
          if (['auth', 'risk', 'limit'].includes(outcome)) {
            this.stop(outcome, outcome === 'limit' ? '斗鱼已提示每日上限，已停止' : '接口要求登录或验证，已停止'); return;
          }
          throw new Error('候选列表接口格式变化');
        }
        const rooms = [...new Set(payload.data.redBagList.map(v => safeId(v.rid)).filter(Boolean))].slice(0, s.probeCount);
        let cursor = 0, probeFailures = 0;
        const found = [];
        await Promise.all(Array.from({ length: Math.min(3, rooms.length) }, async () => {
          while (cursor < rooms.length && this.current(gen)) {
            const rid = rooms[cursor++];
            try {
              const result = await this.api.room(rid);
              if (!this.current(gen)) return;
              const outcome = classify(result);
              if (['auth', 'risk', 'limit'].includes(outcome)) {
                this.stop(outcome, outcome === 'limit' ? '斗鱼已提示每日领取上限，已停止' : '房间查询要求登录或验证，已停止'); return;
              }
              found.push(...parseBags(result, rid, this.now()));
            } catch { probeFailures++; }
          }
        }));
        if (!this.current(gen)) return;
        if (rooms.length && probeFailures === rooms.length) throw new Error('本轮房间明细查询全部失败');
        const map = new Map();
        for (const bag of found) {
          const key = keyOf(bag);
          if (!this.jobs.has(key) && !this.inFlight.has(key) && !this.db.done.includes(key) &&
              !(this.db.retryAfter[key] > this.now()) &&
              bag.pool.coins >= s.minCoins) map.set(key, bag);
        }
        this.candidates = [...map.values()].sort(compareBags);
        this.notice = `本轮查询 ${rooms.length} 个房间，符合筛选条件 ${this.candidates.length} 个`;
        this.failures = 0; this.nextScan = this.now() + s.scanSeconds * 1000;
      } catch (error) {
        if (!this.current(gen)) return;
        this.failures++;
        this.nextScan = this.now() + Math.min(300000, 30000 * 2 ** (this.failures - 1));
        this.notice = `查询失败，${Math.round((this.nextScan - this.now()) / 1000)} 秒后重试`;
        this.log('error', `查询失败（${this.failures}/3）：${error.message}`);
        if (this.failures >= 3) this.stop('error', '连续三轮查询失败，已停止；请检查网络或接口');
      } finally { this.discovering = false; }
    }
    async bind(bag, gen) {
      const key = keyOf(bag); this.inFlight.set(key, gen);
      try {
        const payload = await this.api.room(bag.rid);
        if (!this.current(gen)) return;
        const outcome = classify(payload);
        if (['auth', 'risk', 'limit'].includes(outcome)) {
          this.stop(outcome, outcome === 'limit' ? '斗鱼已提示每日领取上限，已停止' : '房间查询要求登录或验证，已停止'); return;
        }
        const current = parseBags(payload, bag.rid, this.now()).find(item => keyOf(item) === key);
        const s = this.settings();
        if (!current || current.pool.coins < s.minCoins || this.db.done.includes(key)) return;
        if (this.api.enter) {
          const entry = await this.api.enter(current);
          if (!this.current(gen)) return;
          if (entry?.error == null || Number(entry.error) !== 0) {
            const result = classify(entry);
            if (['limit', 'auth', 'risk'].includes(result)) {
              this.stop(result, result === 'limit' ? '斗鱼已提示每日领取上限，已停止全部任务' : '进入活动时需要登录或验证，已停止');
            } else this.log('error', '活动入口登记失败，暂不打开工作页', { rid: current.rid, bagId: current.id });
            return;
          }
        }
        const token = this.makeToken();
        const job = { ...current, key, token, openedAt: this.now(), tries: 0, lastTry: 0,
          step: 'loading', due: 0, startedAt: this.now(), timer: null,
          deadlineAt: this.now() + (s.maxWait + 120) * 1000, missing: 0 };
        this.prepare(token, current.rid, current.id);
        this.jobs.set(key, job);
        job.tab = this.openTab(`https://www.douyu.com/${current.rid}#dy-star-worker=${token}`);
        if (!job.tab || typeof job.tab.close !== 'function') {
          this.finish(job, 'error', '后台标签页打开失败'); return;
        }
        this.log('room', `后台打开 ${current.name}，金币奖池 ${current.pool.coins}`, { rid: current.rid });
      } catch (error) {
        if (this.current(gen)) this.log('error', `准备房间失败：${error.message}`, { rid: bag.rid });
      } finally { if (this.inFlight.get(key) === gen) this.inFlight.delete(key); }
    }
    async process(job, gen) {
      if (!this.current(gen) || !this.jobs.has(job.key) || job.busy) return;
      if (job.tab?.closed) { this.finish(job, 'closed', '工作标签页已关闭'); return; }
      if (this.now() >= job.deadlineAt) { this.finish(job, 'not_ready', '任务等待超时，稍后重新检查'); return; }
      const timer = observedTimer(this.ready(job.token), job.id, this.now());
      job.timer = timer;
      if (!timer) {
        job.step = 'reading';
        job.unreadSince ||= this.now();
        if (this.now() - job.unreadSince > (job.sawTimer ? 30000 : 120000)) this.finish(job, 'timeout', '未读到该红包的官方倒计时，稍后重新检查');
        return;
      }
      job.unreadSince = 0;
      if (timer.remainingSec > this.settings().maxWait) {
        this.finish(job, 'filter', `官方页面剩余 ${timer.remainingSec} 秒，超过最长等待设置，暂时跳过`); return;
      }
      if (!job.sawTimer) {
        job.sawTimer = true;
        this.log('ready', `房间 ${job.rid} 已读取该红包的官方页面状态`, { rid: job.rid, bagId: job.id });
      }
      if (timer.state === 'countdown') { job.step = 'waiting'; return; }
      job.serverWaitDeadline ||= this.now() + 120000;
      if (this.now() >= job.serverWaitDeadline) { this.finish(job, 'not_ready', '官方页面已可领，但服务端持续未允许领取，稍后重新检查'); return; }
      job.step = 'available';
      if (this.now() < job.due) return;
      if (this.settings().dailyCap && this.db.claims >= this.settings().dailyCap) {
        this.stop('cap', '已达到自定每日领取次数，已停止'); return;
      }
      if (this.settings().dailyCap && this.db.claims + [...this.jobs.values()].filter(item => item.busy).length >= this.settings().dailyCap) return;
      job.busy = true;
      try {
        job.tries++; job.lastTry = this.now(); job.step = 'claiming';
        this.db.requests++; this.persist();
        const payload = normalizePayload(await this.api.claim(job));
        if (!this.current(gen)) return;
        if (payload?.localState === 'ended') {
          this.finish(job, 'exhausted', '工作页确认红包已结束，继续下一任务'); return;
        }
        if (payload?.localState === 'missing') {
          await this.continueWaiting(job, gen, '工作页未找到该红包'); return;
        }
        if (payload?.localState === 'waiting') { job.step = 'reading'; job.due = this.now() + 2000; return; }
        const result = classify(payload);
        if (result === 'success') {
          const reward = prizes(payload.data.prizeList);
          this.finish(job, 'success', `到账：金币 ${reward.coins}，星光棒 ${reward.stars}`, reward);
          if (this.settings().dailyCap && this.db.claims >= this.settings().dailyCap) this.stop('cap', '已达到自定每日领取次数，已停止');
        } else if (result === 'limit') {
          this.stop('limit', '斗鱼已提示每日领取上限，已停止全部任务');
        } else if (result === 'auth' || result === 'risk') {
          this.stop(result, result === 'auth' ? '登录状态或请求凭证失效，已停止' : '斗鱼要求验证或限制参与，已停止');
        } else if (['exhausted', 'already'].includes(result)) {
          this.finish(job, result, result === 'already' ? '该红包已领取' : '红包已派完，继续找下一包');
        } else if (result === 'waiting') {
          await this.continueWaiting(job, gen, '服务端返回12006');
        } else {
          this.finish(job, 'unknown', '领取响应无法确认');
          this.stop('protocol', '领取接口出现未知响应，已停止，请查看记录');
        }
      } catch (error) {
        if (!this.current(gen)) return;
        this.finish(job, 'unknown', `请求失败，结果未确认：${error.message}`);
        this.stop('error', '领取请求失败，已停止以避免重复提交');
      } finally { job.busy = false; }
    }
    async continueWaiting(job, gen, reason) {
      let status = null;
      try {
        const payload = normalizePayload(await this.api.room(job.rid));
        if (!this.current(gen)) return;
        if (Number(payload?.error) === 0 && Array.isArray(payload.data?.redBagList)) {
          const same = payload.data.redBagList.find(item => Number(item.id) === job.id);
          if (same) {
            job.missing = 0; status = Number(same.status);
            if (status === 3) { this.finish(job, 'exhausted', '复查确认红包已结束，继续下一任务'); return; }
            // waitSec is not a remaining-time signal; the official per-packet DOM is.
            if (typeof same.code === 'string') job.code = same.code;
          } else if (++job.missing >= 2) {
            this.finish(job, 'missing', '连续两次未查到该红包，稍后重新检查'); return;
          }
        } else {
          const result = classify(payload);
          if (['limit', 'auth', 'risk'].includes(result)) {
            this.stop(result, result === 'limit' ? '斗鱼已提示每日领取上限，已停止全部任务' : '复查时登录状态失效或需要验证，已停止'); return;
          }
        }
      } catch {
        if (!this.current(gen)) return;
      }
      const elapsedSec = Math.round((this.now() - job.startedAt) / 1000);
      if (this.now() >= job.deadlineAt) {
        this.finish(job, 'not_ready', `等待 ${elapsedSec} 秒后仍未满足领取条件，5分钟后重新检查`);
        return;
      }
      job.step = 'available'; job.due = Math.min(job.deadlineAt, this.now() + 2000);
      this.log('waiting', `房间 ${job.rid} 服务端暂未允许领取，2秒后再次核对官方状态`,
        { rid: job.rid, bagId: job.id, attempt: job.tries, elapsedSec, serverStatus: status, reason });
    }
    async tick() {
      if (!this.running || this.ticking) return;
      this.ticking = true;
      const gen = this.generation;
      try {
        const fresh = freshDB(this.db, this.now());
        if (fresh.day !== this.db.day) { this.db = fresh; this.persist(); }
        for (const job of [...this.jobs.values()]) {
          // One room's response must not block another room's actual countdown.
          void this.process(job, gen).catch(() => { if (this.current(gen)) this.stop('error', '任务处理异常，已停止'); });
          await Promise.resolve(); if (!this.current(gen)) return;
        }
        if (this.now() >= this.nextScan && this.jobs.size + this.inFlight.size < this.settings().concurrency && !this.discovering) {
          // Discovery runs independently so slow probes cannot block a due claim.
          void this.discover(gen);
        }
        while (this.current(gen) && this.jobs.size + this.inFlight.size < this.settings().concurrency && this.candidates.length) {
          const bag = this.candidates.shift();
          if (this.now() - bag.receivedAt > 180000 || this.db.done.includes(keyOf(bag))) continue;
          void this.bind(bag, gen);
        }
      } finally { this.ticking = false; }
    }
    snapshot() {
      return { running: this.running, notice: this.notice, nextScan: this.nextScan, queue: this.candidates.length,
        db: this.db, jobs: [...this.jobs.values()].map(job => ({ rid: job.rid, name: job.name,
          coins: job.pool.coins, step: job.step, tries: job.tries, timer: observedTimer({ timer: job.timer }, job.id, this.now()) })) };
    }
  }

  const Core = { BASE, RELEASE, normalizePayload, compareVersions, parseUpdateMeta, fetchRelease, clampPosition, bindDrag, registeredWorker, backgroundFrames,
    DEFAULTS, options, prizes, compareBags, parseBags, classify, readOfficialTimer, observedTimer, claimInRoom, workerReply, WorkerBridge, csrfConfig, freshDB, dayKey, Engine };
  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') module.exports = Core;
    return;
  }
  if (window.top !== window || !/^\/\d+\/?$/.test(location.pathname)) return;

  // Install in the page realm before official scripts can capture the native rAF function.
  const earlyToken = location.hash.match(/(?:^#|&)dy-star-worker=([a-f0-9]{32})(?:&|$)/)?.[1];
  let restoreFrames = () => {};
  if (earlyToken && registeredWorker(GM_getValue(`bg2.worker.${earlyToken}`, null), GM_getValue('bg2.lease', null), Date.now())) {
    const page = typeof unsafeWindow === 'object' ? unsafeWindow : window;
    restoreFrames = backgroundFrames(page, document);
    window.addEventListener('pagehide', restoreFrames, { once: true });
  }
  const boot = () => bootstrap(Core, restoreFrames);
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  function bootstrap(core, restoreFrames) {
    const PREF = 'bg2.preferences', DB = 'bg2.database', LEASE = 'bg2.lease', SNAP = 'bg2.snapshot';
    const workerKey = token => `bg2.worker.${token}`;
    const readPrefs = () => ({ enabled: false, controlPath: '', ...GM_getValue(PREF, {}), ...core.options(GM_getValue(PREF, {})) });
    const writePrefs = values => GM_setValue(PREF, { ...readPrefs(), ...values });
    const uuid = () => crypto.randomUUID().replaceAll('-', '');
    const owner = uuid();
    const rid = location.pathname.match(/\d+/)[0];
    const marker = location.hash.match(/(?:^#|&)dy-star-worker=([a-f0-9]{32})(?:&|$)/)?.[1];
    const requests = new Set();
    let releaseLock = null, acquiring = false, config = null, root, shadow, card, collapsed;
    let lastSnapshot = null;
    let compactView = false, checkingVersion = false;
    const currentVersion = typeof GM_info === 'object' ? String(GM_info.script?.version || '') : '';
    let apiOriginRid = rid;
    if (marker) { runWorker(marker); return; }
    const bridge = new core.WorkerBridge({ key: workerKey, get: key => GM_getValue(key, null),
      set: (key, value) => GM_setValue(key, value), listen: GM_addValueChangeListener,
      unlisten: GM_removeValueChangeListener, id: uuid, now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: id => clearTimeout(id) });

    function realRid() {
      const source = [...document.scripts].filter(script => !script.src).map(script => script.textContent).join('\n');
      return source.match(/window\.room_id\s*=\s*['"]?(\d+)/)?.[1] || rid;
    }
    function runWorker(token) {
      const key = workerKey(token);
      const initial = GM_getValue(key, null);
      const rid = safeId(initial?.rid), bagId = safeId(initial?.bagId);
      // Only a task actually registered by this script may mark itself ready or close itself.
      if (!initial || !rid || !bagId || initial.expires < Date.now()) return;
      config = embeddedConfig() || initial.csrfConfig;
      let lastOpen = 0, busy = false, lastCommand = '', lastObservation = 0, observer = null, observePending = null;
      const mute = () => document.querySelectorAll('video,audio').forEach(media => { media.muted = true; });
      mute();
      document.addEventListener('play', mute, true);
      function sampleTimer() {
        return core.readOfficialTimer(document, bagId, Date.now());
      }
      function observeTimer() {
        const task = GM_getValue(key, null);
        if (!valid(task)) return;
        const timer = sampleTimer();
        if (Date.now() - lastObservation >= 1000 || timer?.state !== task.timer?.state || timer?.remainingSec !== task.timer?.remainingSec) {
          lastObservation = Date.now();
          GM_setValue(key, { ...task, timer, ready: Boolean(timer), readyAt: task.readyAt || (timer ? Date.now() : 0) });
        }
        if (!timer && Date.now() - lastOpen > 3000) {
          lastOpen = Date.now();
          let entry = document.querySelector('.LiveNewAnchorSupportT-enter');
          if (!entry) {
            // Official Next room's star-recommendation box icons, not generic reward boxes.
            const icon = document.querySelector('[class*="boxIcon__"][style*="box1.15a9ced1.png"], [class*="boxIcon__"][style*="box2.c8812ce6.png"]');
            entry = icon?.closest('[class*="container__"]');
          }
          entry?.click();
        }
      }
      function valid(task) {
        const lease = GM_getValue(LEASE, {});
        return task && task.owner === initial.owner && task.rid === initial.rid && String(task.bagId) === bagId &&
          !task.revoked && task.expires >= Date.now() && lease.owner === initial.owner && lease.until >= Date.now() - 90000;
      }
      function cleanup(close = false) {
        clearInterval(workerTimer); GM_removeValueChangeListener(listener);
        restoreFrames();
        observer?.disconnect(); clearTimeout(observePending);
        for (const controller of requests) controller.abort();
        if (close) window.close();
      }
      async function dispatch() {
        const task = GM_getValue(key, null), command = task?.command;
        if (busy || !valid(task) || !command || command.requestId === lastCommand) return;
        if (String(command.bagId) !== bagId) return;
        busy = true; lastCommand = command.requestId;
        let response;
        try {
          const allowed = () => {
            const latest = GM_getValue(key, null);
            return valid(latest) && latest.command?.requestId === command.requestId && sampleTimer()?.state === 'available';
          };
          const timer = sampleTimer();
          const payload = timer?.state === 'available'
            ? await core.claimInRoom({ room: id => request(`${BASE}/redbag/room/list?rid=${id}`),
              claim: job => claim(job, allowed) }, rid, command.bagId)
            : { localState: 'waiting' };
          response = { requestId: command.requestId, payload: core.workerReply(payload) };
        } catch (error) { response = { requestId: command.requestId, error: String(error.message).slice(0, 160) }; }
        finally { busy = false; }
        const latest = GM_getValue(key, null);
        if (valid(latest) && latest.command?.requestId === command.requestId) GM_setValue(key, { ...latest, response });
      }
      const listener = GM_addValueChangeListener(key, (_key, _old, task) => {
        if (!task || task.revoked) {
          cleanup(true); return;
        }
        void dispatch();
      });
      const workerTimer = setInterval(() => {
        mute();
        const task = GM_getValue(key, null);
        if (!valid(task)) {
          cleanup(true); return;
        }
        observeTimer();
        void dispatch();
      }, 1000);
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(() => {
          if (observePending !== null) return;
          observePending = setTimeout(() => { observePending = null; observeTimer(); }, 100);
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
      }
      window.addEventListener('pagehide', () => cleanup(), { once: true });
      document.addEventListener('visibilitychange', () => { observeTimer(); void dispatch(); });
      observeTimer();
    }

    async function request(path, init = {}) {
      const url = new URL(path, location.origin);
      if (url.origin !== 'https://www.douyu.com') throw new Error('请求域名异常');
      const controller = new AbortController(); requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url.href, { ...init, credentials: 'include', signal: controller.signal,
          headers: { Accept: 'application/json, text/plain, */*', ...init.headers } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload || typeof payload !== 'object') throw new Error('接口未返回数据对象');
        return core.normalizePayload(payload);
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('网络请求超时或已取消');
        throw new Error(error instanceof SyntaxError ? '接口未返回 JSON 数据' : '网络请求失败');
      } finally { clearTimeout(timeout); requests.delete(controller); }
    }
    function embeddedConfig() {
      return core.csrfConfig([...document.scripts].filter(script => !script.src).map(script => script.textContent).join('\n'));
    }
    function cookieValue(name) {
      const part = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
      if (!part) return '';
      try { return decodeURIComponent(part.slice(name.length + 1)); } catch { return ''; }
    }
    async function postForm(path, fields, allowed = () => true) {
      if (!allowed()) return { localState: 'waiting' };
      config = embeddedConfig() || config;
      if (!config) throw new Error('页面缺少动态请求配置');
      let token = cookieValue(config.cookie);
      if (!token) { await request('/wgapi/livenc/liveweb/csrfApi/getCsrfCookie'); token = cookieValue(config.cookie); }
      if (!allowed()) return { localState: 'waiting' };
      if (!token) throw new Error('登录凭证不可用');
      const body = new URLSearchParams({ ...fields, [config.field]: token });
      return request(path, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: body.toString() });
    }
    async function claim(job, allowed) {
      return postForm(`${BASE}/redbag/snatch`, { rid: job.rid, id: String(job.id), code: job.code }, allowed);
    }
    const engine = new core.Engine({
      now: () => Date.now(), loadDB: () => GM_getValue(DB, {}), saveDB: value => GM_setValue(DB, value),
      loadSettings: readPrefs, makeToken: uuid,
      api: { square: () => request(`${BASE}/redbag/square/list?rid=${apiOriginRid}`),
        // The current official recommendation entry calls square/read before opening a room.
        // https://shark2.douyucdn.cn/front-publish/new-anchor-support-master/js/main_c840364.js
        enter: bag => postForm(`${BASE}/redbag/square/read`, { rid: bag.rid, rbId: String(bag.id) }),
        room: id => request(`${BASE}/redbag/room/list?rid=${id}`), claim: job => bridge.claim(job.token, job.id) },
      prepare: (token, roomId, bagId) => GM_setValue(workerKey(token), { owner, rid: roomId, bagId: String(bagId), csrfConfig: config,
        ready: false, readyAt: 0, expires: Date.now() + 40 * 60000 }),
      revoke: token => GM_deleteValue(workerKey(token)),
      ready: token => GM_getValue(workerKey(token), {}),
      openTab: url => GM_openInTab(url, { active: false, insert: true, setParent: true }),
      abort: () => { bridge.cancelAll(); for (const request of requests) request.abort(); },
      onStop: () => {
        writePrefs({ enabled: false });
        const lease = GM_getValue(LEASE, {}); if (lease.owner === owner) GM_setValue(LEASE, {});
        if (releaseLock) { releaseLock(); releaseLock = null; }
      }
    });

    async function start() {
      if (engine.running || acquiring) return;
      acquiring = true;
      let gotLock = false;
      try {
        const existing = GM_getValue(LEASE, {});
        if (existing.owner && existing.owner !== owner && existing.until > Date.now()) {
          engine.notice = '另一个斗鱼页面正在运行；在原页面停止后再启动'; return;
        }
        if (navigator.locks?.request) {
          let report;
          const answer = new Promise(resolve => { report = resolve; });
          navigator.locks.request('douyu-star-bg2-controller', { ifAvailable: true }, async lock => {
            if (!lock) { report(false); return; }
            await new Promise(resolve => { releaseLock = resolve; report(true); });
          }).catch(() => report(false));
          gotLock = await answer;
          if (!gotLock) { engine.notice = '已有后台控制页正在运行'; return; }
        } else { engine.notice = '浏览器不支持任务互斥锁，请使用新版 Chrome / Edge / Firefox'; return; }
        config = embeddedConfig();
        if (!config) { engine.notice = '页面尚未就绪，请等待直播间加载后重试'; return; }
        apiOriginRid = realRid();
        const ok = await engine.start();
        if (!ok) return;
        GM_setValue(LEASE, { owner, until: Date.now() + 120000 });
        writePrefs({ enabled: true, controlPath: location.pathname });
        publish(); void engine.tick();
      } finally {
        acquiring = false;
        if (!engine.running && gotLock && releaseLock) { releaseLock(); releaseLock = null; }
        render();
      }
    }

    function publish() {
      lastSnapshot = engine.snapshot();
      if (engine.running) GM_setValue(LEASE, { owner, until: Date.now() + 120000 });
      GM_setValue(SNAP, { ...lastSnapshot, owner, at: Date.now() });
    }
    function stop() {
      if (engine.running) engine.stop('manual', '已手动停止，工作标签页已关闭');
      else { writePrefs({ enabled: false }); GM_setValue('bg2.stopRequest', { at: Date.now() }); engine.notice = '已发送停止请求'; }
      publish(); render();
    }

    function makeUI() {
      root = document.createElement('div'); root.id = 'dy-star-bg2';
      root.style.cssText = 'all:initial;position:fixed;left:18px;bottom:18px;z-index:2147483647';
      shadow = root.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>
        *{box-sizing:border-box}.card{width:370px;max-height:85vh;overflow:auto;padding:16px;background:#181b24;color:#e9edf4;border:1px solid #41495b;border-radius:14px;box-shadow:0 8px 36px #0006;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}header,nav,.row{display:flex;justify-content:space-between;gap:8px;align-items:center}header b{font-size:15px}button{font:inherit;border:0;border-radius:7px;background:#ff6c2d;color:#fff;padding:7px 11px;cursor:pointer}.secondary{background:#343c4c}.small{padding:3px 8px;background:#343c4c}.muted{color:#9da8bd;font-size:12px;margin:9px 0}.totals{display:flex;justify-content:space-between;padding:12px;background:#242a38;border-radius:9px;margin:12px 0}.totals strong{color:#ffb16c;font-size:20px;display:block}.totals small{color:#a9b3c6}details{margin-top:12px;border-top:1px solid #343c4c;padding-top:10px}summary{cursor:pointer;color:#bfc8d8}label{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:9px 0}input{width:105px;padding:5px;background:#10141c;border:1px solid #495268;border-radius:5px;color:#fff;font:inherit}input[type=checkbox]{width:auto}.jobs{display:grid;gap:6px;margin-top:10px}.job{padding:8px;background:#242a38;border-radius:7px;font-size:12px}a{color:#ffc18c;text-decoration:none}ol{max-height:220px;overflow:auto;margin:10px 0;padding-left:20px;font-size:11px;color:#aebbd1}li{margin:5px 0}.chip{font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;padding:9px 12px;box-shadow:0 4px 20px #0004}.hidden{display:none!important}.status{white-space:normal;word-break:break-word}
        .card{max-width:calc(100vw - 16px);max-height:calc(100vh - 16px)}header,.chip{touch-action:none;user-select:none;cursor:grab}header:active,.chip:active{cursor:grabbing}.release{margin-top:9px;font-size:12px;color:#a9b3c6;flex-wrap:wrap}button:disabled{opacity:.55;cursor:wait}.version-status:empty{display:none}
        .record-list{list-style:none;padding-left:0;max-height:220px;overflow:auto;margin:10px 0;font-size:11px;color:#aebbd1}
      </style><button class="chip" title="点击展开，拖动可调整位置">星推 · 已停止</button><section class="card hidden">
        <header title="拖动标题栏可调整位置"><b>斗鱼全民星推荐自动领取</b><button class="small fold">收起</button></header>
        <div class="row release"><span class="current-version"></span><button class="small update-check">检查版本</button><button class="small update-install hidden">更新到最新版</button></div>
        <p class="muted version-status" role="status" aria-live="polite"></p>
        <div class="totals"><div><strong class="coins">0</strong><small>今日实得金币</small></div><div><strong class="stars">0</strong><small>星光棒</small></div><div><strong class="claims">0</strong><small>已领红包</small></div></div>
        <nav><button class="start">开始后台领取</button><button class="stop secondary">停止</button><button class="refresh secondary">刷新</button></nav>
        <p class="muted status"></p><div class="jobs"></div>
        <details class="settings"><summary>筛选与运行设置</summary>
          <label>最低金币奖池<input name="minCoins" type="number" min="0" max="10000000" step="1000"></label>
          <label>同时后台房间数<input name="concurrency" type="number" min="1" max="6"></label>
          <label>扫描间隔（秒）<input name="scanSeconds" type="number" min="30" max="600"></label>
          <label>每轮最多查询房间<input name="probeCount" type="number" min="6" max="60"></label>
          <label>最长等待（秒）<input name="maxWait" type="number" min="30" max="1800"></label>
          <label>自定每日包数（0为不限）<input name="dailyCap" type="number" min="0" max="500"></label>
          <label>默认收起面板<input name="compact" type="checkbox"></label>
          <button class="save secondary">保存设置</button><p class="muted">按金币总奖池排序，实际分到的金币取决于斗鱼。达到斗鱼上限后停止，不会次日自动重启。</p>
        </details>
        <details class="records"><summary>领取记录与导出</summary><ul class="record-list"></ul><button class="export secondary">导出本地记录</button><button class="history secondary">查询斗鱼金币记录</button><p class="muted historyText"></p></details>
      </section>`;
      card = shadow.querySelector('.card'); collapsed = shadow.querySelector('.chip');
      collapsed.addEventListener('click', () => fold(false));
      shadow.querySelector('.fold').addEventListener('click', () => fold(true));
      shadow.querySelector('.start').addEventListener('click', () => start().catch(() => { engine.notice = '启动失败，请刷新后重试'; render(); }));
      shadow.querySelector('.stop').addEventListener('click', stop);
      shadow.querySelector('.refresh').addEventListener('click', () => { engine.nextScan = 0; if (engine.running) void engine.tick(); else { engine.notice = '请先开始后台领取'; render(); } });
      shadow.querySelector('.save').addEventListener('click', () => {
        const raw = {};
        shadow.querySelectorAll('input').forEach(input => { raw[input.name] = input.type === 'checkbox' ? input.checked : Number(input.value); });
        writePrefs(core.options(raw)); fillSettings(); engine.nextScan = 0;
        engine.notice = '设置已保存；新筛选条件用于下一轮任务'; render();
      });
      shadow.querySelector('.records').addEventListener('toggle', render);
      shadow.querySelector('.export').addEventListener('click', exportLog);
      shadow.querySelector('.history').addEventListener('click', coinHistory);
      shadow.querySelector('.current-version').textContent = `当前版本：${currentVersion || '未知'}`;
      shadow.querySelector('.update-check').addEventListener('click', checkVersion);
      shadow.querySelector('.update-install').addEventListener('click', openUpdatePage);
      document.documentElement.appendChild(root); fillSettings(); fold(readPrefs().compact); render(); keepUIVisible();
      const dragOptions = {
        rect: () => { const r = root.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; },
        viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
        move: position => positionUI(position),
        save: position => GM_setValue('bg2.uiPositions', { ...GM_getValue('bg2.uiPositions', {}), [compactView ? 'chip' : 'panel']: position })
      };
      core.bindDrag(shadow.querySelector('header'), dragOptions);
      core.bindDrag(collapsed, dragOptions);
      window.addEventListener('resize', keepUIVisible);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(keepUIVisible).observe(root);
    }
    function positionUI(position) {
      const rect = root.getBoundingClientRect();
      const safe = core.clampPosition(position, rect, { width: window.innerWidth, height: window.innerHeight });
      root.style.left = `${safe.x}px`; root.style.top = `${safe.y}px`; root.style.bottom = 'auto';
    }
    function keepUIVisible() {
      const rect = root.getBoundingClientRect(); positionUI({ x: rect.left, y: rect.top });
    }
    function fold(value) {
      compactView = value; card.classList.toggle('hidden', value); collapsed.classList.toggle('hidden', !value);
      const saved = GM_getValue('bg2.uiPositions', {})?.[value ? 'chip' : 'panel'];
      positionUI(saved || { x: 18, y: window.innerHeight - root.getBoundingClientRect().height - 18 });
    }
    function openUpdatePage() { GM_openInTab(core.RELEASE.downloadURL, { active: true, insert: true, setParent: true }); }
    async function checkVersion() {
      if (checkingVersion) return;
      checkingVersion = true;
      const button = shadow.querySelector('.update-check'), install = shadow.querySelector('.update-install');
      const status = shadow.querySelector('.version-status');
      button.disabled = true; button.textContent = '检查中…'; install.classList.add('hidden'); status.textContent = '正在检查新版本…';
      try {
        core.compareVersions(currentVersion, currentVersion);
        const latest = await core.fetchRelease(details => GM_xmlhttpRequest(details));
        const order = core.compareVersions(latest, currentVersion);
        if (order > 0) {
          status.textContent = `发现新版本 ${latest}，当前为 ${currentVersion}`;
          install.textContent = `更新到 ${latest}`; install.classList.remove('hidden');
        } else status.textContent = order === 0 ? `已是最新版本 ${currentVersion}` : `本地版本较新，线上版本为 ${latest}`;
      } catch (error) { status.textContent = error.message || '检查失败，请稍后重试'; }
      finally { checkingVersion = false; button.disabled = false; button.textContent = '检查版本'; keepUIVisible(); }
    }
    function fillSettings() {
      const s = readPrefs(); shadow.querySelectorAll('input').forEach(input => {
        if (input.type === 'checkbox') input.checked = s[input.name]; else input.value = s[input.name];
      });
    }
    function render() {
      if (!shadow) return;
      const other = GM_getValue(SNAP, null), lease = GM_getValue(LEASE, {});
      const external = !engine.running && other?.owner !== owner && lease.owner && lease.until > Date.now();
      const snapshot = external ? other : engine.snapshot();
      const db = core.freshDB(GM_getValue(DB, {}));
      shadow.querySelector('.coins').textContent = db.coins;
      shadow.querySelector('.stars').textContent = db.stars;
      shadow.querySelector('.claims').textContent = db.claims;
      const running = Boolean(snapshot?.running && (engine.running || external));
      collapsed.textContent = `星推 · ${running ? '运行中' : '已停止'} · +${db.coins} 金币`;
      shadow.querySelector('.status').textContent = `${external ? '其他页面正在控制。' : ''}${snapshot?.notice || engine.notice}${running ? `；等待 ${snapshot.jobs.length} 间 / 队列 ${snapshot.queue} 包` : ''}`;
      const box = shadow.querySelector('.jobs'); box.replaceChildren();
      for (const job of snapshot?.jobs || []) {
        const line = document.createElement('div'); line.className = 'job';
        const anchor = document.createElement('a'); anchor.href = `https://www.douyu.com/${safeId(job.rid)}`;
        anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.textContent = job.name;
        line.appendChild(anchor);
        const timer = job.timer && Date.now() - job.timer.observedAt <= 5000 ? job.timer : null;
        const status = job.step === 'claiming' ? '领取中' : !timer ? '未读到倒计时'
          : timer.state === 'available' ? '官方页面显示可领取' : `页面倒计时 ${timer.remainingSec} 秒`;
        line.appendChild(document.createTextNode(` · 奖池 ${job.coins} 金币 · ${status}`)); box.appendChild(line);
      }
      if (shadow.querySelector('.records').open) {
        const list = shadow.querySelector('.record-list'); list.replaceChildren();
        for (const record of db.records.slice(0, 40)) {
          const li = document.createElement('li'); li.textContent = `${new Date(record.at).toLocaleTimeString()} ${record.text}`; list.appendChild(li);
        }
      }
    }
    function exportLog() {
      const db = core.freshDB(GM_getValue(DB, {}));
      const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `斗鱼星推记录-${core.dayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    async function coinHistory() {
      const target = shadow.querySelector('.historyText'); target.textContent = '正在查询…';
      try {
        const payload = await request(`${BASE}/coin/record/list?current=1&pageSize=100`);
        if (Number(payload.error) !== 0 || !Array.isArray(payload.data?.list)) throw new Error('请先登录斗鱼');
        const rows = payload.data.list.filter(item => Number(item.opDirection) === 1 && /红包/.test(String(item.remark)));
        target.textContent = `斗鱼最近100条金币流水中，红包收入 ${rows.length} 条，共 ${rows.reduce((n, item) => n + Math.abs(number(item.balanceDiff)), 0)} 金币（并非今日全部）`;
      } catch { target.textContent = '金币记录查询失败，请在官方活动页核对'; }
    }
    GM_registerMenuCommand('打开后台助手面板', () => fold(false));
    GM_registerMenuCommand('停止后台领取', stop);
    GM_registerMenuCommand('安装或更新到最新版', openUpdatePage);
    GM_addValueChangeListener('bg2.stopRequest', () => { if (engine.running) { engine.stop('manual', '已从其他页面停止'); publish(); render(); } });
    GM_addValueChangeListener(PREF, () => { if (engine.running && !readPrefs().enabled) { engine.stop('manual', '已停止'); publish(); } render(); });
    GM_addValueChangeListener(DB, render);
    GM_addValueChangeListener(SNAP, render);
    makeUI();
    setInterval(() => {
      const pref = readPrefs(), lease = GM_getValue(LEASE, {});
      if (!engine.running && !acquiring && pref.enabled && pref.controlPath === location.pathname &&
          (!lease.owner || lease.until < Date.now())) void start();
      if (engine.running) { publish(); engine.tick().catch(() => engine.stop('error', '任务异常，已停止')); }
      render();
    }, 1000);
    window.addEventListener('pagehide', () => {
      if (!engine.running) return;
      // Preserve the start preference for a deliberate refresh, but release our worker pages.
      for (const job of engine.jobs.values()) { job.tab?.close(); engine.revoke(job.token); }
      engine.running = false; engine.generation++; engine.jobs.clear(); engine.inFlight.clear(); engine.candidates = [];
      bridge.cancelAll();
      for (const controller of requests) controller.abort();
      if (GM_getValue(LEASE, {}).owner === owner) GM_setValue(LEASE, {});
      if (releaseLock) { releaseLock(); releaseLock = null; }
    });
    if (readPrefs().enabled && readPrefs().controlPath === location.pathname) setTimeout(() => void start(), 5000);
  }
})();
