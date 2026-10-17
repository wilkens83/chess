# How lichess.org works, and a plan to rebuild it

This document has two parts:

1. **What REA observed.** These are findings from reverse-engineering the live
   site with [REA](https://github.com/morluto/rea) 6.5.0.
2. **A rebuild plan.** It covers architecture, tech choices, and phased
   milestones for a Lichess-style chess server.

Lichess is open source under the AGPL ([lichess-org/lila](https://github.com/lichess-org/lila)
and [lichess-org/lila-ws](https://github.com/lichess-org/lila-ws)). Facts that come
from that public source, and not from the REA captures, are marked *(public source)*.

---

## Part 1 — What REA observed

### Method

| Step | REA command | Input |
|---|---|---|
| Live capture | `capture-browser-scenario` (connected to a headless Chromium over CDP) | `https://lichess.org/`, `/tv`, `/analysis`; 8s each; network, WebSocket, console events, response bodies |
| Script export | `export-web-scripts` | The three captures |
| Static analysis | `analyze-javascript-application` | The 80 JS files the pages loaded (845 KB, 231k AST nodes, 0 parse failures) |

### 1. Hosts and delivery

| Host | Role | Evidence |
|---|---|---|
| `lichess.org` | Server-rendered HTML pages, small JSON/HTTP endpoints (`POST /player-count`), `manifest.json` (PWA) | Document requests on all 3 pages |
| `lichess1.org` | Static CDN: JS, CSS, fonts, sounds, piece/board images | 45–64 script requests per page |
| `image.lichess1.org` | Image proxy/resizer (`/display?...`) for user content such as blog thumbnails | 9 image requests on the home page |
| `socket0`…`socket5.lichess.org` | WebSocket gateway, horizontally sharded | `<body data-socket-domains="socket0…socket5">` |
| `database.lichess.org` | Monthly game-dump downloads | String in the bundles |

**Asset pipeline.** Assets use content-hashed names: `assets/compiled/lib.ISXYHWSF.js`,
`site.F2VU6QJU.js`, `round.6SPGVF4I.js`, `css/round.f9841a9f.css`. This is
esbuild-style code splitting. One `manifest.*.js` maps logical modules to
hashed files, and each page loads a page entry (`lobby`, `round`, `analyse`, …)
plus shared `lib.*` chunks. Translations are separate per-locale modules
(`i18n/site.en-GB.*.js`, `i18n/timeago…`, `i18n/preferences…`). DOM work uses
`cash.min.js`, a tiny jQuery-like library.

### 2. Page boot: server-rendered shell plus JSON plus JS module

Every page is server-rendered HTML, so the first paint needs no JS. The
`<body>` carries all client configuration as `data-*` attributes:

```html
<body data-socket-domains="socket0.lichess.org,…,socket5.lichess.org"
      data-asset-url="https://lichess1.org" data-asset-version="5l0nu6"
      data-nonce="…"  data-theme="system" data-board="brown"
      data-piece-set="cburnett" data-sound-set="standard"
      data-i18n-catalog="https://lichess1.org/assets/compiled/i18n/en-GB.….js">
```

- `data-nonce` shows a strict CSP with nonce-based scripts.
- User preferences such as board, pieces, theme, and sound are rendered into
  the page, so the client never fetches them.
- Page state is embedded as JSON. For example, `/tv` embeds
  `{"data":{"game":{"id":"xzD4afJ8","variant":{…},"speed":"bullet","fen":"…","turns":34,"status":{"id":20,"name":"started"}, …}}}`.
  The page module boots from that JSON, then opens a WebSocket for live updates.

### 3. Real-time protocol (the core of the site)

**Connection.** In `lib.QCC7UHCL.js`, REA flagged the only `WebSocket` request
site in the app.

- The client picks a random domain from `data-socket-domains` and keeps it in
  localStorage key `surl18` for 30 minutes (sticky). If a connection fails, it
  sets `tryOtherUrl` and moves to another domain.
- Endpoint paths are chosen per page:

  | Page | Socket URL |
  |---|---|
  | Lobby / home | `wss://socketN/lobby/socket/v5?sri=…&from=website` |
  | Watching a game (TV) | `wss://socketN/watch/{gameId}/{color}/v6?sri=…&from=website&v=34` |
  | Analysis board | `wss://socketN/analysis/socket/v5?sri=…` |
  | Any other page | `/socket/v5` (opened after 500 ms) |

- `sri` is a random per-tab socket ID. `v` is the last event version the
  client has, so the server can replay any events it missed.

**Framing.** Each message is a JSON object `{"t": type, "d": data, "v"?: version}`.

| Direction | Frame | Meaning |
|---|---|---|
| client → server | `p` | Ping. Sent every 2500 ms, or 3500 ms when idle (`pingDelay`). Round-trip times feed `averageLag`. |
| server → client | `0` | Pong on game sockets. |
| server → client | `{"t":"n","d":48124,"r":21295}` | Pong on the lobby socket, carrying players online (`d`) and games in play (`r`). |
| client → server | `{"t":"startWatching","d":"dz6kXWKm"}` | Subscribe to a game (the lobby's featured game). |
| server → client | `{"t":"fen","d":{"id","lm":"a3a4","fen":"… b","wc":43,"bc":51}}` | Compact move update for thumbnails: last move plus clocks in seconds. |
| server → client | `{"t":"move","v":35,"d":{"uci":"e3f4","san":"Bf4","fen":"…","ply":35,"clock":{"white":38.4,"black":46.71,"lag":5}}}` | Versioned game event. Clocks come from the server and include lag compensation. |
| server → client | `{"t":"crowd","d":{"white":true,"black":true,"watchers":{"nb":89}}}` | Presence of both players plus the spectator count. |
| server → client | `{"t":"tvSelect","d":{"channel":"threeCheck","id":"…","player":{…}}}` | TV channel switched to a new game. |

**Reliability.** The client wraps sends in an *ackable* layer that resends
until the server acknowledges. Sends made while disconnected queue in
`resendWhenOpen` and flush on reconnect. The `v` version lets the server replay
missed events, and the client can reload the page on resume (`reloadOnResume`
for the lobby).

**Client event bus.** REA's semantic graph shows a pub/sub bus that decouples
the socket from UI modules:

- Socket lifecycle: `socket.open`, `socket.close`, `socket.lag`, `socket.online`
- Traffic: `socket.send`, `socket.in.message`, `socket.in.crowd`
- UI and analysis: `analysis.change`, `analysis.server.progress`, `board.change`,
  `ply`, `zen`, `round.suggestion`, `content-loaded`

### 4. Chess and engines run in the browser

- **Board UI.** Chessground appears in 10 of the 80 bundles.
- **Client engines.** Analysis runs in the browser on WebAssembly. Engine
  strings found in the bundles:
  - `Stockfish 19` with a large NNUE (94 MB) or a small one (1 MB)
  - `Stockfish 14 NNUE` (`stockfish-nnue.wasm`)
  - `Fairy Stockfish 14` and `Stockfish 11 Multi-Variant` for variants
  - `Stockfish 11 HCE` / `Stockfish JS` as fallbacks for weak devices
- **Server analysis.** The string `fishnet` and the event
  `analysis.server.progress` show that full-game computer analysis is
  outsourced to a distributed volunteer engine network, with progress streamed
  over the socket.
- **Sounds.** Hashed MP3s (`Move`, `Capture`, `Check`, `Checkmate`,
  `GenericNotify`) are prefetched on game pages.

### 5. HTTP endpoints referenced by the bundles (partial)

Most interaction goes over the socket. Plain HTTP covers forms and secondary
actions. String literals found in the bundles include:

`/setup/hook/`, `/setup/validate-fen`, `/setup/filter`, `/lobby/seeks`,
`/challenge/rematch-of/`, `/round-next/`, `/tournament/`, `/swiss/`, `/study/`,
`/broadcast/`, `/practice`, `/editor`, `/import/master`, `/player/search/`,
`/inbox`, `/timeline`, `/pref/*` (zen, soundSet, is3d, bg, bgImg), `/report/flag`,
`/mod/…`, `/push/subscribe` (web push), `/jslog/` (client error logging),
`/statlog`, `/dasher`, `/embed/`, `/bots`.

### 6. Server side *(public source, not observed by REA)*

- **lila.** Scala 3 on the Play framework. Renders HTML and serves HTTP/JSON.
  Holds game, user, and tournament logic in in-memory actors per active game.
- **lila-ws.** A separate Scala/Akka service that terminates every WebSocket.
  It talks to lila over **Redis pub/sub**, so lila restarts don't drop
  sockets. It sits behind the `socketN` domains.
- **scalachess** holds the rules. **MongoDB** stores data. **Elasticsearch**
  powers search. **fishnet** clients do server analysis. Separate services
  provide the opening explorer and tablebases (lila-openingexplorer,
  lila-tablebase).

---

## Part 2 — Rebuild plan

### Guiding principles

1. **The server is authoritative.** The server validates every move and owns
   every clock. The client only renders and predicts.
2. **Sockets are a separate tier.** Copy the lila / lila-ws split: a stateless
   WS gateway forwards to game logic over a message bus. You can then deploy
   game logic without dropping connections, and scale sockets horizontally.
3. **Pages are HTML first.** Render on the server, embed page JSON, then
   hydrate one page module. This is fast, cache-friendly, and SEO-friendly.
4. **Use versioned events.** Every game event gets a monotonically increasing
   `v`, so reconnects replay what was missed and never need a full reload.
5. **Push compute to the edges.** Run casual analysis in browser WASM, and run
   deep analysis on worker machines.

### Recommended stack

The stack is TypeScript end-to-end, which suits a small team.

| Concern | Choice | Notes |
|---|---|---|
| Rules / move generation | [`chessops`](https://github.com/niklasf/chessops) (TS) on both server and client | It is what lichess's own frontend uses. GPL-3: check licence fit. |
| Board UI | [`chessground`](https://github.com/lichess-org/chessground) | GPL-3. Alternative: write your own, or use `react-chessboard` (MIT). |
| Web app | Node (Fastify) with server-rendered templates, or SvelteKit/Next with SSR | Keep pages light and hydrate per page. |
| WS gateway | Node with `uWebSockets.js` or `ws`, stateless | One process per core, several hosts, `socketN` domains. |
| Game service | Node or Go worker holding live games in memory, sharded by game ID | Owns clocks and move validation. |
| Bus | Redis pub/sub, or NATS | Connects the gateway and the game service. |
| Database | PostgreSQL (users, games, ratings) + Redis (presence, seeks, rate limits) | Store moves compactly, e.g. as a UCI string or packed bytes. |
| Engine (client) | `stockfish.wasm` / `stockfish-web` in a Web Worker | Load NNUE lazily and offer a small net option. |
| Engine (server) | Worker queue running native Stockfish | A fishnet-style pull API. |
| Assets | esbuild with content hashes, served from a CDN on a separate cookieless domain | |
| Search | Postgres full-text first, Elasticsearch/Meilisearch later | |

### Architecture

```
           ┌──────────── CDN (assets.example) ────────────┐
Browser ───┤ HTML + page JSON ← web app (SSR, HTTP API)    │
   │       └───────────────┬───────────────────────────────┘
   │ wss://socketN          │ SQL / Redis
   ▼                        ▼
WS gateway(s) ◄── Redis/NATS pub/sub ──► Game service (in-memory games, clocks)
   │                                         │
   └── presence, lobby, crowd counts         └── Postgres (persist on each move/end)
                                             └── Analysis queue ─► engine workers
```

### Phased milestones

**Phase 0 — Foundations (1–2 weeks)**
- Set up a monorepo: `apps/web`, `apps/ws`, `apps/game`, `packages/protocol`,
  `packages/chess`.
- Put the protocol types in `packages/protocol`: the `{t, d, v}` frames,
  `p`/`0` ping/pong, and `move`, `crowd`, `fen`, and `end` events.
- Wire up CI, linting, Docker Compose (Postgres + Redis), and an esbuild asset
  pipeline with hashing.

**Phase 1 — Play a game (MVP, 3–5 weeks)**
- Add an analysis board page with chessground and chessops for local move
  legality and PGN/FEN import and export.
- Add anonymous play by challenge link. Create a game, then both players
  connect to `/play/{id}/{color}`.
- Make the game service authoritative: validate each move and check for
  checkmate, stalemate, threefold repetition, the 50-move rule, and
  insufficient material.
- Run server clocks with increment and lag compensation. Measure RTT from ping
  timing the way lichess does (`averageLag`), credit a capped amount back, and
  send clocks in every `move` event.
- Handle reconnects: the client sends its last `v`, and the server replays
  later events.
- Add resign, draw offer, abort, and the end-of-game flow.

**Phase 2 — Lobby and accounts (3–4 weeks)**
- Add accounts with signup, login, sessions, and CSRF protection.
- Add a preferences system rendered into `<body data-*>`.
- Build the lobby over the socket: seeks/hooks, quick-pairing pools (1+0, 3+2,
  10+0, …), and live counts in the ping reply (`{"t":"n","d":players,"r":games}`).
- Add Glicko-2 ratings per speed (bullet, blitz, rapid, classical) and a
  game-history page.
- Add spectating and a TV page with `crowd` and `tvSelect`.

**Phase 3 — Analysis and puzzles (3–4 weeks)**
- Run client Stockfish WASM in a Worker with multi-PV, depth display, and lazy
  loading of the NNUE.
- Add server analysis: a job queue and engine workers, with progress over the
  socket (`analysis.server.progress`) and annotated mistakes and blunders.
- Add puzzles: generate them from your own games or import the Lichess puzzle
  database (CC0), with puzzle ratings.
- Add an opening explorer, starting from the Masters / Lichess explorer API
  and building your own later.

**Phase 4 — Competitive and social (4–6 weeks)**
- Add arena and Swiss tournaments with standings pushed over the socket.
- Add chat with moderation, timeouts, and reporting, plus friends, a timeline,
  and an inbox.
- Add variants (Chess960, Crazyhouse, Three-check, …). chessops supports them,
  and Fairy-Stockfish covers the engine side.

**Phase 5 — Scale and hardening (ongoing)**
- Run several WS gateway hosts on sticky `socketN` domains with client failover
  (`tryOtherUrl`).
- Shard the game service by game ID. Deploy with drain-and-handoff, persisting
  game state so no game is lost.
- Add a strict nonce-based CSP, rate limiting, and anti-cheat signals: move-time
  stats and engine-match rates over many games.
- Add client error logging (`/jslog`), metrics, and load tests that simulate
  thousands of concurrent games.
- Add a public API and bot API with NDJSON streams, plus PWA and web push.

### Biggest risks

| Risk | Mitigation |
|---|---|
| Clock fairness under lag | Use server-side clocks, capped lag credit, and per-move RTT tracking. Test on simulated bad networks from day one. |
| Lost games on deploy | Separate the socket tier from game logic, persist after every move, and use event versioning to replay. |
| Cheating | Build anti-cheat statistics early. Consider computer-assisted review queues. |
| Licensing | chessground, chessops, and lila are GPL/AGPL. Reusing their code obliges you to publish your source. Write your own replacements if you need a closed source. |
| Branding | Don't reuse the Lichess name, logo, or domain style. |

### Reproducing the REA analysis

```bash
npm install --global --prefix ~/.local rea-agents
# Start Chromium with CDP (plus --proxy-server if you are behind a proxy)
chromium --headless=new --remote-debugging-port=9333 about:blank &
# scenario.json: {"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9333","target_id":"<id from /json/list>"},
#   "start_url":{"url":"https://lichess.org/tv"},
#   "actions":[{"step_id":"settle","action":"wait_for_timeout","duration_ms":8000}],
#   "capture":{"at_end":["url","accessibility"],"events":["network","websockets","console","page-errors"],"network":{"response_body":true}}}
rea capture-browser-scenario scenario.json --format json > tv.json
rea analyze-javascript-application ./downloaded-scripts --artifact-format directory --format json > app.json
```

**Known gaps in this pass:**

- Only logged-out pages were captured. Playing a game, the account flow,
  tournaments, and studies were not exercised.
- 50 of about 65 script bodies failed to read back from the browser
  (`body-read-failed`). The analysed script set was re-downloaded from the
  exact URLs REA observed.
