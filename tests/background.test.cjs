'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../douyu-star-background.user.js');
const rawBag = (id, coins, extra = {}) => ({ id, code: `abcdef0123456789${id}`, status: 0, waitSec: 90,
  prizeList: [{ ptype: 9, num: coins }, { ptype: 2, num: 200 }], ...extra });
const roomPayload = (bags, name = '房间') => ({ error: 0, data: { anchorName: name, redBagList: bags } });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

function setup({ rooms = { '101': [rawBag(1, 10000)] }, settings = {}, claim, square, enter, ready = true } = {}) {
  let now = Date.UTC(2026, 9, 22, 4);
  let saved = {};
  let sequence = 0;
  let claimed = [];
  let opened = [];
  let revoked = [];
  let apiCalls = 0;
  let readiness = { ready, readyAt: now };
  const s = { ...core.DEFAULTS, ...settings };
  const engine = new core.Engine({
    now: () => now, loadDB: () => structuredClone(saved), saveDB: v => { saved = structuredClone(v); },
    loadSettings: () => s, makeToken: () => `t${++sequence}`, prepare() {}, revoke: t => revoked.push(t), ready: () => readiness,
    openTab: url => { const tab = { url, closed: false, close() { this.closed = true; } }; opened.push(tab); return tab; },
    api: {
      enter,
      square: async () => { apiCalls++; return square ? square() : roomPayload(Object.keys(rooms).map(rid => ({ rid }))); },
      room: async rid => roomPayload(rooms[rid] || [], `主播${rid}`),
      claim: async job => { claimed.push(job.id); return claim ? claim(job) : { error: 0, data: { id: job.id, prizeList: [{ prizeType: 9, num: 37 }, { prizeType: 2, num: 4 }] } }; }
    }
  });
  return { engine, s, opened, revoked, claimed,
    advance: ms => { now += ms; }, setNow: at => { now = at; }, now: () => now,
    setReady(value) { readiness = value; },
    saved: () => saved, apiCalls: () => apiCalls,
    async initialize() { await engine.start(); await engine.discover(engine.generation); await engine.tick(); await settle(); await engine.tick(); await settle(); },
    async tick() { await engine.tick(); await settle(); },
    async due() { now = Math.max(now, ...[...engine.jobs.values()].map(j => j.due)); await this.tick(); }
  };
}

