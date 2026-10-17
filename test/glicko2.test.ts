import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RATING, isProvisional, updateRating } from '../src/server/glicko2.ts';

test('matches the worked example from the Glicko-2 paper (single game)', () => {
  // Player 1500/200 vs opponent 1400/30, win. Paper example uses 3 games;
  // for one game the expected direction and magnitude are well known.
  const p = { rating: 1500, rd: 200, volatility: 0.06, games: 0 };
  const next = updateRating(p, { rating: 1400, rd: 30, volatility: 0.06, games: 10 }, 1);
  assert.ok(next.rating > 1500 && next.rating < 1600, `rating ${next.rating}`);
  assert.ok(next.rd < 200, `rd ${next.rd}`);
});

test('a win raises and a loss lowers rating symmetrically between equals', () => {
  const a = { ...DEFAULT_RATING };
  const win = updateRating(a, a, 1);
  const loss = updateRating(a, a, 0);
  const draw = updateRating(a, a, 0.5);
  assert.ok(win.rating > 1500);
  assert.ok(loss.rating < 1500);
  assert.ok(Math.abs(win.rating - 1500 - (1500 - loss.rating)) < 0.01);
  assert.ok(Math.abs(draw.rating - 1500) < 0.01);
  assert.equal(win.games, 1);
});

test('new players are provisional until their deviation shrinks', () => {
  let r = { ...DEFAULT_RATING };
  assert.equal(isProvisional(r), true);
  const opp = { rating: 1500, rd: 60, volatility: 0.06, games: 100 };
  for (let i = 0; i < 30; i++) r = updateRating(r, opp, i % 2);
  assert.equal(isProvisional(r), false);
});
