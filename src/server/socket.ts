import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Game, VersionedEvent } from './game.ts';
import type { GameService } from './games.ts';
import type { Lobby } from './lobby.ts';
import type { Viewer } from './viewer.ts';
import { PING, PONG, type Color, type CrowdEvent } from '../shared/protocol.ts';

type Route =
  | { kind: 'lobby' }
  | { kind: 'site' }
  | { kind: 'play'; gameId: string }
  | { kind: 'watch'; gameId: string };

interface Conn {
  ws: WebSocket;
  viewer: Viewer;
  route: Route;
  /** Color the connection plays, for play sockets. */
  color: Color | null;
  unsubscribe: (() => void)[];
  /** Messages received in the current rate-limit window. */
  budget: number;
}

const MAX_MESSAGES_PER_SECOND = 30;
const MAX_MESSAGE_BYTES = 2048;

export function parseRoute(pathname: string): Route | null {
  if (pathname === '/lobby/socket/v5') return { kind: 'lobby' };
  if (pathname === '/socket/v5') return { kind: 'site' };
  let m = /^\/play\/([a-zA-Z0-9]{8})\/v6$/.exec(pathname);
  if (m) return { kind: 'play', gameId: m[1]! };
  m = /^\/watch\/([a-zA-Z0-9]{8})\/(?:white|black)\/v6$/.exec(pathname);
  if (m) return { kind: 'watch', gameId: m[1]! };
  return null;
}

/**
 * WebSocket gateway. Socket paths and framing follow the protocol observed
 * on lichess.org: `/lobby/socket/v5`, `/play/{id}/v6`, `/watch/{id}/{color}/v6`.
 */
