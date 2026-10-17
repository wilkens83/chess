import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp, type App } from '../src/server/app.ts';

let app: App;
let base: string;

before(async () => {
  app = createApp({ dbPath: ':memory:', publicDir: 'public' });
  await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(() => app.close());

/** A browser: keeps its cookies across requests and sockets. */
class Client {
  cookies = new Map<string, string>();

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(base + path, { ...init, redirect: 'manual', headers: { ...(init.headers as object), cookie: this.cookieHeader } });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair!.split('=');
      if (v === '') this.cookies.delete(k!);
      else this.cookies.set(k!, v!);
    }
    return res;
  }

  form(path: string, fields: Record<string, string>): Promise<Response> {
    return this.fetch(path, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  socket(path: string): Promise<Sock> {
    const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: { cookie: this.cookieHeader } });
    const sock = new Sock(ws);
    return new Promise((ok, fail) => {
      ws.once('open', () => ok(sock));
      ws.once('unexpected-response', (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', fail);
    });
  }
}

type Msg = { t: string; d?: any; v?: number; r?: number };

class Sock {
  received: (Msg | string)[] = [];
  private waiters: { pred: (m: Msg | string) => boolean; ok: (m: any) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const text = raw.toString();
      const msg = text === '0' ? text : (JSON.parse(text) as Msg);
      this.received.push(msg);
      this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.ok(msg), false) : true));
    });
  }

  send(t: string, d?: unknown): void {
    this.ws.send(JSON.stringify(d === undefined ? { t } : { t, d }));
  }

  /** Resolve with the first message (already received or future) matching `pred`. */
  wait(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const p = (m: Msg | string) => typeof m !== 'string' && pred(m);
    const seen = this.received.find(p);
    if (seen) return Promise.resolve(seen as Msg);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('timed out waiting for message')), timeoutMs);
      this.waiters.push({ pred: p, ok: (m) => (clearTimeout(timer), ok(m)) });
    });
  }

  waitType(t: string, extra: (m: Msg) => boolean = () => true): Promise<Msg> {
    return this.wait((m) => m.t === t && extra(m));
  }

  close(): void {
    this.ws.close();
  }
}

async function browser(): Promise<Client> {
  const c = new Client();
  const res = await c.fetch('/');
  assert.equal(res.status, 200);
  assert.ok(c.cookies.has('anon'), 'anonymous cookie set');
  return c;
}

/** Pair two clients through the lobby and return the game id and who plays white. */
async function pair(a: Client, b: Client, opts: { limit: number; increment: number; rated: boolean }) {
  const la = await a.socket('/lobby/socket/v5');
  const lb = await b.socket('/lobby/socket/v5');
  la.send('seek', opts);
  const seeks = await lb.waitType('seeks', (m) => m.d.length === 1);
  assert.equal(seeks.d[0].mine, false);
  lb.send('joinSeek', seeks.d[0].id);
  const [ra, rb] = await Promise.all([la.waitType('redirect'), lb.waitType('redirect')]);
  assert.equal(ra.d.id, rb.d.id);
  la.close();
  lb.close();
  const id = ra.d.id as string;
  const data = (await (await a.fetch(`/api/game/${id}`)).json()) as { player: 'white' | 'black' };
  return { id, white: data.player === 'white' ? a : b, black: data.player === 'white' ? b : a };
}

test('pages render with a strict CSP and embedded page data', async () => {
  const c = await browser();
  const res = await c.fetch('/analysis');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self' 'nonce-/);
  const html = await res.text();
  assert.match(html, /id="page-data"/);
  assert.equal((await c.fetch('/nope-nope')).status, 404);
});

test("two anonymous players pair in the lobby and play fool's mate", async () => {
  const { id, white, black } = await pair(await browser(), await browser(), { limit: 180, increment: 2, rated: false });
  const ws = await white.socket(`/play/${id}/v6?v=0`);
  const bs = await black.socket(`/play/${id}/v6?v=0`);
  await ws.waitType('crowd', (m) => m.d.white && m.d.black);

  // Ping/pong on game sockets is the bare "0".
  ws.ws.send('p');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(ws.received.includes('0'));

  const moves: [Sock, string][] = [
    [ws, 'f2f3'],
    [bs, 'e7e5'],
    [ws, 'g2g4'],
    [bs, 'd8h4'],
  ];
  for (const [i, [sock, uci]] of moves.entries()) {
    sock.ws.send(JSON.stringify({ t: 'move', d: { u: uci, a: i + 1 } }));
    await sock.waitType('ack', (m) => m.d === i + 1);
    await ws.waitType('move', (m) => m.d.ply === i + 1);
  }
  const end = await bs.waitType('end');
  assert.deepEqual({ status: end.d.status, winner: end.d.winner }, { status: 'mate', winner: 'black' });

  const api = (await (await white.fetch(`/api/game/${id}`)).json()) as { game: { status: string; sans: string[]; version: number } };
  assert.equal(api.game.status, 'mate');
  assert.deepEqual(api.game.sans, ['f3', 'e5', 'g4', 'Qh4#']);
  const pgn = await (await white.fetch(`/game/export/${id}.pgn`)).text();
  assert.match(pgn, /\[Result "0-1"\]/);

  // Reconnecting with an old version replays exactly the missed events.
  const late = await (await browser()).socket(`/watch/${id}/white/v6?v=2`);
  const replayed = await late.waitType('end');
  assert.equal(replayed.v, 5);
  assert.deepEqual(
    late.received.filter((m): m is Msg => typeof m !== 'string' && typeof m.v === 'number').map((m) => m.v),
    [3, 4, 5],
  );
  for (const s of [ws, bs, late]) s.close();
});

