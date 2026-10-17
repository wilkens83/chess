// Wire protocol shared by the server and the browser client.
//
// Mirrors the framing observed on lichess.org: every message is a JSON object
// `{ t: type, d?: data, v?: version }`, except the bare ping `"p"` sent by the
// client and the bare pong `"0"` sent by the server on game sockets.

export type Color = 'white' | 'black';

export const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');

export interface TimeControl {
  /** Initial time in seconds. */
  limit: number;
  /** Increment per move in seconds. */
  increment: number;
}

export type Speed = 'bullet' | 'blitz' | 'rapid' | 'classical';

export const SPEEDS: readonly Speed[] = ['bullet', 'blitz', 'rapid', 'classical'];

/** Speed category from the estimated game duration (limit + 40 * increment). */
export function speedOf(tc: TimeControl): Speed {
  const estimate = tc.limit + 40 * tc.increment;
  if (estimate < 180) return 'bullet';
  if (estimate < 480) return 'blitz';
  if (estimate < 1500) return 'rapid';
  return 'classical';
}

export const tcLabel = (tc: TimeControl): string => {
  const minutes = tc.limit / 60;
  const shown = Number.isInteger(minutes) ? String(minutes) : minutes === 0.5 ? '½' : minutes.toFixed(1);
  return `${shown}+${tc.increment}`;
};

/** Quick-pairing pools shown in the lobby. */
export const POOLS: readonly TimeControl[] = [
  { limit: 60, increment: 0 },
  { limit: 120, increment: 1 },
  { limit: 180, increment: 0 },
  { limit: 180, increment: 2 },
  { limit: 300, increment: 0 },
  { limit: 300, increment: 3 },
  { limit: 600, increment: 0 },
  { limit: 600, increment: 5 },
  { limit: 900, increment: 10 },
  { limit: 1800, increment: 0 },
  { limit: 1800, increment: 20 },
];

export type GameStatus =
  | 'created'
  | 'started'
  | 'aborted'
  | 'mate'
  | 'resign'
  | 'stalemate'
  | 'timeout'
  | 'draw'
  | 'outoftime'
  | 'noStart';

export const isFinished = (s: GameStatus): boolean => s !== 'created' && s !== 'started';

export interface PlayerInfo {
  /** Account username, or null for anonymous players. */
  name: string | null;
  rating: number | null;
  ratingDiff?: number | null;
  provisional?: boolean;
  /** Whether the player currently has a socket open on the game. */
  onGame?: boolean;
}

export interface ClockState {
  /** Remaining seconds, with two decimals. */
  white: number;
  black: number;
  /** Server lag compensation applied to the last move, in centiseconds. */
  lag?: number;
  running: boolean;
}

export interface MoveEvent {
  uci: string;
  san: string;
  fen: string;
  ply: number;
  clock?: ClockState;
  check?: boolean;
}

export interface EndEvent {
  status: GameStatus;
  winner: Color | null;
  ratingDiff?: { white: number; black: number } | null;
}

export interface CrowdEvent {
  white: boolean;
  black: boolean;
  watchers: { nb: number; names?: string[] };
}

/** Full game snapshot embedded in the game page and sent on resync. */
export interface GameData {
  id: string;
  rated: boolean;
  speed: Speed;
  clock: TimeControl;
  status: GameStatus;
  winner: Color | null;
  initialFen: string;
  fen: string;
  /** UCI moves separated by spaces. */
  moves: string;
  sans: string[];
  turn: Color;
  players: Record<Color, PlayerInfo>;
  clockState: ClockState | null;
  /** Latest event version; the client reconnects with `?v=` set to this. */
  version: number;
  drawOffer: Color | null;
  createdAt: number;
}

/** What the page tells the client about the viewer's relation to the game. */
export interface GamePageData {
  game: GameData;
  /** Color the viewer plays, or null when spectating. */
  player: Color | null;
  orientation: Color;
  tv?: boolean;
}

/** Versioned events a game broadcasts. */
export type GameEvent =
  | { t: 'move'; d: MoveEvent }
  | { t: 'end'; d: EndEvent }
  | { t: 'drawOffer'; d: { by: Color | null } }
  | { t: 'clockStart'; d: ClockState }
  | { t: 'reload'; d: null };

export interface Seek {
  id: string;
  /** Display name of the creator, or "Anonymous". */
  name: string;
  rating: number | null;
  rated: boolean;
  clock: TimeControl;
  speed: Speed;
}

export interface LobbyCounts {
  /** Players connected. */
  d: number;
  /** Games in progress. */
  r: number;
}

/** Client → server messages after JSON parsing. */
export type ClientMessage =
  | { t: 'move'; d: { u: string; l?: number; a?: number } }
  | { t: 'resign' }
  | { t: 'abort' }
  | { t: 'draw-yes' }
  | { t: 'draw-no' }
  | { t: 'rematch' }
  | { t: 'seek'; d: { limit: number; increment: number; rated: boolean } }
  | { t: 'cancelSeek' }
  | { t: 'joinSeek'; d: string }
  | { t: 'startWatching'; d: string }
  | { t: 'ack'; d: number };

export const PING = 'p';
export const PONG = '0';

/** Starting position in FEN. */
export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
