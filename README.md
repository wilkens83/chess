# Chess

A real-time chess server in TypeScript, built from the architecture worked out
by reverse-engineering lichess.org with REA
(see [docs/lichess-rebuild-plan.md](docs/lichess-rebuild-plan.md)).

It is an independent implementation. It contains no lichess code or assets.

## Features

- **Lobby.** Quick-pairing pools (1+0 … 30+20), open challenges that update
  live, a featured "live game" mini-board, and online player and game counts.
- **Live games.** The server is authoritative: it validates every move and
  runs every clock. Clocks start after each side's first move and support
  increments. Lag compensation is capped per move and by a refilling
  per-player quota.
- **Game flow.** Abort (before both sides move), resign, draw offers that are
  declined implicitly when you move instead, rematch with colors swapped,
  flag-fall with an insufficient-material draw, and games that nobody starts
  time out.
- **Spectating and TV.** Watch any game, see a spectator count and player
  presence, and use `/tv` to follow the top-rated game in progress.
- **Analysis board.** Legal move input, move-list navigation (arrow keys),
  FEN and PGN import/export, and an optional in-browser Stockfish 19 (WASM)
  with an eval bar and best line.
- **Accounts.** Sign up and log in with scrypt-hashed passwords. Glicko-2
  ratings are kept per speed (bullet, blitz, rapid, classical), and profiles
  show game history. You can play anonymously with no account; rated games
  require one.
- **Hardening.** A strict nonce-based CSP, an Origin check on form posts and
  WebSocket upgrades, login rate limiting, a per-socket message rate limit,
  and a size cap on socket messages.

## Quick start

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
npm run engine   # optional: downloads Stockfish (GPL-3.0) into public/engine for the analysis board
npm start        # builds the client and serves http://127.0.0.1:8080
```

Open two browser windows (or one normal and one private), click the same time
control in each, and play.

| Script | Purpose |
|---|---|
| `npm start` | Build the client, then run the server |
| `npm run dev` | Rebuild the client on change and restart the server on change |
| `npm test` | Unit tests plus HTTP/WebSocket integration tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Bundle the client into `public/build` with content-hashed names |

Environment variables: `PORT` (8080), `HOST` (127.0.0.1), `DB_PATH`
(`data/chess.db`), `PUBLIC_DIR` (`public`), and `SECURE_COOKIES=1` when served
over HTTPS.

## Architecture

```
src/
  shared/protocol.ts   wire types shared by server and client
  server/
    main.ts            entry point
    app.ts             HTTP routes, server-rendered pages, static assets, WS upgrade
    socket.ts          WebSocket hub: lobby, play and watch sockets
    games.ts           live-game service: creation, ticker, persistence, ratings, TV, rematch
    game.ts            one game: rules (chess.js), clock, versioned event log
    clock.ts           server-authoritative clock with lag compensation
    lobby.ts           seeks and pairing
    glicko2.ts         rating system
    db.ts              SQLite storage (users, sessions, games)
    auth.ts, viewer.ts passwords, sessions, anonymous identities
    views.ts           HTML templates
  client/
    socket.ts          resilient socket: ping/lag, ackable sends, versioned replay, reconnect
    board.ts           chessboard UI: click, drag, promotion, highlights
    engine.ts          Stockfish WASM worker over UCI
    pages/             lobby, round (game/TV), analysis
test/                  node:test suites
```

**Pages.** Each page is server-rendered HTML with its state embedded as JSON
(`<script type="application/json" id="page-data">`) and one page module that
boots from it. This is the same pattern observed on lichess.org.

**Socket protocol.** It follows the framing observed on lichess.org. Every
message is JSON `{ t, d, v? }`, except the client ping `"p"` and the
game-socket pong `"0"`. On the lobby socket, the pong is
`{"t":"n","d":players,"r":games}`.

| Socket | Path |
|---|---|
| Lobby | `/lobby/socket/v5` |
| Player | `/play/{gameId}/v6?v={lastVersion}` |
| Spectator | `/watch/{gameId}/{color}/v6?v={lastVersion}` |

- Game events (`move`, `end`, `drawOffer`) carry a version `v`. A client that
  reconnects with `?v=` receives exactly the events it missed. If those can't
  be replayed, it gets `resync` and reloads state from `/api/game/{id}`.
- Moves are sent as `{"t":"move","d":{"u":"e2e4","l":lagMs,"a":ackId}}` and
  resent until the server answers `{"t":"ack","d":ackId}`.

**Storage.** Games are saved to SQLite after every move and when they end.
Clock state is not persisted, so a server restart aborts games in progress.

## Not built yet

These parts of the rebuild plan are still to do:

- Tournaments and Swiss events
- Puzzles and the opening explorer
- Server-side (fishnet-style) analysis
- Chat and moderation
- Variants
- Premoves
- Splitting the WebSocket gateway into its own process behind a message bus
- Anti-cheat
- A public API

See Part 2 of [the plan](docs/lichess-rebuild-plan.md).

## Licences

This project's own code has no licence file yet; add one before publishing.

Dependencies:

- [chess.js](https://github.com/jhlywa/chess.js): BSD-2-Clause
- [ws](https://github.com/websockets/ws): MIT
- [Stockfish](https://github.com/nmrugg/stockfish.js): GPL-3.0. Optional. It is
  downloaded by `npm run engine` and served unmodified, with its licence text,
  as a separate program.
