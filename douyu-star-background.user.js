// ==UserScript==
// @name         斗鱼全民星推荐自动领取
// @namespace    local.douyu.star.helper
// @version      2.0.0
// @description  后台自动领取全民星推荐活动红包，支持奖池筛选、到账统计及每日上限自动停止。
// @homepageURL  https://github.com/ybl112/douyu-star-helper
// @supportURL   https://github.com/ybl112/douyu-star-helper/issues
// @downloadURL  https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.user.js
// @updateURL    https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.user.js
// @match        https://www.douyu.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        window.close
// @license      MIT
// ==/UserScript==

/*
 * Independently implemented controller. Protocol field mapping and the bounded
 * five-attempt schedule were adapted from ienone/douyu-qmx-pro (MIT):
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

/* global GM_getValue, GM_setValue, GM_deleteValue, GM_addValueChangeListener, GM_registerMenuCommand, GM_openInTab */
(function () {
  'use strict';

  const BASE = '/japi/livebiznc/web/anchorstardiscover';
  const DEFAULTS = Object.freeze({ minCoins: 10000, concurrency: 2, scanSeconds: 60,
    probeCount: 24, maxWait: 600, dailyCap: 0, compact: true });
  const number = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const dayKey = (at = Date.now()) => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  const safeId = value => /^\d{1,15}$/.test(String(value || '')) ? String(value) : '';
  const keyOf = bag => `${bag.rid}:${bag.id}`;

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
    return b.pool.coins - a.pool.coins || a.waitSec - b.waitSec || b.pool.stars - a.pool.stars || a.id - b.id;
  }

  function parseBags(payload, rid, receivedAt) {
    // Response schema reference: upstream docs/DOUYU_REDPACKET_API.md; independently rechecked 2026-10-22.
    // https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/docs/DOUYU_REDPACKET_API.md
    if (!payload || payload.error === undefined || payload.error === null || Number(payload.error) !== 0 || !Array.isArray(payload.data?.redBagList)) {
      throw new Error('红包列表响应格式变化，或接口拒绝请求');
    }
    return payload.data.redBagList.filter(item => Number(item.status) === 0 && safeId(item.id) &&
      typeof item.code === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(item.code) &&
      item.waitSec !== null && item.waitSec !== '' && Number.isFinite(Number(item.waitSec))).map(item => ({
      rid: safeId(rid), id: Number(item.id), code: item.code,
      name: String(payload.data.anchorName || rid).slice(0, 50),
      waitSec: Math.max(0, Number(item.waitSec)), pool: prizes(item.prizeList), receivedAt
    })).filter(item => item.rid);
  }

  function classify(payload) {
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

  function offsets(seconds) {
    // Adapted from getSnatchAttemptOffsets (MIT), preserving the five-attempt upper bound.
    // https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/features/redbag/RedBagState.js
    const wait = Math.max(30, Math.round(number(seconds, 90)));
    const first = Math.round(wait * (wait >= 300 ? 2 / 3 : 1 / 2));
    return [first, Math.max(first + 10, wait - 20), wait, wait + 20, wait + 50].map(s => s * 1000);
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
    return { records: [], done: [], day: dayKey(now), requests: 0, claims: 0, coins: 0, stars: 0,
      stopped: null, ...old, ...(old.day !== dayKey(now)
        ? { day: dayKey(now), requests: 0, claims: 0, coins: 0, stars: 0, done: [], stopped: null } : {}) };
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
      if (!this.db.done.includes(job.key)) this.db.done.push(job.key);
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
              bag.pool.coins >= s.minCoins && bag.waitSec <= s.maxWait) map.set(key, bag);
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
        const current = parseBags(payload, bag.rid, this.now()).find(item => keyOf(item) === key);
        const s = this.settings();
        if (!current || current.pool.coins < s.minCoins || current.waitSec > s.maxWait || this.db.done.includes(key)) return;
        const token = this.makeToken();
        const job = { ...current, key, token, openedAt: this.now(), tries: 0, lastTry: 0,
          step: 'loading', due: 0, delays: offsets(current.waitSec) };
        this.prepare(token, current.rid);
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
      if (job.step === 'loading') {
        if (!this.ready(job.token)) {
          if (this.now() - job.openedAt > 60000) this.finish(job, 'timeout', '工作页加载超时，请检查页面休眠设置');
          return;
        }
        job.step = 'waiting'; job.due = Math.max(job.openedAt + job.delays[0], this.now() + 1000);
      }
      if (this.now() < job.due) return;
      if (this.settings().dailyCap && this.db.claims >= this.settings().dailyCap) {
        this.stop('cap', '已达到自定每日领取次数，已停止'); return;
      }
      job.busy = true;
      try {
        job.tries++; job.lastTry = this.now(); job.step = 'claiming';
        this.db.requests++; this.persist();
        const payload = await this.api.claim(job);
        if (!this.current(gen)) return;
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
        } else if (result === 'waiting' && job.tries < job.delays.length) {
          job.step = 'waiting';
          // Absolute deadlines prevent a burst of requests after a suspended tab resumes.
          job.due = Math.max(job.openedAt + job.delays[job.tries], this.now() + 10000);
        } else if (result === 'waiting') {
          this.finish(job, 'timeout', '有限次等待后仍未开放，跳过该包');
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
    async tick() {
      if (!this.running || this.ticking) return;
      this.ticking = true;
      const gen = this.generation;
      try {
        const fresh = freshDB(this.db, this.now());
        if (fresh.day !== this.db.day) { this.db = fresh; this.persist(); }
        for (const job of [...this.jobs.values()]) {
          await this.process(job, gen); if (!this.current(gen)) return;
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
          coins: job.pool.coins, step: job.step, tries: job.tries, due: job.due })) };
    }
  }

  const Core = { BASE, DEFAULTS, options, prizes, compareBags, parseBags, classify, offsets, csrfConfig, freshDB, dayKey, Engine };
  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') module.exports = Core;
    return;
  }
  if (window.top !== window || !/^\/\d+\/?$/.test(location.pathname)) return;

  // Browser adapter and UI follow below.
  bootstrap(Core);

  function bootstrap(core) {
    const PREF = 'bg2.preferences', DB = 'bg2.database', LEASE = 'bg2.lease', SNAP = 'bg2.snapshot';
    const workerKey = token => `bg2.worker.${token}`;
    const readPrefs = () => ({ enabled: false, controlPath: '', ...GM_getValue(PREF, {}), ...core.options(GM_getValue(PREF, {})) });
    const writePrefs = values => GM_setValue(PREF, { ...readPrefs(), ...values });
    const uuid = () => crypto.randomUUID().replaceAll('-', '');
    const owner = uuid();
    const rid = location.pathname.match(/\d+/)[0];
    const marker = location.hash.match(/(?:^#|&)dy-star-worker=([a-f0-9]{32})(?:&|$)/)?.[1];
    if (marker) { runWorker(marker); return; }
    const requests = new Set();
    let releaseLock = null, acquiring = false, config = null, root, shadow, card, collapsed;
    let lastSnapshot = null;
    let apiOriginRid = rid;

    function realRid() {
      const source = [...document.scripts].filter(script => !script.src).map(script => script.textContent).join('\n');
      return source.match(/window\.room_id\s*=\s*['"]?(\d+)/)?.[1] || rid;
    }
    function runWorker(token) {
      const key = workerKey(token);
      const initial = GM_getValue(key, null);
      // Only a task actually registered by this script may mark itself ready or close itself.
      if (!initial || initial.rid !== rid || initial.expires < Date.now()) return;
      const loadedAt = Date.now();
      const mute = () => document.querySelectorAll('video,audio').forEach(media => { media.muted = true; });
      mute();
      document.addEventListener('play', mute, true);
      const workerTimer = setInterval(() => {
        mute();
        const task = GM_getValue(key, null), lease = GM_getValue(LEASE, {});
        if (!task || task.revoked || task.expires < Date.now() ||
            (lease.owner !== initial.owner || lease.until < Date.now() - 90000)) {
          clearInterval(workerTimer); window.close(); return;
        }
        if (!task.ready && document.readyState === 'complete' && Date.now() - loadedAt >= 8000) {
          GM_setValue(key, { ...task, ready: true });
        }
      }, 2000);
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
        return payload;
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
    async function claim(job) {
      config = embeddedConfig() || config;
      if (!config) throw new Error('页面缺少动态请求配置');
      let token = cookieValue(config.cookie);
      if (!token) { await request('/wgapi/livenc/liveweb/csrfApi/getCsrfCookie'); token = cookieValue(config.cookie); }
      if (!token) throw new Error('登录凭证不可用');
      const body = new URLSearchParams({ rid: job.rid, id: String(job.id), code: job.code, [config.field]: token });
      return request(`${BASE}/redbag/snatch`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: body.toString() });
    }
    const engine = new core.Engine({
      now: () => Date.now(), loadDB: () => GM_getValue(DB, {}), saveDB: value => GM_setValue(DB, value),
      loadSettings: readPrefs, makeToken: uuid,
      api: { square: () => request(`${BASE}/redbag/square/list?rid=${apiOriginRid}`),
        room: id => request(`${BASE}/redbag/room/list?rid=${id}`), claim },
      prepare: (token, roomId) => GM_setValue(workerKey(token), { owner, rid: roomId, ready: false, expires: Date.now() + 40 * 60000 }),
      revoke: token => GM_deleteValue(workerKey(token)),
      ready: token => Boolean(GM_getValue(workerKey(token), {}).ready),
      openTab: url => GM_openInTab(url, { active: false, insert: true, setParent: true }),
      abort: () => { for (const request of requests) request.abort(); },
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
      </style><button class="chip">星推 · 已停止</button><section class="card hidden">
        <header><b>斗鱼全民星推荐自动领取</b><button class="small fold">收起</button></header>
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
        <details class="records"><summary>领取记录与导出</summary><ol></ol><button class="export secondary">导出本地记录</button><button class="history secondary">查询斗鱼金币记录</button><p class="muted historyText"></p></details>
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
      document.documentElement.appendChild(root); fillSettings(); fold(readPrefs().compact); render();
    }
    function fold(value) { card.classList.toggle('hidden', value); collapsed.classList.toggle('hidden', !value); }
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
        const status = job.step === 'loading' ? '加载中' : job.step === 'claiming' ? '领取中'
          : `${Math.max(0, Math.ceil((job.due - Date.now()) / 1000))} 秒后尝试`;
        line.appendChild(document.createTextNode(` · 奖池 ${job.coins} 金币 · ${status}`)); box.appendChild(line);
      }
      if (shadow.querySelector('.records').open) {
        const list = shadow.querySelector('ol'); list.replaceChildren();
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
      for (const controller of requests) controller.abort();
      if (GM_getValue(LEASE, {}).owner === owner) GM_setValue(LEASE, {});
      if (releaseLock) { releaseLock(); releaseLock = null; }
    });
    if (readPrefs().enabled && readPrefs().controlPath === location.pathname) setTimeout(() => void start(), 5000);
  }
})();
