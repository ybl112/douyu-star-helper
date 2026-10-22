'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../douyu-star-background.user.js');
const source = fs.readFileSync(path.join(__dirname, '../douyu-star-background.user.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

function bus() {
  const values = new Map(), listeners = new Map(); let sequence = 0;
  return {
    get: key => structuredClone(values.get(key)),
    set(key, value) {
      const old = values.get(key); values.set(key, structuredClone(value));
      for (const item of [...listeners.values()]) if (item.key === key) item.fn(key, old, structuredClone(value), true);
    },
    listen(key, fn) { const id = ++sequence; listeners.set(id, { key, fn }); return id; },
    unlisten(id) { listeners.delete(id); },
    size: () => listeners.size
  };
}

function bridgeHarness() {
  const store = bus(), timers = new Map(); let sequence = 0;
  const bridge = new core.WorkerBridge({
    ...store, key: token => token, id: () => `req${++sequence}`, now: () => 1000,
    setTimer: fn => { timers.set(sequence, fn); return sequence; }, clearTimer: id => timers.delete(id)
  });
  store.set('worker', { ready: true });
  return { store, bridge, timers };
}

test('worker commands contain only a packet id and accept only the matching reply', async () => {
  const { store, bridge, timers } = bridgeHarness();
  const pending = bridge.claim('worker', 123);
  const task = store.get('worker');
  assert.deepEqual(Object.keys(task.command).sort(), ['at', 'bagId', 'requestId']);
  store.set('worker', { ...task, response: { requestId: 'old', payload: { error: 12006 } } });
  assert.equal(bridge.pending.size, 1);
  store.set('worker', { ...task, response: { requestId: task.command.requestId, payload: { error: 12006 } } });
  assert.equal((await pending).error, 12006);
  assert.equal(store.size(), 0); assert.equal(timers.size, 0);
});

test('stopping cancels pending worker commands and detaches listeners', async () => {
  const { store, bridge, timers } = bridgeHarness();
  const pending = bridge.claim('worker', 123);
  const rejected = assert.rejects(pending, /已取消/);
  bridge.cancelAll(); await rejected;
  assert.equal(store.size(), 0); assert.equal(timers.size, 0);
});

test('an unresponsive worker times out without a duplicate command', async () => {
  const { store, bridge, timers } = bridgeHarness();
  const pending = bridge.claim('worker', 123);
  const rejected = assert.rejects(pending, /未及时响应/);
  await assert.rejects(bridge.claim('worker', 124), /正在领取/);
  [...timers.values()][0](); await rejected;
  assert.equal(bridge.pending.size, 0); assert.equal(store.size(), 0);
});

test('the worker obtains a fresh packet code from its own room before posting', async () => {
  let posted;
  const api = {
    room: async () => ({ error: 0, data: { redBagList: [{ id: 123, status: 0, waitSec: 300,
      code: 'fresh-local-code', prizeList: [] }] } }),
    claim: async bag => { posted = bag; return { error: 12006 }; }
  };
  assert.equal((await core.claimInRoom(api, '101', 123)).error, 12006);
  assert.equal(posted.rid, '101'); assert.equal(posted.code, 'fresh-local-code');
  let calls = 0;
  const ended = await core.claimInRoom({ room: async () => ({ error: 0, data: { redBagList: [{ id: 123, status: 3 }] } }),
    claim: async () => { calls++; } }, '101', 123);
  assert.equal(ended.localState, 'ended'); assert.equal(calls, 0);
});

test('worker replies retain result semantics without persisting packet or credential fields', () => {
  const reply = core.workerReply({ error: 0, msg: 'success', code: 'private-packet-code', token: 'private-session-token',
    data: { code: 'private-packet-code', prizeList: [{ num: 21, prizeType: 9, code: 'private-item-code' }] } });
  assert.equal(core.classify(reply), 'success'); assert.equal(core.prizes(reply.data.prizeList).coins, 21);
  assert.doesNotMatch(JSON.stringify(reply), /private/);
  for (const payload of [{ error: -1, msg: '已达到每日领取上限' }, { error: -9, msg: '请登录' },
    { error: 400, msg: '操作频繁' }, { error: 12006 }, { error: 12001 }]) {
    assert.equal(core.classify(core.workerReply(payload)), core.classify(payload));
  }
});

function workerHarness() {
  const store = bus(), intervals = new Map();
  const token = 'a'.repeat(32), key = `bg2.worker.${token}`;
  let now = Date.UTC(2026, 9, 22, 4), rendered = false, remaining = 12, closed = 0, intervalId = 0;
  let entryClicks = 0;
  let gate = null;
  const fetches = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const bag = {
    querySelector(selector) {
      if (selector.endsWith('--btn')) return remaining > 0 ? { textContent: `${remaining}秒后可抢` } : null;
      if (selector.endsWith('--btnOpen')) return remaining === 0 ? { style: {}, hidden: false } : null;
      return null;
    }
  };
  const document = {
    scripts: [{ src: '', textContent: '' }], readyState: 'complete', cookie: 'acf_ccn=fake-csrf-for-test', body: {},
    getElementById: id => rendered && id === 'LiveNewAnchorSupportT-bagReadySvga-123' ? { closest: () => bag } : null,
    querySelector: selector => selector === '.LiveNewAnchorSupportT-enter' ? { click() { entryClicks++; rendered = true; } } : null,
    querySelectorAll: () => [], addEventListener() {}
  };
  store.set(key, { owner: 'controller', rid: '101', bagId: '123', ready: false, expires: now + 3600000,
    csrfConfig: { field: 'ctn', cookie: 'acf_ccn' } });
  store.set('bg2.lease', { owner: 'controller', until: now + 3600000 });
  const window = { close() { closed++; }, addEventListener() {} }; window.top = window;
  const context = { window, document, location: { pathname: '/101', hash: `#dy-star-worker=${token}`, origin: 'https://www.douyu.com' },
    Date: Clock, crypto: { randomUUID: () => 'b'.repeat(32) }, NodeFilter: { SHOW_TEXT: 4 },
    URL, URLSearchParams, AbortController, console, setTimeout, clearTimeout,
    setInterval(fn) { intervals.set(++intervalId, fn); return intervalId; }, clearInterval(id) { intervals.delete(id); },
    GM_getValue: (key, fallback) => store.get(key) ?? fallback, GM_setValue: store.set,
    GM_deleteValue: key => store.set(key, undefined), GM_addValueChangeListener: store.listen,
    GM_removeValueChangeListener: store.unlisten,
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (gate) await gate(url, init);
      return { ok: true, json: async () => init.method === 'POST'
        ? { error: 0, data: { prizeList: [{ prizeType: 9, num: 18 }] } }
        : { error: 0, data: { redBagList: [{ id: 123, code: 'fresh-local-code', status: 0, waitSec: 300, prizeList: [] }] } } };
    }
  };
  vm.runInNewContext(source, context, { filename: 'douyu-star-background.user.js' });
  return { store, key, fetches, get: () => store.get(key), closed: () => closed,
    gate: fn => { gate = fn; }, cookie: value => { document.cookie = value; },
    clicks: () => ({ entry: entryClicks }), setRemaining: value => { remaining = value; }, hide: () => { rendered = false; },
    async tick(ms = 2000) { now += ms; for (const fn of [...intervals.values()]) fn(); await settle(); },
    async initialize() { remaining = 0; await this.tick(); }
  };
}

test('a loaded worker opens the official packet component and reads its actual seconds without estimating', async () => {
  const h = workerHarness();
  assert.equal(h.get().ready, false); assert.equal(h.clicks().entry, 1);
  await h.tick(); assert.equal(h.get().ready, true); assert.equal(h.get().timer.remainingSec, 12);
  await h.tick(60000); assert.equal(h.get().timer.remainingSec, 12);
  h.setRemaining(4); await h.tick(); assert.equal(h.get().timer.remainingSec, 4);
});

test('the real worker adapter submits from its room exactly once per command', async () => {
  const h = workerHarness(); await h.initialize();
  const task = h.get(); h.store.set(h.key, { ...task, command: { requestId: 'command1', bagId: 123 } });
  await settle(); await h.tick();
  const posts = h.fetches.filter(item => item.init.method === 'POST');
  assert.equal(posts.length, 1);
  const body = new URLSearchParams(posts[0].init.body);
  assert.equal(body.get('rid'), '101'); assert.equal(body.get('code'), 'fresh-local-code');
  assert.equal(body.get('ctn'), 'fake-csrf-for-test');
  assert.equal(h.get().response.payload.data.prizeList[0].num, 18);
  assert.doesNotMatch(JSON.stringify(h.get()), /fresh-local-code|fake-csrf-for-test/);
});

test('revoking a worker task closes only that registered worker and prevents new requests', async () => {
  const h = workerHarness(); await h.initialize();
  h.store.set(h.key, undefined); await h.tick();
  assert.ok(h.closed() > 0); assert.equal(h.fetches.length, 0);
});

test('a worker refuses a command while its exact packet still has a countdown', async () => {
  const h = workerHarness(); await h.tick();
  h.store.set(h.key, { ...h.get(), command: { requestId: 'early', bagId: 123 } });
  await settle(); assert.equal(h.fetches.length, 0);
  assert.equal(h.get().response.payload.localState, 'waiting');
});

test('a command for a different packet never uses the visible packet readiness', async () => {
  const h = workerHarness(); await h.initialize();
  h.store.set(h.key, { ...h.get(), command: { requestId: 'wrong', bagId: 124 } });
  await settle(); assert.equal(h.fetches.length, 0);
});

test('lost readiness between controller sampling and dispatch pauses rather than stopping all rooms', async () => {
  const { store, bridge } = bridgeHarness(); store.set('worker', { ready: false });
  assert.equal((await bridge.claim('worker', 123)).localState, 'waiting');
  assert.equal(bridge.pending.size, 0); assert.equal(store.get('worker').command, undefined);
});

test('revocation while refreshing the packet code cannot send a late claim', async () => {
  const h = workerHarness(); await h.initialize();
  let release;
  h.gate(() => new Promise(resolve => { release = resolve; }));
  h.store.set(h.key, { ...h.get(), command: { requestId: 'revoked', bagId: 123 } }); await settle();
  h.store.set(h.key, undefined); release(); await settle();
  assert.equal(h.fetches.filter(item => item.init.method === 'POST').length, 0);
  assert.ok(h.closed() > 0);
});

test('the actual countdown is checked again after the room-list request completes', async () => {
  const h = workerHarness(); await h.initialize();
  let release; h.gate(() => new Promise(resolve => { release = resolve; }));
  h.store.set(h.key, { ...h.get(), command: { requestId: 'changed', bagId: 123 } }); await settle();
  h.setRemaining(8); release(); await settle();
  assert.equal(h.fetches.filter(item => item.init.method === 'POST').length, 0);
  assert.equal(h.get().response.payload.localState, 'waiting');
});

test('stopping during CSRF initialization also prevents the final POST', async () => {
  const h = workerHarness(); await h.initialize(); h.cookie('');
  let release;
  h.gate(url => url.includes('getCsrfCookie') ? new Promise(resolve => { release = resolve; }) : undefined);
  h.store.set(h.key, { ...h.get(), command: { requestId: 'csrf-race', bagId: 123 } }); await settle();
  assert.equal(typeof release, 'function');
  h.store.set(h.key, undefined); h.cookie('acf_ccn=fake-after-initialization'); release(); await settle();
  assert.equal(h.fetches.filter(item => item.init.method === 'POST').length, 0);
});
