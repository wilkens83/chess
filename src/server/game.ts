import { Chess } from 'chess.js';
import { Clock } from './clock.ts';
import {
  INITIAL_FEN,
  isFinished,
  opposite,
  speedOf,
  type Color,
  type GameData,
  type GameEvent,
  type GameStatus,
  type TimeControl,
} from '../shared/protocol.ts';

export interface GamePlayer {
  /** Account id, or null for anonymous players. */
  userId: string | null;
  /** Browser identity (account id or anonymous cookie id) allowed to play this side. */
  ownerId: string;
  name: string | null;
  rating: number | null;
  provisional: boolean;
  ratingDiff: number | null;
}

export type VersionedEvent = GameEvent & { v: number };

export interface GameInit {
  id: string;
  clock: TimeControl;
  rated: boolean;
  white: GamePlayer;
  black: GamePlayer;
  now?: () => number;
  createdAt?: number;
}

export type MoveResult = { ok: true } | { ok: false; error: string };

/** If no one moves within this time after creation, the game ends as noStart. */
export const NO_START_MS = 60_000;

/**
 * One chess game, with server-side rules, clock and versioned event log.
 * It does no I/O; the game service subscribes via `onEvent` / `onEnd`.
 */
export class Game {
  readonly id: string;
  readonly rated: boolean;
  readonly tc: TimeControl;
  readonly players: Record<Color, GamePlayer>;
  readonly createdAt: number;
  readonly clock: Clock;
  status: GameStatus = 'created';
  winner: Color | null = null;
  drawOffer: Color | null = null;
  endedAt: number | null = null;
  private readonly chess = new Chess();
  private readonly events: VersionedEvent[] = [];
  private readonly now: () => number;
  onEvent: (e: VersionedEvent) => void = () => {};
  onEnd: (g: Game) => void = () => {};

  constructor(init: GameInit) {
    this.id = init.id;
    this.rated = init.rated;
    this.tc = init.clock;
    this.players = { white: init.white, black: init.black };
    this.now = init.now ?? Date.now;
    this.createdAt = init.createdAt ?? this.now();
    this.clock = new Clock(init.clock, this.now);
  }

  get version(): number {
    return this.events.length;
  }

  get ply(): number {
    return this.chess.history().length;
  }

