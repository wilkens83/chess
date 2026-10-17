import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, NO_START_MS, canMate, type GamePlayer, type VersionedEvent } from '../src/server/game.ts';

const player = (ownerId: string): GamePlayer => ({ userId: null, ownerId, name: null, rating: null, provisional: false, ratingDiff: null });

function newGame(limit = 60, increment = 0) {
  let t = 1_000_000;
  const time = { now: () => t, advance: (ms: number) => (t += ms) };
  const game = new Game({ id: 'abcdefgh', clock: { limit, increment }, rated: false, white: player('w'), black: player('b'), now: time.now });
  const events: VersionedEvent[] = [];
  game.onEvent = (e) => events.push(e);
  return { game, time, events };
}

function play(game: Game, ...moves: string[]) {
  for (const m of moves) {
    const res = game.move(game.turn, m);
    assert.deepEqual(res, { ok: true }, `move ${m}`);
  }
}

test("fool's mate ends the game with black winning", () => {
  const { game, events } = newGame();
  play(game, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.equal(game.status, 'mate');
  assert.equal(game.winner, 'black');
  assert.deepEqual(
    events.map((e) => e.t),
    ['move', 'move', 'move', 'move', 'end'],
  );
  assert.deepEqual(
    events.map((e) => e.v),
    [1, 2, 3, 4, 5],
  );
  assert.match(game.pgn(), /1\. f3 e5 2\. g4 Qh4# 0-1/);
});

test('rejects illegal, malformed and out-of-turn moves', () => {
  const { game } = newGame();
  assert.deepEqual(game.move('white', 'e2e5'), { ok: false, error: 'illegal move' });
  assert.deepEqual(game.move('white', 'zz'), { ok: false, error: 'malformed move' });
  assert.deepEqual(game.move('black', 'e7e5'), { ok: false, error: 'not your turn' });
  assert.equal(game.ply, 0);
});

test('promotion moves include the promoted piece', () => {
  const { game } = newGame();
  play(game, 'a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'c8b7', 'a6b7', 'b8c6', 'b7a8q');
  assert.equal(game.uciMoves.at(-1), 'b7a8q');
  assert.equal(game.data().sans.at(-1), 'bxa8=Q');
});

test('clocks start only after both sides have moved', () => {
  const { game, time } = newGame(60, 0);
  time.advance(20_000);
  play(game, 'e2e4');
  time.advance(20_000);
  play(game, 'e7e5');
  assert.equal(game.clock.remainingMs('white'), 60_000);
  assert.equal(game.clock.remainingMs('black'), 60_000);
  time.advance(3000);
  assert.equal(game.clock.remainingMs('white'), 57_000);
});

test('flag falls: the opponent wins on time', () => {
  const { game, time } = newGame(10, 0);
  play(game, 'e2e4', 'e7e5');
  time.advance(10_001);
  assert.equal(game.tick(), true);
  assert.equal(game.status, 'outoftime');
  assert.equal(game.winner, 'black');
});

test('flag falls but the opponent cannot mate: draw', () => {
  assert.equal(canMate('8/8/8/4k3/8/8/8/4K2N w - - 0 1', 'white'), false);
  assert.equal(canMate('8/8/8/4k3/8/8/8/3NK2N w - - 0 1', 'white'), true);
  assert.equal(canMate('8/8/8/4k3/8/8/4P3/4K3 w - - 0 1', 'white'), true);
});

test('abort is allowed only before both sides moved; resign after', () => {
  const { game } = newGame();
  play(game, 'e2e4');
  assert.equal(game.canAbort(), true);
  play(game, 'e7e5');
  assert.equal(game.abort(), false);
  assert.equal(game.resign('white'), true);
  assert.equal(game.status, 'resign');
  assert.equal(game.winner, 'black');
});

test('draw offers: accept, decline, and implicit decline by moving', () => {
  const { game } = newGame();
  play(game, 'e2e4', 'e7e5');
  assert.equal(game.drawYes('white'), true);
  assert.equal(game.drawOffer, 'white');
  play(game, 'g1f3'); // white's own move keeps the offer
  assert.equal(game.drawOffer, 'white');
  play(game, 'b8c6'); // black moves instead of accepting: declined
  assert.equal(game.drawOffer, null);
  game.drawYes('black');
  game.drawNo('white');
  assert.equal(game.drawOffer, null);
  game.drawYes('black');
  game.drawYes('white');
  assert.equal(game.status, 'draw');
  assert.equal(game.winner, null);
});

test('threefold repetition is a draw', () => {
  const { game } = newGame();
  play(game, 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.equal(game.status, 'draw');
});

test('a game nobody starts ends as noStart', () => {
  const { game, time } = newGame();
  time.advance(NO_START_MS + 1);
  assert.equal(game.tick(), true);
  assert.equal(game.status, 'noStart');
});

test('eventsSince replays missed events and rejects bad versions', () => {
  const { game } = newGame();
  play(game, 'e2e4', 'e7e5', 'g1f3');
  assert.deepEqual(
    game.eventsSince(1)?.map((e) => e.v),
    [2, 3],
  );
  assert.deepEqual(game.eventsSince(3), []);
  assert.equal(game.eventsSince(4), null);
});

test('restore rebuilds a stored game', () => {
  const g = Game.restore(
    { id: 'abcdefgh', clock: { limit: 60, increment: 0 }, rated: false, white: player('w'), black: player('b') },
    ['e2e4', 'e7e5'],
    'resign',
    'white',
    123,
  );
  assert.equal(g.ply, 2);
  assert.equal(g.finished, true);
  assert.equal(g.data().sans.join(' '), 'e4 e5');
});
