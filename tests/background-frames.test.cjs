'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../douyu-star-background.user.js');
function harness(hidden = true) {
  const native = new Map(), timers = new Map(), events = new Map(); let sequence = 0, time = 1234;
  const doc = { hidden, visibilityState: hidden ? 'hidden' : 'visible',
    addEventListener: (event, fn) => events.set(event, fn), removeEventListener: event => events.delete(event) };
  const page = { performance: { now: () => time }, requestAnimationFrame(fn) { native.set(++sequence, fn); return sequence; },
    cancelAnimationFrame: id => native.delete(id) };
  const original = { request: page.requestAnimationFrame, cancel: page.cancelAnimationFrame };
  const dispose = core.backgroundFrames(page, doc, { setTimer(fn, delay) { timers.set(++sequence, { fn, delay }); return sequence; }, clearTimer: id => timers.delete(id) });
  return { page, doc, native, timers, events, original, dispose,
    fallback() { const [id, item] = timers.entries().next().value; timers.delete(id); item.fn(); },
    frame(at) { time = at; const fn = native.values().next().value; fn(at); },
    visible(value) { doc.hidden = !value; doc.visibilityState = value ? 'visible' : 'hidden'; events.get('visibilitychange')(); } };
}

test('a hidden official animation callback can initialize without altering clocks or visibility', () => {
  const h = harness(), seen = [];
  h.page.requestAnimationFrame(time => seen.push(time));
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 1000);
  h.fallback(); assert.deepEqual(seen, [1234]); assert.equal(h.native.size, 0);
  assert.equal(h.doc.hidden, true); assert.equal(h.page.performance.now(), 1234);
});

test('foreground requests retain native timing and do not schedule background fallbacks', () => {
  const h = harness(false), seen = [];
  h.page.requestAnimationFrame(time => seen.push(time)); assert.equal(h.timers.size, 0);
  h.frame(2345); assert.deepEqual(seen, [2345]); assert.equal(h.native.size, 0);
});

test('cancelling an animation removes both the native callback and fallback', () => {
  const h = harness(); let called = false;
  const id = h.page.requestAnimationFrame(() => { called = true; });
  h.page.cancelAnimationFrame(id);
  assert.equal(h.native.size, 0); assert.equal(h.timers.size, 0); assert.equal(called, false);
});

test('a hidden-to-visible transition cannot deliver an animation callback twice', () => {
  const h = harness(false); let called = 0;
  h.page.requestAnimationFrame(() => { called++; }); h.visible(false); assert.equal(h.timers.size, 1);
  const lateFallback = [...h.timers.values()][0].fn;
  h.visible(true); h.frame(3456); lateFallback();
  assert.equal(called, 1); assert.equal(h.timers.size, 0);
});

test('worker cleanup restores native functions and removes pending animation work', () => {
  const h = harness(); h.page.requestAnimationFrame(() => {}); h.dispose(); h.dispose();
  assert.equal(h.page.requestAnimationFrame, h.original.request);
  assert.equal(h.page.cancelAnimationFrame, h.original.cancel);
  assert.equal(h.native.size, 0); assert.equal(h.timers.size, 0); assert.equal(h.events.size, 0);
});

test('a URL marker alone never authorizes compatibility changes on an unrelated page', () => {
  const task = { owner: 'controller', rid: '101', bagId: '123', expires: 2000 }, lease = { owner: 'controller', until: 2000 };
  assert.equal(core.registeredWorker(task, lease, 1000), true);
  for (const value of [null, { ...task, revoked: true }, { ...task, rid: '' }, { ...task, bagId: 'bad' },
    { ...task, owner: 'other' }, { ...task, expires: 999 }]) assert.equal(core.registeredWorker(value, lease, 1000), false);
  assert.equal(core.registeredWorker(task, null, 1000), false);
});

test('document-start setup targets the page realm before waiting for the DOM', () => {
  const source = fs.readFileSync(path.join(__dirname, '../douyu-star-background.user.js'), 'utf8');
  const handlers = new Map(), task = { owner: 'controller', rid: '101', bagId: '123', expires: Date.now()+3600000 };
  const lease = { owner: 'controller', until: Date.now()+3600000 };
  const h = harness(); h.dispose();
  const doc = { ...h.doc, readyState: 'loading' };
  const sandboxFrame = () => {};
  const window = { requestAnimationFrame: sandboxFrame, addEventListener: (name, fn) => handlers.set(name, fn) }; window.top = window;
  vm.runInNewContext(source, { window, document: doc, unsafeWindow: h.page,
    location: { pathname: '/101', hash: '#dy-star-worker=' + 'a'.repeat(32) },
    GM_getValue: key => key === 'bg2.lease' ? lease : task, setTimeout, clearTimeout });
  assert.notEqual(h.page.requestAnimationFrame, h.original.request);
  assert.equal(window.requestAnimationFrame, sandboxFrame);
  assert.equal(typeof handlers.get('DOMContentLoaded'), 'function');
  handlers.get('pagehide')(); assert.equal(h.page.requestAnimationFrame, h.original.request);
});

test('claim records use an unnumbered list rather than browser-generated sequence numbers', () => {
  const source = fs.readFileSync(path.join(__dirname, '../douyu-star-background.user.js'), 'utf8');
  assert.match(source, /<ul class="record-list"><\/ul>/); assert.doesNotMatch(source, /<ol(?:\s|>)/);
  assert.match(source, /\.record-list\{list-style:none/);
});
