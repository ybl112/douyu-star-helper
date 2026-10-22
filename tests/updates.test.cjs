'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../douyu-star-background.user.js');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'douyu-star-background.user.js'), 'utf8').replaceAll('\r\n', '\n');
const metadata = fs.readFileSync(path.join(root, 'douyu-star-background.meta.js'), 'utf8').replaceAll('\r\n', '\n');
const field = name => source.match(new RegExp(`^// @${name} +(.+)$`, 'm'))?.[1];
const downloadURL = 'https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.user.js';

test('the lightweight update file exactly matches the installable header and contains no executable code', () => {
  assert.equal(metadata, source.match(/^\/\/ ==UserScript==\n[\s\S]*?\/\/ ==\/UserScript==\n/)[0]);
});

test('release versions stay consistent across the script, metadata, package and README', () => {
  const version = field('version');
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, version);
  assert.ok(fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes(`当前版本：\`${version}\``));
  assert.ok(metadata.includes(`// @version      ${version}\n`));
});

test('native updates use the metadata endpoint and download the same script identity from GitHub', () => {
  assert.equal(field('updateURL'), downloadURL.replace('.user.js', '.meta.js'));
  assert.equal(field('downloadURL'), downloadURL);
  assert.equal(field('namespace'), 'local.douyu.star.helper');
  assert.equal(field('name'), '斗鱼全民星推荐自动领取');
  assert.match(source, /^\/\/ @connect +raw\.githubusercontent\.com$/m);
  assert.doesNotMatch(source, /^\/\/ @connect +\*$/m);
});

test('the manual update menu opens the fixed installer only on a click without touching stored preferences', () => {
  const menus = new Map(), opened = [], writes = [], requests = [];
  const stopBeforeUI = new Error('UI rendering is outside this menu test');
  const window = {}; window.top = window;
  const context = {
    window, location: { pathname: '/101', hash: '', origin: 'https://www.douyu.com' },
    crypto: { randomUUID: () => 'a'.repeat(32) }, setTimeout, clearTimeout,
    document: { createElement() { throw stopBeforeUI; } },
    GM_getValue: (_key, fallback) => fallback, GM_setValue: (...args) => writes.push(args),
    GM_addValueChangeListener() {}, GM_removeValueChangeListener() {},
    GM_registerMenuCommand: (label, callback) => menus.set(label, callback),
    GM_openInTab: (url, options) => opened.push({ url, options }),
    fetch: (...args) => requests.push(args)
  };
  assert.throws(() => vm.runInNewContext(source, context), error => error === stopBeforeUI);
  assert.equal(opened.length, 0);
  const update = menus.get('安装或更新到最新版');
  assert.equal(typeof update, 'function');
  writes.length = 0; // Ignore the controller's normal database initialization.
  update();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, downloadURL);
  assert.equal(opened[0].options.active, true);
  assert.deepEqual(writes, []);
  assert.deepEqual(requests, []);
});

test('version comparison is numeric and rejects malformed version numbers', () => {
  assert.equal(core.compareVersions('2.0.10', '2.0.9'), 1);
  assert.equal(core.compareVersions('2.1.0', '2.0.99'), 1);
  assert.equal(core.compareVersions('2.0.3', '3.0.0'), -1);
  assert.equal(core.compareVersions('2.0.3', '2.0.3'), 0);
  for (const version of ['', undefined, '2.0', '2.0.x', '2.0.3-beta', '2.0.3<script>', '9999999.0.0']) {
    assert.throws(() => core.compareVersions(version, '2.0.3'));
  }
});

test('version metadata must match this script and cannot contain HTML or appended executable code', () => {
  assert.equal(core.parseUpdateMeta(metadata), field('version'));
  assert.equal(core.parseUpdateMeta(metadata.replaceAll('\n', '\r\n')), field('version'));
  for (const invalid of [metadata.replace('local.douyu.star.helper', 'another.script'),
    metadata.replace(downloadURL, 'https://example.com/script.js'), '<html>blocked</html>',
    metadata + 'alert(1)', 'x'.repeat(32769), metadata.replace(field('version'), 'x.y.z')]) {
    assert.throws(() => core.parseUpdateMeta(invalid));
  }
});

function releaseHarness() {
  let details, timer, aborted = 0, cleared = 0;
  const promise = core.fetchRelease(value => { details = value; return { abort() { aborted++; details.onabort(); } }; },
    { setTimer: fn => { timer = fn; return 1; }, clearTimer: () => { cleared++; } });
  return { promise, request: () => details, expire: () => timer(), aborted: () => aborted, cleared: () => cleared };
}

test('version checks fetch only fixed metadata without cookies and release their timeout on success', async () => {
  const h = releaseHarness(), request = h.request();
  assert.equal(request.url, field('updateURL'));
  assert.equal(request.method, 'GET'); assert.equal(request.anonymous, true);
  assert.equal(request.nocache, true); assert.equal(request.revalidate, true);
  assert.equal(request.timeout, 15000); assert.equal(request.cookie, undefined);
  request.onload({ status: 200, finalUrl: request.url, responseText: metadata });
  assert.equal(await h.promise, field('version'));
  assert.equal(h.cleared(), 1); assert.equal(h.aborted(), 0);
});

test('failed HTTP responses, unexpected redirects and malformed payloads are not reported as up to date', async () => {
  for (const response of [{ status: 404, responseText: metadata },
    { status: 200, finalUrl: 'https://example.com/redirect', responseText: metadata },
    { status: 200, responseText: '<html>network error</html>' }]) {
    const h = releaseHarness(); h.request().onload(response);
    await assert.rejects(h.promise); assert.equal(h.cleared(), 1);
  }
});

test('the independent deadline aborts a hung version request and ignores late responses', async () => {
  const h = releaseHarness();
  const rejected = assert.rejects(h.promise, /超时/);
  h.expire(); await rejected;
  h.request().onload({ status: 200, responseText: metadata });
  assert.equal(h.aborted(), 1); assert.equal(h.cleared(), 1);
});

test('network, permission and native timeout errors are recoverable and clean up timers', async () => {
  for (const event of ['onerror', 'ontimeout', 'onabort']) {
    const h = releaseHarness(); h.request()[event]();
    await assert.rejects(h.promise); assert.equal(h.cleared(), 1);
  }
  let cleared = false;
  await assert.rejects(core.fetchRelease(() => { throw Error('denied'); }, {
    setTimer: () => 1, clearTimer: () => { cleared = true; }
  }), /允许访问/);
  assert.equal(cleared, true);
});
