import { randomId } from './auth.ts';
import { ratingOf, type Db, type StoredGame, type UserRow } from './db.ts';
import { Game, type GamePlayer, type VersionedEvent } from './game.ts';
import { isProvisional, updateRating } from './glicko2.ts';
import { opposite, speedOf, type Color, type TimeControl } from '../shared/protocol.ts';

/** A browser taking part in pairing: its identity, plus its account when logged in. */
export interface Participant {
  ownerId: string;
  user: UserRow | null;
}

type Listener = (e: VersionedEvent) => void;

/** Finished games stay in memory this long so open sockets can still read them. */
const KEEP_FINISHED_MS = 10 * 60_000;
const TICK_MS = 100;

/**
 * Owns every live game: creation, the flag/no-start ticker, persistence,
 * rating updates, event fan-out, TV selection and rematches.
 */
export class GameService {
  private readonly live = new Map<string, Game>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly rematchOffers = new Map<string, Color>();
  private timer: NodeJS.Timeout | null = null;
  private featuredId: string | null = null;
  /** Called with (oldGameId, newGameId) when a rematch is created. */
  onRematch: (from: string, to: string) => void = () => {};
  /** Called when the TV game changes. */
  onFeatured: (game: Game) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    // Games cannot be resumed after a restart because clock state is not persisted.
    for (const g of this.db.recentGames(1000)) {
      if (g.status === 'created' || g.status === 'started') this.db.saveGame({ ...g, status: 'aborted', endedAt: this.now() });
    }
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const now = this.now();
    for (const game of this.live.values()) {
      game.tick();
      if (game.endedAt !== null && now - game.endedAt > KEEP_FINISHED_MS) {
        this.live.delete(game.id);
        this.listeners.delete(game.id);
        this.rematchOffers.delete(game.id);
      }
    }
  }

  create(white: Participant, black: Participant, tc: TimeControl, rated: boolean): Game {
    const isRated = rated && white.user !== null && black.user !== null;
    const speed = speedOf(tc);
    const player = (p: Participant): GamePlayer => {
      const r = p.user ? ratingOf(p.user, speed) : null;
      return {
        userId: p.user?.id ?? null,
        ownerId: p.ownerId,
        name: p.user?.username ?? null,
        rating: r ? Math.round(r.rating) : null,
        provisional: r ? isProvisional(r) : false,
        ratingDiff: null,
      };
    };
    let id = randomId(8);
    while (this.live.has(id) || this.db.game(id)) id = randomId(8);
    const game = new Game({ id, clock: tc, rated: isRated, white: player(white), black: player(black), now: this.now });
    game.onEvent = (e) => {
      if (e.t === 'move') this.persist(game);
      for (const l of this.listeners.get(game.id) ?? []) l(e);
      if (e.t === 'end' && game.id === this.featuredId) this.pickFeatured();
    };
    game.onEnd = (g) => {
      if (g.rated) this.applyRatings(g);
      this.persist(g);
    };
    this.live.set(id, game);
    this.persist(game);
    if (!this.featuredId || !this.live.get(this.featuredId) || this.live.get(this.featuredId)!.finished) this.pickFeatured();
    return game;
  }

  get(id: string): Game | null {
    return this.live.get(id) ?? null;
  }

  /** A live game, or a stored one rebuilt for viewing. */
  load(id: string): Game | null {
    const live = this.live.get(id);
    if (live) return live;
    const s = this.db.game(id);
    if (!s) return null;
    return Game.restore(
      {
        id: s.id,
        clock: s.clock,
        rated: s.rated,
        createdAt: s.createdAt,
        white: { ...s.white, ownerId: s.white.userId ?? '', provisional: false },
        black: { ...s.black, ownerId: s.black.userId ?? '', provisional: false },
      },
      s.moves,
      s.status,
      s.winner,
      s.endedAt,
    );
  }

  subscribe(gameId: string, l: Listener): () => void {
    let set = this.listeners.get(gameId);
    if (!set) this.listeners.set(gameId, (set = new Set()));
    set.add(l);
    return () => set.delete(l);
  }

  get playing(): number {
    let n = 0;
    for (const g of this.live.values()) if (!g.finished) n++;
    return n;
  }

  featured(): Game | null {
    return this.featuredId ? (this.live.get(this.featuredId) ?? null) : null;
  }

  /** TV shows the highest-rated game in progress, falling back to the newest. */
  pickFeatured(): void {
    let best: Game | null = null;
    let bestScore = -Infinity;
    for (const g of this.live.values()) {
      if (g.finished) continue;
      const score = (g.players.white.rating ?? 1000) + (g.players.black.rating ?? 1000) + g.createdAt / 1e12;
      if (score > bestScore) {
        best = g;
        bestScore = score;
      }
    }
    if (best && best.id !== this.featuredId) {
      this.featuredId = best.id;
      this.onFeatured(best);
    }
  }

  /** Player asks for a rematch; when both have asked, the new game is created. */
  rematch(game: Game, color: Color): Game | null {
    if (!game.finished) return null;
    const offer = this.rematchOffers.get(game.id);
    if (offer === color) return null;
    if (offer !== opposite(color)) {
      this.rematchOffers.set(game.id, color);
      return null;
    }
    this.rematchOffers.delete(game.id);
    const participant = (c: Color): Participant => {
      const userId = game.players[c].userId;
      return { ownerId: game.players[c].ownerId, user: userId ? this.db.userById(userId) : null };
    };
    // Colors swap in the rematch.
    const next = this.create(participant('black'), participant('white'), game.tc, game.rated);
    this.onRematch(game.id, next.id);
    return next;
  }

  rematchOffer(gameId: string): Color | null {
    return this.rematchOffers.get(gameId) ?? null;
  }

  private applyRatings(game: Game): void {
    const w = game.players.white;
    const b = game.players.black;
    if (!w.userId || !b.userId || game.status === 'aborted' || game.status === 'noStart') return;
    const speed = speedOf(game.tc);
    const wUser = this.db.userById(w.userId);
    const bUser = this.db.userById(b.userId);
    if (!wUser || !bUser) return;
    const wr = ratingOf(wUser, speed);
    const br = ratingOf(bUser, speed);
    const score = game.winner === 'white' ? 1 : game.winner === 'black' ? 0 : 0.5;
    const wNew = updateRating(wr, br, score);
    const bNew = updateRating(br, wr, 1 - score);
    this.db.setRating(w.userId, speed, wNew);
    this.db.setRating(b.userId, speed, bNew);
    w.ratingDiff = Math.round(wNew.rating) - Math.round(wr.rating);
    b.ratingDiff = Math.round(bNew.rating) - Math.round(br.rating);
  }

  private persist(game: Game): void {
    const p = (c: Color) => ({
      userId: game.players[c].userId,
      name: game.players[c].name,
      rating: game.players[c].rating,
      ratingDiff: game.players[c].ratingDiff,
    });
    const stored: StoredGame = {
      id: game.id,
      rated: game.rated,
      clock: game.tc,
      white: p('white'),
      black: p('black'),
      moves: game.uciMoves,
      status: game.status,
      winner: game.winner,
      createdAt: game.createdAt,
      endedAt: game.endedAt,
    };
    this.db.saveGame(stored);
  }
}