export class SocketHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly conns = new Set<Conn>();
  private readonly byGame = new Map<string, Set<Conn>>();
  private readonly rateTimer: NodeJS.Timeout;

  constructor(
    private readonly games: GameService,
    private readonly lobby: Lobby,
  ) {
    lobby.onChange = () => {
      for (const c of this.conns) if (c.route.kind === 'lobby') send(c, { t: 'seeks', d: lobby.list(c.viewer.id) });
    };
    games.onRematch = (from, to) => this.broadcastGame(from, { t: 'redirect', d: { id: to } });
    games.onFeatured = (g) => this.broadcastLobby({ t: 'featured', d: featuredData(g) });
    this.rateTimer = setInterval(() => {
      for (const c of this.conns) c.budget = 0;
    }, 1000);
  }

  get connections(): number {
    return this.conns.size;
  }

  close(): void {
    clearInterval(this.rateTimer);
    for (const c of this.conns) c.ws.terminate();
    this.wss.close();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, viewer: Viewer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = parseRoute(url.pathname);
    const game = route && (route.kind === 'play' || route.kind === 'watch') ? this.games.load(route.gameId) : null;
    if (!route || ((route.kind === 'play' || route.kind === 'watch') && !game)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const color = route.kind === 'play' ? game!.colorOf(viewer.id) : null;
    if (route.kind === 'play' && !color) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Conn = { ws, viewer, route, color, unsubscribe: [], budget: 0 };
      this.open(conn, url.searchParams.get('v'), game);
    });
  }

  private open(conn: Conn, versionParam: string | null, game: Game | null): void {
    this.conns.add(conn);
    conn.ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      if (++conn.budget > MAX_MESSAGES_PER_SECOND) {
        conn.ws.close(1008, 'rate limited');
        return;
      }
      this.receive(conn, raw.toString());
    });
    conn.ws.on('close', () => this.closed(conn));
    conn.ws.on('error', () => conn.ws.terminate());

    if (game) {
      let set = this.byGame.get(game.id);
      if (!set) this.byGame.set(game.id, (set = new Set()));
      set.add(conn);
      // Replay what the client missed since the version it last saw.
      const since = versionParam === null ? game.version : Number(versionParam);
      const missed = Number.isInteger(since) ? game.eventsSince(since) : null;
      if (missed === null) send(conn, { t: 'resync' });
      else for (const e of missed) send(conn, e);
      conn.unsubscribe.push(this.games.subscribe(game.id, (e: VersionedEvent) => send(conn, e)));
      this.broadcastCrowd(game.id);
    }
    if (conn.route.kind === 'lobby') {
      send(conn, { t: 'seeks', d: this.lobby.list(conn.viewer.id) });
      const featured = this.games.featured();
      if (featured) send(conn, { t: 'featured', d: featuredData(featured) });
    }
  }

  private closed(conn: Conn): void {
    this.conns.delete(conn);
    for (const u of conn.unsubscribe) u();
    const route = conn.route;
    if (route.kind === 'play' || route.kind === 'watch') {
      this.byGame.get(route.gameId)?.delete(conn);
      if (this.byGame.get(route.gameId)?.size === 0) this.byGame.delete(route.gameId);
      else this.broadcastCrowd(route.gameId);
    }
    if (route.kind === 'lobby' && ![...this.conns].some((c) => c.route.kind === 'lobby' && c.viewer.id === conn.viewer.id)) {
      this.lobby.removeByOwner(conn.viewer.id);
    }
  }

  private receive(conn: Conn, raw: string): void {
    if (raw === PING) {
      if (conn.route.kind === 'lobby') send(conn, { t: 'n', d: this.conns.size, r: this.games.playing });
      else conn.ws.send(PONG);
      return;
    }
    let msg: { t?: unknown; d?: unknown };
    try {
      msg = JSON.parse(raw) as { t?: unknown; d?: unknown };
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;
    const route = conn.route;
    if (route.kind === 'play') this.receivePlay(conn, route.gameId, msg.t, msg.d);
    else if (route.kind === 'lobby') this.receiveLobby(conn, msg.t, msg.d);
  }

  private receivePlay(conn: Conn, gameId: string, t: string, d: unknown): void {
    const game = this.games.get(gameId);
    const color = conn.color;
    if (!game || !color) return;
    switch (t) {
      case 'move': {
        const data = (d ?? {}) as { u?: unknown; l?: unknown; a?: unknown };
        if (typeof data.a === 'number') send(conn, { t: 'ack', d: data.a });
        if (typeof data.u !== 'string') return;
        const lag = typeof data.l === 'number' && Number.isFinite(data.l) ? data.l : 0;
        const res = game.move(color, data.u, lag);
        // A rejected move means the client's view is stale; make it reload state.
        if (!res.ok) send(conn, { t: 'resync', d: res.error });
        return;
      }
      case 'resign':
        game.resign(color);
        return;
      case 'abort':
        game.abort();
        return;
      case 'draw-yes':
        game.drawYes(color);
        return;
      case 'draw-no':
        game.drawNo(color);
        return;
      case 'rematch':
        if (!this.games.rematch(game, color) && game.finished) {
          this.broadcastGame(gameId, { t: 'rematchOffer', d: { by: this.games.rematchOffer(gameId) } });
        }
        return;
    }
  }

  private receiveLobby(conn: Conn, t: string, d: unknown): void {
    const participant = { ownerId: conn.viewer.id, user: conn.viewer.user };
    switch (t) {
      case 'seek': {
        const data = (d ?? {}) as { limit?: unknown; increment?: unknown; rated?: unknown };
        if (typeof data.limit !== 'number' || typeof data.increment !== 'number') return;
        const res = this.lobby.add(participant, { limit: data.limit, increment: data.increment }, data.rated === true);
        if (!res.ok) send(conn, { t: 'error', d: res.error });
        return;
      }
      case 'cancelSeek':
        this.lobby.removeByOwner(conn.viewer.id);
        return;
      case 'joinSeek': {
        if (typeof d !== 'string') return;
        const res = this.lobby.join(d, participant);
        if (!res.ok) {
          send(conn, { t: 'error', d: res.error });
          return;
        }
        for (const c of this.conns) {
          if (c.route.kind === 'lobby' && res.ownerIds.includes(c.viewer.id)) send(c, { t: 'redirect', d: { id: res.game.id } });
        }
        return;
      }
      case 'startWatching': {
        if (typeof d !== 'string') return;
        for (const id of d.split(' ').slice(0, 20)) {
          const game = this.games.get(id);
          if (!game) continue;
          conn.unsubscribe.push(
            this.games.subscribe(id, (e) => {
              if (e.t === 'move')
                send(conn, {
                  t: 'fen',
                  d: { id, lm: e.d.uci, fen: e.d.fen, wc: Math.round(e.d.clock?.white ?? 0), bc: Math.round(e.d.clock?.black ?? 0) },
                });
            }),
          );
        }
        return;
      }
    }
  }

  crowd(gameId: string): CrowdEvent {
    const game = this.games.load(gameId);
    const conns = this.byGame.get(gameId) ?? new Set<Conn>();
    let white = false;
    let black = false;
    const watchers = new Set<string>();
    const names = new Set<string>();
    for (const c of conns) {
      if (c.color === 'white') white = true;
      else if (c.color === 'black') black = true;
      else {
        watchers.add(c.viewer.id);
        if (c.viewer.user) names.add(c.viewer.user.username);
      }
    }
    // A player watching their own game from a second tab still counts as the player.
    if (game) {
      watchers.delete(game.players.white.ownerId);
      watchers.delete(game.players.black.ownerId);
    }
    return { white, black, watchers: { nb: watchers.size, names: [...names].slice(0, 10) } };
  }

  onGame(gameId: string): Record<Color, boolean> {
    const crowd = this.crowd(gameId);
    return { white: crowd.white, black: crowd.black };
  }

  private broadcastCrowd(gameId: string): void {
    this.broadcastGame(gameId, { t: 'crowd', d: this.crowd(gameId) });
  }

  private broadcastGame(gameId: string, msg: object): void {
    for (const c of this.byGame.get(gameId) ?? []) send(c, msg);
  }

  private broadcastLobby(msg: object): void {
    for (const c of this.conns) if (c.route.kind === 'lobby') send(c, msg);
  }
}

function send(conn: Conn, msg: object): void {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
}

function featuredData(g: Game) {
  const p = (c: Color) => ({ name: g.players[c].name, rating: g.players[c].rating });
  const clock = g.clock.state();
  return { id: g.id, fen: g.fen, lm: g.uciMoves.at(-1) ?? null, white: p('white'), black: p('black'), wc: clock.white, bc: clock.black };
}