test('ranks by verified coin pool, filters threshold, and picks the largest first', async () => {
  const h = setup({ rooms: { '101': [rawBag(1, 500)], '102': [rawBag(2, 10000)], '103': [rawBag(3, 40000)] }, settings: { concurrency: 1 } });
  await h.initialize();
  assert.equal(h.engine.jobs.size, 1);
  assert.equal([...h.engine.jobs.values()][0].id, 3);
  assert.match(h.opened[0].url, /\/103#dy-star-worker=/);
  assert.equal(h.engine.candidates.length, 1);
});

test('empty selection never silently falls back to small pools', async () => {
  const h = setup({ rooms: { '101': [rawBag(1, 500)] } });
  await h.initialize();
  assert.equal(h.opened.length, 0);
  assert.equal(h.engine.running, true);
  assert.equal(h.engine.candidates.length, 0);
});

test('ties prefer a shorter wait and ignore terminal or malformed bags', () => {
  const parsed = core.parseBags(roomPayload([rawBag(1, 10000, { waitSec: 300 }), rawBag(2, 10000),
    rawBag(3, 90000, { status: 3 }), rawBag(4, 90000, { waitSec: null })]), '101', 0);
  parsed.sort(core.compareBags);
  assert.deepEqual(parsed.map(v => v.id), [2, 1]);
  assert.throws(() => core.parseBags({ error: null, data: { redBagList: [] } }, '101', 0));
});

test('successful claims use server rewards rather than advertised prize pools', async () => {
  const h = setup(); await h.initialize(); await h.tick(); await h.due();
  assert.equal(h.saved().claims, 1);
  assert.equal(h.saved().coins, 37);
  assert.equal(h.saved().stars, 4);
  assert.equal(h.opened[0].closed, true);
  assert.ok(h.saved().done.includes('101:1'));
  assert.doesNotMatch(JSON.stringify(h.engine.snapshot()), /abcdef0123456789/);
});

test('daily platform limit immediately cancels all rooms and cannot restart the same day', async () => {
  const h = setup({ rooms: { '101': [rawBag(1, 10000)], '102': [rawBag(2, 20000)] },
    claim: () => ({ error: -1, msg: '已达到每日领取上限' }) });
  await h.initialize(); await h.tick(); await h.due();
  assert.equal(h.engine.running, false);
  assert.equal(h.engine.jobs.size, 0);
  assert.equal(h.opened.every(v => v.closed), true);
  assert.equal(h.claimed.length, 1);
  assert.equal(h.saved().stopped.kind, 'limit');
  assert.equal(await h.engine.start(), false);
  h.advance(86400000); await h.tick();
  assert.equal(h.engine.running, false); // no automatic next-day restart
  assert.equal(await h.engine.start(), true); // user may explicitly start the next day
});

test('custom daily cap counts confirmed claims and stops before further rooms', async () => {
  const h = setup({ rooms: { '101': [rawBag(1, 20000)], '102': [rawBag(2, 10000)] }, settings: { dailyCap: 1 } });
  await h.initialize(); await h.tick(); await h.due();
  assert.equal(h.engine.running, false);
  assert.equal(h.saved().claims, 1);
  assert.equal(h.claimed.length, 1);
  assert.equal(h.saved().stopped.kind, 'cap');
});

test('waiting may exceed five requests but stays deadline-bounded without bursts on resume', async () => {
  const h = setup({ rooms: { '101': [rawBag(1, 10000, { waitSec: 600 })] }, claim: () => ({ error: 12006, msg: '稍等会儿才能抢哟' }) });
  await h.initialize(); await h.tick(); await h.due();
  assert.equal(h.claimed.length, 1);
  h.advance(90000); await h.tick();
  assert.equal(h.claimed.length, 2);
  const job = [...h.engine.jobs.values()][0];
  assert.ok(job.due >= h.now() + 10000);
  await h.tick(); assert.equal(h.claimed.length, 2);
  for (let i = 0; i < 4; i++) await h.due();
  assert.equal(h.claimed.length, 6);
  assert.equal(h.engine.jobs.size, 1);
  h.setNow(job.deadlineAt); await h.tick();
  assert.equal(h.engine.jobs.size, 0);
  assert.equal(h.saved().done.includes('101:1'), false);
  assert.ok(h.saved().retryAfter['101:1'] > h.now());
});

test('uncertain POST timeout stops without blindly repeating the request', async () => {
  const h = setup({ claim: () => { throw new Error('timeout'); } });
  await h.initialize(); await h.tick(); await h.due();
  assert.equal(h.engine.running, false);
  h.advance(999999); await h.tick();
  assert.equal(h.claimed.length, 1);
  assert.equal(h.saved().coins, 0);
});

test('an expired packet is skipped without stopping unrelated tasks', async () => {
  const h = setup({ claim: () => ({ error: 12001, msg: '红包已派完' }) });
  await h.initialize(); await h.tick(); await h.due();
  assert.equal(h.engine.running, true);
  assert.equal(h.engine.jobs.size, 0);
  assert.equal(h.saved().claims, 0);
});

test('authentication, verification, and unknown response shapes stop cleanly', async () => {
  for (const payload of [{ error: -9, msg: '请登录' }, { error: 400, msg: '请完成验证' }, { data: { prizeList: [] } }]) {
    const h = setup({ claim: () => payload }); await h.initialize(); await h.tick(); await h.due();
    assert.equal(h.engine.running, false);
    assert.equal(h.opened.every(t => t.closed), true);
    assert.equal(h.saved().claims, 0);
  }
  assert.equal(core.classify({ error: null, data: { prizeList: [] } }), 'unknown');
});

test('stopping cancels discovery even if an old response arrives later', async () => {
  let resolve;
  const h = setup({ square: () => new Promise(done => { resolve = done; }) });
  await h.engine.start();
  const discovery = h.engine.discover(h.engine.generation);
  h.engine.stop(); resolve(roomPayload([{ rid: '101' }])); await discovery;
  assert.equal(h.engine.candidates.length, 0);
  assert.equal(h.opened.length, 0);
});

test('slow discovery does not block a due claim in another task', async () => {
  const h = setup(); await h.initialize(); await h.tick();
  let resolve;
  h.engine.api.square = () => new Promise(done => { resolve = done; });
  const discovery = h.engine.discover(h.engine.generation);
  await h.due();
  assert.equal(h.claimed.length, 1);
  resolve(roomPayload([])); await discovery;
});

test('parallel binding never exceeds the configured number of background tabs', async () => {
  const h = setup({ rooms: { '101': [rawBag(1, 10000)], '102': [rawBag(2, 20000)], '103': [rawBag(3, 30000)] }, settings: { concurrency: 1 } });
  await h.initialize(); await Promise.all([h.tick(), h.tick(), h.tick()]);
  assert.equal(h.opened.length, 1);
});

test('completed packets stay deduplicated after refreshing the room pool', async () => {
  const h = setup(); await h.initialize(); await h.tick(); await h.due();
  await h.engine.discover(h.engine.generation); await h.tick();
  assert.equal(h.opened.length, 1);
  assert.equal(h.engine.candidates.length, 0);
});

test('dynamic CSRF mapping and Beijing calendar day are parsed without fixed token names', () => {
  assert.deepEqual(core.csrfConfig('"tn":"ctn","tvk":"ccn","cookie_pre":"acf_"'), { field: 'ctn', cookie: 'acf_ccn' });
  assert.deepEqual(core.csrfConfig('{"tn":"other","tvk":"p_key","cookie_pre":"p_"}'), { field: 'other', cookie: 'p_key' });
  assert.equal(core.csrfConfig(''), null);
  assert.equal(core.dayKey(Date.UTC(2026, 9, 21, 16, 0, 0)), '2026-10-22');
  assert.equal(core.options({ concurrency: 999, minCoins: 'bad' }).concurrency, 6);
  assert.equal(core.options({ minCoins: 'bad' }).minCoins, 10000);
});

test('empty reward lists are confirmed empty packets, not advertised gold earnings', async () => {
  const h = setup({ claim: () => ({ error: 0, data: { prizeList: [] } }) });
  await h.initialize(); await h.tick(); await h.due();
  assert.equal(h.saved().claims, 1); assert.equal(h.saved().coins, 0);
});

test('three failed discovery rounds stop with bounded retry backoff', async () => {
  const h = setup({ square: () => { throw new Error('offline'); } });
  await h.engine.start();
  for (let i = 1; i <= 3; i++) {
    const before = h.now(); await h.engine.discover(h.engine.generation);
    if (i < 3) assert.equal(h.engine.nextScan - before, 30000 * 2 ** (i - 1));
    h.advance(300000);
  }
  assert.equal(h.engine.running, false);
  assert.equal(h.apiCalls(), 3);
});

test('candidate eligibility is rechecked if settings change before opening a room', async () => {
  const h = setup(); await h.engine.start(); await h.engine.discover(h.engine.generation);
  h.s.minCoins = 50000;
  await h.tick();
  assert.equal(h.opened.length, 0);
});

test('already reaching a configured cap prevents opening any additional rooms', async () => {
  const h = setup({ settings: { dailyCap: 1 } });
  h.engine.db.claims = 1; h.engine.persist();
  assert.equal(await h.engine.start(), false);
  assert.equal(h.engine.running, false);
  assert.equal(h.opened.length, 0);
});

test('viewing delay starts when the activity is initialized, not when a tab opens', async () => {
  const h = setup({ ready: false }); await h.initialize();
  const openedAt = [...h.engine.jobs.values()][0].openedAt;
  h.advance(45000); await h.tick(); assert.equal(h.claimed.length, 0);
  h.setReady({ ready: true, readyAt: h.now() }); await h.tick();
  const job = [...h.engine.jobs.values()][0];
  assert.equal(job.due, openedAt + 45000 + 45000);
  h.advance(44999); await h.tick(); assert.equal(h.claimed.length, 0);
  h.advance(1); await h.tick(); assert.equal(h.claimed.length, 1);
});

test('a sixth response can succeed after five not-ready responses', async () => {
  let tries = 0;
  const h = setup({ rooms: { '101': [rawBag(1, 10000, { waitSec: 300 })] }, claim: () => ++tries <= 5
    ? { error: 12006, msg: '稍等会儿才能抢哟' } : { error: 0, data: { prizeList: [{ prizeType: 9, num: 21 }] } } });
  await h.initialize();
  for (let i = 0; i < 6; i++) await h.due();
  assert.equal(h.saved().claims, 1); assert.equal(h.saved().coins, 21);
  assert.equal(h.claimed.length, 6);
});

test('repeated full waitSec from room/list never pushes the deadline forward', async () => {
  const h = setup({ claim: () => ({ error: 12006 }) }); await h.initialize();
  const job = [...h.engine.jobs.values()][0], deadline = job.deadlineAt;
  await h.due(); await h.due(); await h.due();
  assert.equal(job.deadlineAt, deadline);
});

test('a not-ready response is rechecked against the actual terminal room state', async () => {
  const rooms = { '101': [rawBag(1, 10000)] };
  const h = setup({ rooms, claim: () => { rooms['101'][0].status = 3; return { error: 12006 }; } });
  await h.initialize(); await h.due();
  assert.equal(h.engine.jobs.size, 0);
  assert.ok(h.saved().done.includes('101:1'));
  assert.equal(h.saved().records[0].kind, 'exhausted');
});

test('a temporarily missing packet needs two confirmations and remains retryable', async () => {
  const rooms = { '101': [rawBag(1, 10000)] };
  const h = setup({ rooms, claim: () => { rooms['101'] = []; return { error: 12006 }; } });
  await h.initialize(); await h.due(); assert.equal(h.engine.jobs.size, 1);
  await h.due(); assert.equal(h.engine.jobs.size, 0);
  assert.equal(h.saved().done.includes('101:1'), false);
});

test('upgrading recovers previously timed-out packets without clearing actual successes', () => {
  const now = Date.UTC(2026, 9, 22, 4);
  const db = core.freshDB({ day: core.dayKey(now), done: ['101:1', '101:2'],
    records: [{ rid: '101', bagId: 1, kind: 'timeout' }, { rid: '101', bagId: 2, kind: 'success' }] }, now);
  assert.deepEqual(db.done, ['101:2']); assert.equal(db.schemaVersion, 2);
});

test('official activity entry registration occurs before a background room opens', async () => {
  const seen = [];
  const h = setup({ enter: async bag => { seen.push({ rid: bag.rid, id: bag.id, opened: h.opened.length }); return { error: 0 }; } });
  await h.initialize();
  assert.deepEqual(seen, [{ rid: '101', id: 1, opened: 0 }]);
  assert.equal(h.opened.length, 1);
});

test('limit or login errors while registering activity prevent opening worker tabs', async () => {
  for (const payload of [{ error: -1, msg: '已达到每日领取上限' }, { error: -9, msg: '请登录' }]) {
    const h = setup({ enter: async () => payload }); await h.initialize();
    assert.equal(h.engine.running, false); assert.equal(h.opened.length, 0);
    assert.equal(h.claimed.length, 0);
  }
});
