import { isProvisional } from './glicko2.ts';
import type { StoredGame, UserRow } from './db.ts';
import type { Viewer } from './viewer.ts';
import { SPEEDS, tcLabel, speedOf, type Color } from '../shared/protocol.ts';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Escape JSON for embedding inside a <script type="application/json"> element. */
export const safeJson = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c');

export interface LayoutOpts {
  title: string;
  viewer: Viewer;
  nonce: string;
  /** Page module to boot, as named in the asset manifest (e.g. "round"). */
  module?: string;
  /** JSON handed to the page module. */
  data?: unknown;
  body: string;
  assets: (name: string) => string;
  bodyClass?: string;
}

export function layout(o: LayoutOpts): string {
  const user = o.viewer.user;
  const nav = user
    ? `<a href="/@/${esc(user.username)}" class="user">${esc(user.username)}</a>
       <form method="post" action="/logout" class="inline"><button class="link">Log out</button></form>`
    : `<a href="/login">Log in</a> <a href="/signup" class="button small">Sign up</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} • Chess</title>
<link rel="stylesheet" href="${o.assets('style.css')}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 45 45'%3E%3Ctext y='38' font-size='40'%3E%E2%99%9E%3C/text%3E%3C/svg%3E">
</head>
<body class="${esc(o.bodyClass ?? '')}" data-user="${esc(user?.username ?? '')}" data-socket-url="/socket/v5">
<header class="site-header">
  <a href="/" class="logo">♞ Chess</a>
  <nav><a href="/">Play</a><a href="/tv">Watch</a><a href="/analysis">Analysis</a></nav>
  <div class="account">${nav}</div>
</header>
<main>${o.body}</main>
${o.data !== undefined ? `<script type="application/json" id="page-data" nonce="${o.nonce}">${safeJson(o.data)}</script>` : ''}
${o.module ? `<script type="module" src="${o.assets(`${o.module}.js`)}" nonce="${o.nonce}"></script>` : ''}
</body>
</html>`;
}

export function lobbyBody(): string {
  return `<div class="lobby">
  <section class="pools panel">
    <h2>Quick pairing</h2>
    <div id="pools" class="pool-grid"></div>
    <label class="rated-toggle"><input type="checkbox" id="rated"> Rated</label>
    <p id="lobby-error" class="error" hidden></p>
  </section>
  <section class="seeks panel">
    <h2>Open challenges</h2>
    <table class="seek-table"><thead><tr><th>Player</th><th>Rating</th><th>Time</th><th>Mode</th></tr></thead><tbody id="seeks"></tbody></table>
    <p class="empty" id="seeks-empty">No one is waiting. Pick a time control to create a challenge.</p>
  </section>
  <section class="featured panel">
    <h2><a href="/tv">Live game</a></h2>
    <div id="featured"><p class="empty">No games in progress.</p></div>
  </section>
  <footer class="counters"><span id="nb-players">0</span> players • <span id="nb-games">0</span> games in play</footer>
</div>`;
}

export function roundBody(): string {
  return `<div class="round" id="round"></div>`;
}

export function analysisBody(): string {
  return `<div class="analysis" id="analysis"></div>`;
}

export function messageBody(title: string, text: string): string {
  return `<div class="panel narrow"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to the lobby</a></p></div>`;
}

export function authForm(kind: 'login' | 'signup', error: string | null, username = ''): string {
  const title = kind === 'login' ? 'Log in' : 'Sign up';
  const other = kind === 'login' ? `<a href="/signup">Create an account</a>` : `<a href="/login">Already have an account? Log in</a>`;
  return `<div class="panel narrow auth">
  <h1>${title}</h1>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <form method="post" action="/${kind}">
    <label>Username <input name="username" value="${esc(username)}" autocomplete="username" required maxlength="20" autofocus></label>
    <label>Password <input name="password" type="password" autocomplete="${kind === 'login' ? 'current-password' : 'new-password'}" required minlength="${kind === 'signup' ? 8 : 1}"></label>
    <button type="submit" class="button">${title}</button>
  </form>
  <p>${other}</p>
</div>`;
}

const resultText = (g: StoredGame, perspective: Color | null): string => {
  if (g.status === 'aborted') return 'Aborted';
  if (g.status === 'noStart') return 'Not started';
  if (g.status === 'started' || g.status === 'created') return 'Playing';
  if (!g.winner) return 'Draw';
  if (!perspective) return `${g.winner === 'white' ? 'White' : 'Black'} won`;
  return g.winner === perspective ? 'Win' : 'Loss';
};

export function profileBody(user: UserRow, games: StoredGame[], totalGames: number): string {
  const ratings = SPEEDS.map((s) => {
    const r = user.ratings[s];
    const value = r ? `${Math.round(r.rating)}${isProvisional(r) ? '?' : ''}` : '1500?';
    return `<div class="rating"><span class="speed">${s}</span><strong>${value}</strong><span class="games">${r?.games ?? 0} games</span></div>`;
  }).join('');
  const rows = games
    .map((g) => {
      const color: Color = g.white.userId === user.id ? 'white' : 'black';
      const opp = g[color === 'white' ? 'black' : 'white'];
      const diff = g[color].ratingDiff;
      return `<tr><td><a href="/${g.id}">${new Date(g.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</a></td>
        <td>${color}</td><td>${esc(opp.name ?? 'Anonymous')}${opp.rating ? ` (${opp.rating})` : ''}</td>
        <td>${tcLabel(g.clock)} ${speedOf(g.clock)}${g.rated ? ' rated' : ''}</td>
        <td class="result">${resultText(g, color)}${diff ? ` <span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${diff}</span>` : ''}</td></tr>`;
    })
    .join('');
  return `<div class="panel profile">
  <h1>${esc(user.username)}</h1>
  <p class="muted">Member since ${new Date(user.createdAt).toISOString().slice(0, 10)} • ${totalGames} games</p>
  <div class="ratings">${ratings}</div>
  <h2>Recent games</h2>
  ${rows ? `<table class="games"><thead><tr><th>Date</th><th>Color</th><th>Opponent</th><th>Time</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No games yet.</p>'}
</div>`;
}