test('only the two players may open a play socket; others may watch', async () => {
  const { id } = await pair(await browser(), await browser(), { limit: 300, increment: 0, rated: false });
  const stranger = await browser();
  await assert.rejects(stranger.socket(`/play/${id}/v6`), /HTTP 403/);
  const watch = await stranger.socket(`/watch/${id}/white/v6`);
  const crowd = await watch.waitType('crowd');
  assert.equal(crowd.d.watchers.nb, 1);
  watch.close();
});

test('an illegal move is rejected with a resync', async () => {
  const { id, white } = await pair(await browser(), await browser(), { limit: 300, increment: 0, rated: false });
  const ws = await white.socket(`/play/${id}/v6`);
  ws.send('move', { u: 'e2e5' });
  const resync = await ws.waitType('resync');
  assert.equal(resync.d, 'illegal move');
  ws.close();
});

test('the lobby pong carries player and game counts', async () => {
  const c = await browser();
  const lobby = await c.socket('/lobby/socket/v5');
  lobby.ws.send('p');
  const n = await lobby.waitType('n');
  assert.ok(typeof n.d === 'number' && n.d >= 1);
  assert.ok(typeof n.r === 'number');
  lobby.close();
});

test('accounts: signup, login, rated game and rating update', async () => {
  const alice = await browser();
  const bob = await browser();
  assert.equal((await alice.form('/signup', { username: 'alice', password: 'correct horse' })).status, 303);
  assert.equal((await bob.form('/signup', { username: 'bob', password: 'battery staple' })).status, 303);
  assert.equal((await alice.form('/signup', { username: 'Alice', password: 'whatever123' })).status, 400, 'usernames are case-insensitive');

  // Anonymous players cannot seek rated games.
  const anonLobby = await (await browser()).socket('/lobby/socket/v5');
  anonLobby.send('seek', { limit: 300, increment: 0, rated: true });
  assert.match((await anonLobby.waitType('error')).d, /log in/);
  anonLobby.close();

  const { id, white, black } = await pair(alice, bob, { limit: 300, increment: 3, rated: true });
  const ws = await white.socket(`/play/${id}/v6`);
  const bs = await black.socket(`/play/${id}/v6`);
  ws.send('move', { u: 'e2e4' });
  await bs.waitType('move', (m) => m.d.ply === 1);
  bs.send('move', { u: 'e7e5' });
  await ws.waitType('move', (m) => m.d.ply === 2);
  bs.send('resign');
  const end = await ws.waitType('end');
  assert.equal(end.d.winner, 'white');
  assert.ok(end.d.ratingDiff.white > 0 && end.d.ratingDiff.black < 0, JSON.stringify(end.d.ratingDiff));

  const winnerName = white === alice ? 'alice' : 'bob';
  const profile = await (await alice.fetch(`/@/${winnerName}`)).text();
  assert.match(profile, /1 games/);
  assert.match(profile, /Win/);

  // Rematch: both ask, both are redirected to a new game with colors swapped.
  ws.send('rematch');
  await bs.waitType('rematchOffer', (m) => m.d.by === 'white');
  bs.send('rematch');
  const [r1, r2] = await Promise.all([ws.waitType('redirect'), bs.waitType('redirect')]);
  assert.equal(r1.d.id, r2.d.id);
  const next = (await (await white.fetch(`/api/game/${r1.d.id}`)).json()) as { player: string };
  assert.equal(next.player, 'black');
  ws.close();
  bs.close();

  // Logout, then log back in with the password.
  await alice.form('/logout', {});
  assert.equal((await alice.form('/login', { username: 'alice', password: 'wrong password' })).status, 401);
  assert.equal((await alice.form('/login', { username: 'ALICE', password: 'correct horse' })).status, 303);
  assert.match(await (await alice.fetch('/')).text(), /data-user="alice"/);
});

test('cross-origin form posts are refused', async () => {
  const c = await browser();
  const res = await c.fetch('/signup', {
    method: 'POST',
    body: new URLSearchParams({ username: 'mallory', password: 'password123' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
});
