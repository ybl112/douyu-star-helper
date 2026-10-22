'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../douyu-star-background.user.js');

function draggable() {
  const listeners = new Map(), captured = new Set(), saves = [];
  let position = { x: 30, y: 40 }, now = 1000;
  const handle = {
    addEventListener(name, fn, capture = false) { listeners.set(`${name}:${capture}`, fn); },
    removeEventListener(name, _fn, capture = false) { listeners.delete(`${name}:${capture}`); },
    setPointerCapture(id) { captured.add(id); }, hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id)
  };
  const cleanup = core.bindDrag(handle, {
    rect: () => ({ ...position, width: 100, height: 60 }), viewport: () => ({ width: 800, height: 600 }),
    move: value => { position = value; }, save: value => saves.push(value), now: () => now
  });
  return { handle, saves, captured, listeners, cleanup, position: () => position,
    advance: ms => { now += ms; },
    fire(name, extra = {}) {
      const event = { pointerId: 1, button: 0, isPrimary: true, target: handle,
        clientX: 40, clientY: 50, detail: 1, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
      listeners.get(`${name}:${name === 'click'}`)?.(event);
      return event;
    }
  };
}

test('panel and chip positions stay inside the viewport, including invalid storage and oversized content', () => {
  assert.deepEqual(core.clampPosition({ x: -50, y: 900 }, { width: 100, height: 60 }, { width: 800, height: 600 }), { x: 8, y: 532 });
  assert.deepEqual(core.clampPosition({ x: 2000, y: 2000 }, { width: 370, height: 700 }, { width: 320, height: 480 }), { x: 8, y: 8 });
  assert.deepEqual(core.clampPosition({ x: 'broken', y: Infinity }, { width: 100, height: 60 }, { width: 800, height: 600 }), { x: 18, y: 18 });
});

test('dragging updates the position, saves only on release, and suppresses the synthetic click', () => {
  const h = draggable(); h.fire('pointerdown');
  h.fire('pointermove', { clientX: 120, clientY: 150 });
  assert.deepEqual(h.position(), { x: 110, y: 140 }); assert.equal(h.saves.length, 0);
  h.fire('pointerup'); assert.deepEqual(h.saves, [{ x: 110, y: 140 }]);
  assert.equal(h.captured.size, 0);
  const click = h.fire('click'); assert.equal(click.prevented, true); assert.equal(click.stopped, true);
  assert.equal(h.fire('click').stopped, false);
});

test('a click or small pointer jitter still opens the chip and does not store a drag position', () => {
  const h = draggable(); h.fire('pointerdown');
  h.fire('pointermove', { clientX: 42, clientY: 52 }); h.fire('pointerup');
  assert.deepEqual(h.position(), { x: 30, y: 40 }); assert.equal(h.saves.length, 0);
  assert.equal(h.fire('click').stopped, false);
});

test('dragging ignores child controls, secondary buttons, other pointers and multi-touch', () => {
  for (const extra of [{ button: 2 }, { isPrimary: false }, { target: { closest: () => ({}) } }]) {
    const h = draggable(); h.fire('pointerdown', extra);
    h.fire('pointermove', { clientX: 400 }); h.fire('pointerup');
    assert.equal(h.saves.length, 0); assert.deepEqual(h.position(), { x: 30, y: 40 });
  }
  const h = draggable(); h.fire('pointerdown'); h.fire('pointerdown', { pointerId: 2 });
  h.fire('pointermove', { pointerId: 2, clientX: 400 });
  h.fire('pointerup', { pointerId: 2 }); assert.equal(h.saves.length, 0);
  h.fire('pointermove', { clientX: 80 }); h.fire('pointerup');
  assert.equal(h.saves.length, 1);
});

test('cancelled or lost pointer capture ends dragging cleanly and supports another gesture', () => {
  for (const event of ['pointercancel', 'lostpointercapture']) {
    const h = draggable(); h.fire('pointerdown'); h.fire('pointermove', { clientX: 80 }); h.fire(event);
    assert.equal(h.captured.size, 0); assert.equal(h.saves.length, 1);
    h.fire('pointermove', { clientX: 400 }); assert.deepEqual(h.position(), { x: 70, y: 40 });
    h.fire('pointerdown'); h.fire('pointermove', { clientY: 100 }); h.fire('pointerup');
    assert.equal(h.saves.length, 2);
    h.cleanup(); assert.equal(h.listeners.size, 0);
  }
});

test('drag suppression never blocks keyboard activation and expires before the next ordinary click', () => {
  const h = draggable(); h.fire('pointerdown'); h.fire('pointermove', { clientX: 80 }); h.fire('pointerup');
  assert.equal(h.fire('click', { detail: 0 }).stopped, false);
  h.advance(501); assert.equal(h.fire('click').stopped, false);
});
