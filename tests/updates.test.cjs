'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
  assert.doesNotMatch(source, /^\/\/ @grant +(?:GM_xmlhttpRequest|GM_notification|GM_info)$/m);
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
