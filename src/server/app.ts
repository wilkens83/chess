import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { cookie, hashPassword, randomId, validateSignup, verifyPassword } from './auth.ts';
import { Db } from './db.ts';
import { GameService } from './games.ts';
import { Lobby } from './lobby.ts';
import { SocketHub } from './socket.ts';
import { ANON_COOKIE, SESSION_COOKIE, resolveViewer, type Viewer } from './viewer.ts';
import * as views from './views.ts';
import type { GamePageData } from '../shared/protocol.ts';

export interface AppOptions {
  dbPath: string;
  publicDir: string;
  /** Mark cookies Secure (set when served over HTTPS). */
  secureCookies?: boolean;
  now?: () => number;
}

export interface App {
  server: Server;
  db: Db;
  games: GameService;
  lobby: Lobby;
  hub: SocketHub;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.nnue': 'application/octet-stream',
};

const SESSION_MAX_AGE = 365 * 24 * 3600;
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

export function createApp(opts: AppOptions): App {
  const db = new Db(opts.dbPath);
  const games = new GameService(db, opts.now);
  const lobby = new Lobby(games);
  const hub = new SocketHub(games, lobby);
  const publicDir = resolve(opts.publicDir);
  const loginAttempts = new Map<string, number[]>();
  games.start();

  let manifest: Record<string, string> = {};
  let manifestMtime = 0;
  const assets = (name: string): string => {
    try {
      const path = join(publicDir, 'build', 'manifest.json');
      const mtime = statSync(path).mtimeMs;
      if (mtime !== manifestMtime) {
        manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
        manifestMtime = mtime;
      }
    } catch {
      // No build yet: fall back to unhashed names.
    }
    return `/build/${manifest[name] ?? name}`;
  };

  const page = (res: ServerResponse, viewer: Viewer, status: number, o: Omit<views.LayoutOpts, 'viewer' | 'nonce' | 'assets'>) => {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    res.end(views.layout({ ...o, viewer, nonce, assets }));
  };

  const notFound = (res: ServerResponse, viewer: Viewer) =>
    page(res, viewer, 404, { title: 'Not found', body: views.messageBody('Not found', 'This page does not exist.') });

  const redirect = (res: ServerResponse, location: string, cookies: string[] = []) => {
    res.writeHead(303, { Location: location, 'Set-Cookie': cookies });
    res.end();
  };

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const serveStatic = (res: ServerResponse, rel: string): boolean => {
    const full = normalize(join(publicDir, rel));
    if (!full.startsWith(publicDir + sep)) return false;
    let size: number;
    try {
      const st = statSync(full);
      if (!st.isFile()) return false;
      size = st.size;
    } catch {
      return false;
    }
    const hashed = /\.[A-Z0-9]{8}\.(js|css)$/.test(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    createReadStream(full).pipe(res);
    return true;
  };

  /** Reject cross-site form posts: the Origin header must match our host. */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const readForm = (req: IncomingMessage): Promise<URLSearchParams> =>
    new Promise((ok, fail) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 10_000) {
          req.destroy();
          fail(new Error('body too large'));
        }
      });
      req.on('end', () => ok(new URLSearchParams(body)));
      req.on('error', fail);
    });

  const rateLimited = (ip: string): boolean => {
    const now = Date.now();
    const recent = (loginAttempts.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    recent.push(now);
    loginAttempts.set(ip, recent);
    return recent.length > LOGIN_MAX_ATTEMPTS;
  };

  const startSession = (userId: string): string => {
    const sid = randomId(32);
    db.createSession(sid, userId);
    return cookie(SESSION_COOKIE, sid, { maxAge: SESSION_MAX_AGE, secure: opts.secureCookies });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const viewer = resolveViewer(req, db);
    if (viewer.newAnonId) res.setHeader('Set-Cookie', cookie(ANON_COOKIE, viewer.newAnonId, { maxAge: SESSION_MAX_AGE, secure: opts.secureCookies }));

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path.startsWith('/build/') || path.startsWith('/engine/')) {
        if (!serveStatic(res, path.slice(1))) notFound(res, viewer);
        return;
      }
      if (path === '/healthz') return json(res, 200, { ok: true, games: games.playing, sockets: hub.connections });
      if (path === '/') return page(res, viewer, 200, { title: 'Play', module: 'lobby', body: views.lobbyBody(), data: {} });
      if (path === '/analysis' || /^\/analysis\/[a-zA-Z0-9]{8}$/.test(path)) {
        const id = path.split('/')[2];
        const game = id ? games.load(id) : null;
        if (id && !game) return notFound(res, viewer);
        const fen = url.searchParams.get('fen');
        return page(res, viewer, 200, {
          title: 'Analysis board',
          module: 'analysis',
          body: views.analysisBody(),
          data: { moves: game?.uciMoves ?? [], fen: fen ?? null, gameId: game?.id ?? null },
        });
      }
      if (path === '/tv') {
        const game = games.featured();
        if (!game) return page(res, viewer, 200, { title: 'TV', body: views.messageBody('No live games', 'Nobody is playing right now. Start a game from the lobby!') });
        const data: GamePageData = { game: game.data(hub.onGame(game.id)), player: null, orientation: 'white', tv: true };
        return page(res, viewer, 200, { title: 'TV', module: 'round', body: views.roundBody(), data });
      }
      if (path === '/login' || path === '/signup') {
        if (viewer.user) return redirect(res, '/');
        return page(res, viewer, 200, { title: path === '/login' ? 'Log in' : 'Sign up', body: views.authForm(path.slice(1) as 'login' | 'signup', null) });
      }
      let m = /^\/@\/([a-zA-Z0-9_-]{3,20})$/.exec(path);
      if (m) {
        const user = db.userByName(m[1]!);
        if (!user) return notFound(res, viewer);
        return page(res, viewer, 200, { title: user.username, body: views.profileBody(user, db.gamesOf(user.id, 30), db.countGames(user.id)) });
      }
      m = /^\/api\/game\/([a-zA-Z0-9]{8})$/.exec(path);
      if (m) {
        const game = games.load(m[1]!);
        if (!game) return json(res, 404, { error: 'not found' });
        return json(res, 200, { game: game.data(hub.onGame(game.id)), player: game.colorOf(viewer.id) });
      }
      m = /^\/game\/export\/([a-zA-Z0-9]{8})\.pgn$/.exec(path);
      if (m) {
        const game = games.load(m[1]!);
        if (!game) return notFound(res, viewer);
        res.writeHead(200, { 'Content-Type': 'application/x-chess-pgn', 'Content-Disposition': `attachment; filename="${game.id}.pgn"` });
        res.end(game.pgn());
        return;
      }
      m = /^\/([a-zA-Z0-9]{8})$/.exec(path);
      if (m) {
        const game = games.load(m[1]!);
        if (!game) return notFound(res, viewer);
        const player = game.colorOf(viewer.id);
        const data: GamePageData = { game: game.data(hub.onGame(game.id)), player, orientation: player ?? 'white' };
        const title = `${game.players.white.name ?? 'Anonymous'} vs ${game.players.black.name ?? 'Anonymous'}`;
        return page(res, viewer, 200, { title, module: 'round', body: views.roundBody(), data });
      }
      return notFound(res, viewer);
    }

    if (req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request' });
      if (path === '/logout') {
        const sid = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (sid) db.deleteSession(decodeURIComponent(sid));
        return redirect(res, '/', [cookie(SESSION_COOKIE, '', { maxAge: 0, secure: opts.secureCookies })]);
      }
      if (path === '/login' || path === '/signup') {
        const form = await readForm(req);
        const username = (form.get('username') ?? '').trim();
        const password = form.get('password') ?? '';
        const kind = path.slice(1) as 'login' | 'signup';
        const fail = (msg: string, status = 400) => page(res, viewer, status, { title: kind, body: views.authForm(kind, msg, username) });
        if (rateLimited(req.socket.remoteAddress ?? '')) return fail('Too many attempts. Try again in a few minutes.', 429);
        if (kind === 'signup') {
          const invalid = validateSignup(username, password);
          if (invalid) return fail(invalid);
          if (db.userByName(username)) return fail('That username is taken.');
          const id = randomId(12);
          db.createUser({ id, username, passwordHash: await hashPassword(password), createdAt: Date.now(), ratings: {} });
          return redirect(res, '/', [startSession(id)]);
        }
        const user = db.userByName(username);
        if (!user || !(await verifyPassword(password, user.passwordHash))) return fail('Wrong username or password.', 401);
        return redirect(res, '/', [startSession(user.id)]);
      }
    }
    res.writeHead(405).end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    hub.handleUpgrade(req, socket, head, resolveViewer(req, db));
  });

  return {
    server,
    db,
    games,
    lobby,
    hub,
    close: () =>
      new Promise<void>((ok) => {
        games.stop();
        hub.close();
        server.closeAllConnections();
        server.close(() => {
          db.close();
          ok();
        });
      }),
  };
}