  get turn(): Color {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  get fen(): string {
    return this.chess.fen();
  }

  get finished(): boolean {
    return isFinished(this.status);
  }

  get uciMoves(): string[] {
    return this.chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));
  }

  colorOf(ownerId: string): Color | null {
    if (this.players.white.ownerId === ownerId) return 'white';
    if (this.players.black.ownerId === ownerId) return 'black';
    return null;
  }

  /** Events after version `v`, or null if the client is too far behind to replay. */
  eventsSince(v: number): VersionedEvent[] | null {
    if (v > this.version || v < 0) return null;
    return this.events.slice(v);
  }

  move(color: Color, uci: string, reportedLagMs = 0): MoveResult {
    if (this.finished) return { ok: false, error: 'game is over' };
    if (color !== this.turn) return { ok: false, error: 'not your turn' };
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return { ok: false, error: 'malformed move' };
    if (this.checkFlag()) return { ok: false, error: 'out of time' };

    let san: string;
    try {
      san = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      return { ok: false, error: 'illegal move' };
    }

    // Clocks start once both sides have made their first move.
    if (this.ply === 2) this.clock.start('white');
    else if (this.ply > 2 && !this.clock.press(color, reportedLagMs)) {
      // Flag fell during the move that just arrived: undo it and end on time.
      this.chess.undo();
      this.endOnTime(color);
      return { ok: false, error: 'out of time' };
    }
    if (this.status === 'created') this.status = 'started';
    if (this.drawOffer === opposite(color)) this.drawOffer = null;

    this.emit({
      t: 'move',
      d: {
        uci,
        san,
        fen: this.chess.fen(),
        ply: this.ply,
        clock: this.clock.state(),
        check: this.chess.inCheck(),
      },
    });

    if (this.chess.isCheckmate()) this.end('mate', color);
    else if (this.chess.isStalemate()) this.end('stalemate', null);
    else if (
      this.chess.isInsufficientMaterial() ||
      this.chess.isThreefoldRepetition() ||
      this.chess.isDrawByFiftyMoves()
    )
      this.end('draw', null);
    return { ok: true };
  }

  /** Both players may abort until each side has moved once. */
  canAbort(): boolean {
    return !this.finished && this.ply < 2;
  }

  abort(): boolean {
    if (!this.canAbort()) return false;
    this.end('aborted', null);
    return true;
  }

  resign(color: Color): boolean {
    if (this.finished) return false;
    if (this.canAbort()) return this.abort();
    this.end('resign', opposite(color));
    return true;
  }

  /** Offer or accept a draw. */
  drawYes(color: Color): boolean {
    if (this.finished || this.ply < 2) return false;
    if (this.drawOffer === opposite(color)) {
      this.end('draw', null);
      return true;
    }
    if (this.drawOffer === color) return false;
    this.drawOffer = color;
    this.emit({ t: 'drawOffer', d: { by: color } });
    return true;
  }

  /** Decline the opponent's offer or withdraw your own. */
  drawNo(color: Color): boolean {
    if (this.finished || this.drawOffer === null) return false;
    void color;
    this.drawOffer = null;
    this.emit({ t: 'drawOffer', d: { by: null } });
    return true;
  }

  /**
   * Periodic check run by the game service: flags and games nobody started.
   * Returns true when the game ended.
   */
  tick(): boolean {
    if (this.finished) return false;
    if (this.checkFlag()) return true;
    if (this.ply < 2 && this.now() - this.createdAt > NO_START_MS) {
      this.end('noStart', this.ply === 1 ? 'white' : null);
      return true;
    }
    return false;
  }

  private checkFlag(): boolean {
    const flagged = this.clock.flagged();
    if (!flagged) return false;
    this.endOnTime(flagged);
    return true;
  }

  private endOnTime(flagged: Color): void {
    this.clock.stop();
    const winner = opposite(flagged);
    this.end('outoftime', canMate(this.chess.fen(), winner) ? winner : null);
  }

  private end(status: GameStatus, winner: Color | null): void {
    this.clock.stop();
    this.status = status;
    this.winner = winner;
    this.drawOffer = null;
    this.endedAt = this.now();
    this.onEnd(this);
    const ratingDiff =
      this.players.white.ratingDiff !== null && this.players.black.ratingDiff !== null
        ? { white: this.players.white.ratingDiff, black: this.players.black.ratingDiff }
        : null;
    this.emit({ t: 'end', d: { status, winner, ratingDiff } });
  }

  private emit(e: GameEvent): void {
    const versioned = { ...e, v: this.events.length + 1 } as VersionedEvent;
    this.events.push(versioned);
    this.onEvent(versioned);
  }

  data(onGame?: Record<Color, boolean>): GameData {
    const p = (c: Color) => ({
      name: this.players[c].name,
      rating: this.players[c].rating,
      provisional: this.players[c].provisional,
      ratingDiff: this.players[c].ratingDiff,
      onGame: onGame?.[c] ?? false,
    });
    return {
      id: this.id,
      rated: this.rated,
      speed: speedOf(this.tc),
      clock: this.tc,
      status: this.status,
      winner: this.winner,
      initialFen: INITIAL_FEN,
      fen: this.chess.fen(),
      moves: this.uciMoves.join(' '),
      sans: this.chess.history(),
      turn: this.turn,
      players: { white: p('white'), black: p('black') },
      clockState: this.clock.state(),
      version: this.version,
      drawOffer: this.drawOffer,
      createdAt: this.createdAt,
    };
  }

  /** Rebuild a stored game (finished or not) for viewing and PGN export. */
  static restore(init: GameInit, uciMoves: string[], status: GameStatus, winner: Color | null, endedAt: number | null): Game {
    const game = new Game(init);
    for (const uci of uciMoves) game.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    game.status = status;
    game.winner = winner;
    game.endedAt = endedAt;
    return game;
  }

  pgn(): string {
    const result = this.winner === 'white' ? '1-0' : this.winner === 'black' ? '0-1' : this.finished && this.status !== 'aborted' ? '1/2-1/2' : '*';
    const date = new Date(this.createdAt).toISOString().slice(0, 10).replaceAll('-', '.');
    const headers: [string, string][] = [
      ['Event', `${this.rated ? 'Rated' : 'Casual'} ${speedOf(this.tc)} game`],
      ['Site', `/${this.id}`],
      ['Date', date],
      ['White', this.players.white.name ?? 'Anonymous'],
      ['Black', this.players.black.name ?? 'Anonymous'],
      ['Result', result],
      ['TimeControl', `${this.tc.limit}+${this.tc.increment}`],
      ['Termination', this.status],
    ];
    const sans = this.chess.history();
    const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');
    return headers.map(([k, v]) => `[${k} "${v.replaceAll('"', "'")}"]`).join('\n') + `\n\n${body} ${result}\n`;
  }
}

/** Whether `color` has enough material to ever checkmate (used when the opponent flags). */
export function canMate(fen: string, color: Color): boolean {
  const board = fen.split(' ')[0] ?? '';
  const pieces = [...board].filter((ch) => /[pnbrq]/i.test(ch) && (color === 'white' ? ch === ch.toUpperCase() : ch === ch.toLowerCase()));
  if (pieces.some((p) => /[prq]/i.test(p))) return true;
  return pieces.length >= 2;
}
