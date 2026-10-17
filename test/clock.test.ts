import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clock, MAX_COMP_MS, QUOTA_START_MS } from '../src/server/clock.ts';

function fakeTime() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('deducts elapsed time and adds the increment', () => {
  const time = fakeTime();
  const c = new Clock({ limit: 60, increment: 2 }, time.now);
  c.start('white');
  time.advance(5000);
  assert.equal(c.remainingMs('white'), 55_000);
  assert.equal(c.press('white'), true);
  assert.equal(c.remainingMs('white'), 57_000);
  assert.equal(c.runningColor, 'black');
  time.advance(1000);
  assert.equal(c.remainingMs('black'), 59_000);
});

test('flags a player whose time runs out', () => {
  const time = fakeTime();
  const c = new Clock({ limit: 1, increment: 0 }, time.now);
  c.start('white');
  time.advance(999);
  assert.equal(c.flagged(), null);
  time.advance(2);
  assert.equal(c.flagged(), 'white');
});

test('a move arriving after the flag fell is rejected', () => {
  const time = fakeTime();
  const c = new Clock({ limit: 1, increment: 5 }, time.now);
  c.start('white');
  time.advance(1500);
  assert.equal(c.press('white'), false);
  assert.equal(c.remainingMs('white'), 0);
});

test('lag compensation is capped per move and by a quota', () => {
  const time = fakeTime();
  const c = new Clock({ limit: 60, increment: 0 }, time.now);
  c.start('white');
  time.advance(3000);
  c.press('white', 5000); // claims absurd lag
  assert.equal(c.lastCompensation, MAX_COMP_MS);
  assert.equal(c.remainingMs('white'), 60_000 - 3000 + MAX_COMP_MS);

  // Repeated claims drain the quota until compensation stops.
  let refunded = MAX_COMP_MS;
  for (let i = 0; i < 20; i++) {
    c.press('black');
    time.advance(2000);
    c.press('white', 1000);
    refunded += c.lastCompensation;
    time.advance(100);
  }
  assert.ok(refunded < QUOTA_START_MS + 21 * 100 + 1, `refunded ${refunded}ms`);
});

test('compensation never exceeds the time actually spent', () => {
  const time = fakeTime();
  const c = new Clock({ limit: 60, increment: 0 }, time.now);
  c.start('white');
  time.advance(200);
  c.press('white', 900);
  assert.equal(c.lastCompensation, 200);
  assert.equal(c.remainingMs('white'), 60_000);
});
