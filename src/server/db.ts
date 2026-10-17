import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_RATING, type Rating } from './glicko2.ts';
import type { Color, GameStatus, Speed, TimeControl } from '../shared/protocol.ts';

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  ratings: Partial<Record<Speed, Rating>>;
}

export interface StoredGame {
  id: string;
  rated: boolean;
  clock: TimeControl;
  white: StoredPlayer;
  black: StoredPlayer;
  moves: string[];
  status: GameStatus;
  winner: Color | null;
  createdAt: number;
  endedAt: number | null;
}

export interface StoredPlayer {
  userId: string | null;
  name: string | null;
  rating: number | null;
  ratingDiff: number | null;
}

export class Db {
  private readonly db: DatabaseSync;

  /** `path` is a file path, or ":memory:" for tests. */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ratings TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        rated INTEGER NOT NULL,
        clock_limit INTEGER NOT NULL,
        clock_increment INTEGER NOT NULL,
        white_id TEXT, white_name TEXT, white_rating INTEGER, white_diff INTEGER,
        black_id TEXT, black_name TEXT, black_rating INTEGER, black_diff INTEGER,
        moves TEXT NOT NULL,
        status TEXT NOT NULL,
        winner TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS games_white ON games(white_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS games_black ON games(black_id, created_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  createUser(user: UserRow): void {
    this.db
      .prepare('INSERT INTO users (id, username, username_lower, password_hash, created_at, ratings) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.username, user.username.toLowerCase(), user.passwordHash, user.createdAt, JSON.stringify(user.ratings));
  }

  userById(id: string): UserRow | null {
    return toUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  userByName(username: string): UserRow | null {
    return toUser(this.db.prepare('SELECT * FROM users WHERE username_lower = ?').get(username.toLowerCase()));
  }

  setRating(userId: string, speed: Speed, rating: Rating): void {
    const user = this.userById(userId);
    if (!user) return;
    user.ratings[speed] = rating;
    this.db.prepare('UPDATE users SET ratings = ? WHERE id = ?').run(JSON.stringify(user.ratings), userId);
  }

  createSession(id: string, userId: string): void {
    this.db.prepare('INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)').run(id, userId, Date.now());
  }

  sessionUser(sessionId: string): UserRow | null {
    return toUser(this.db.prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ?').get(sessionId));
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  saveGame(g: StoredGame): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO games (id, rated, clock_limit, clock_increment,
          white_id, white_name, white_rating, white_diff,
          black_id, black_name, black_rating, black_diff,
          moves, status, winner, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id, g.rated ? 1 : 0, g.clock.limit, g.clock.increment,
        g.white.userId, g.white.name, g.white.rating, g.white.ratingDiff,
        g.black.userId, g.black.name, g.black.rating, g.black.ratingDiff,
        g.moves.join(' '), g.status, g.winner, g.createdAt, g.endedAt,
      );
  }

  game(id: string): StoredGame | null {
    return toGame(this.db.prepare('SELECT * FROM games WHERE id = ?').get(id));
  }

  gamesOf(userId: string, limit = 50): StoredGame[] {
    return this.db
      .prepare('SELECT * FROM games WHERE white_id = ? OR black_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, userId, limit)
      .map((r) => toGame(r)!);
  }

  countGames(userId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM games WHERE white_id = ? OR black_id = ?').get(userId, userId) as { n: number };
    return row.n;
  }

  recentGames(limit = 20): StoredGame[] {
    return this.db
      .prepare("SELECT * FROM games WHERE status NOT IN ('aborted', 'noStart') ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((r) => toGame(r)!);
  }
}

type Row = Record<string, unknown> | undefined;

function toUser(r: Row): UserRow | null {
  if (!r) return null;
  return {
    id: r.id as string,
    username: r.username as string,
    passwordHash: r.password_hash as string,
    createdAt: r.created_at as number,
    ratings: JSON.parse(r.ratings as string) as UserRow['ratings'],
  };
}

function toGame(r: Row): StoredGame | null {
  if (!r) return null;
  const player = (c: Color): StoredPlayer => ({
    userId: (r[`${c}_id`] as string | null) ?? null,
    name: (r[`${c}_name`] as string | null) ?? null,
    rating: (r[`${c}_rating`] as number | null) ?? null,
    ratingDiff: (r[`${c}_diff`] as number | null) ?? null,
  });
  return {
    id: r.id as string,
    rated: r.rated === 1,
    clock: { limit: r.clock_limit as number, increment: r.clock_increment as number },
    white: player('white'),
    black: player('black'),
    moves: (r.moves as string) ? (r.moves as string).split(' ') : [],
    status: r.status as GameStatus,
    winner: (r.winner as Color | null) ?? null,
    createdAt: r.created_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}

export const ratingOf = (user: UserRow | null, speed: Speed): Rating => user?.ratings[speed] ?? DEFAULT_RATING;
