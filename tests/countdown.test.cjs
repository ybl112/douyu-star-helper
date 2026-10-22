'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../douyu-star-background.user.js');

function documentFor({ id = 123, seconds = 17, open = false, hidden = false, text } = {}) {
  const bag = { querySelector(selector) {
    if (selector.endsWith('--btn')) return seconds === null ? null : { textContent: text ?? `${seconds}秒后可抢` };
    if (selector.endsWith('--btnOpen')) return open ? { style: { display: hidden ? 'none' : 'block' } } : null;
    return null;
  } };
  return { getElementById: name => name === `LiveNewAnchorSupportT-bagReadySvga-${id}` ? { closest: () => bag } : null };
}

test('official countdown reading uses the exact packet ID and actual current text, not a derived end time', () => {
  const doc = documentFor();
  assert.equal(core.readOfficialTimer(doc, 123, 1000).remainingSec, 17);
  assert.equal(core.readOfficialTimer(doc, 123, 601000).remainingSec, 17);
  assert.equal(core.readOfficialTimer(doc, 124, 1000), null);
  assert.equal(core.readOfficialTimer(doc, '<invalid>', 1000), null);
});

test('only the native open button is accepted as availability; missing or malformed text is not zero', () => {
  assert.equal(core.readOfficialTimer(documentFor({ seconds: null, open: true }), 123, 1000).state, 'available');
  for (const value of [{ seconds: null }, { text: '领取更多红包' }, { text: '0秒后可抢' },
    { seconds: null, open: true, hidden: true }, { text: '预计17秒' }]) {
    assert.equal(core.readOfficialTimer(documentFor(value), 123, 1000), null);
  }
});

test('stale, future, unbound and inconsistent observations cannot authorize a claim', () => {
  const timer = core.readOfficialTimer(documentFor(), 123, 10000);
  assert.equal(core.observedTimer({ timer }, 123, 14000).remainingSec, 17);
  for (const [value, id, now] of [[timer, 124, 10000], [timer, 123, 15001], [timer, 123, 8000],
    [{ ...timer, source: 'estimate' }, 123, 10000], [{ ...timer, remainingSec: 0 }, 123, 10000],
    [{ ...timer, state: 'available' }, 123, 10000]]) {
    assert.equal(core.observedTimer({ timer: value }, id, now), null);
  }
});

test('production contains no proportional wait scheduling or estimated retry-countdown display', () => {
  const source = fs.readFileSync(path.join(__dirname, '../douyu-star-background.user.js'), 'utf8');
  assert.equal(core.waitPlan, undefined);
  assert.doesNotMatch(source, /firstAt|expectedAt|job\.tries\s*\*\s*5000|job\.due\s*-\s*Date\.now\(\)/);
  assert.ok(source.includes('未读到倒计时'));
});

test('official stringified result data is decoded without treating invalid payloads as successful rewards', () => {
  const payload = { error: 0, data: JSON.stringify({ prizeList: [{ ptype: 9, num: 37 }] }) };
  assert.equal(core.classify(payload), 'success');
  assert.equal(core.prizes(core.workerReply(payload).data.prizeList).coins, 37);
  assert.equal(core.classify({ error: 0, data: 'invalid JSON' }), 'unknown');
  assert.equal(core.classify({ error: 0, data: '[]' }), 'unknown');
});
