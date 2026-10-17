import { randomId } from './auth.ts';
import { ratingOf } from './db.ts';
import type { Game } from './game.ts';
import type { GameService, Participant } from './games.ts';
import { POOLS, speedOf, type Seek, type TimeControl } from '../shared/protocol.ts';

interface StoredSeek extends Seek {
  owner: Participant;
}

export type SeekResult = { ok: true; seek: Seek } | { ok: false; error: string };
export type JoinResult = { ok: true; game: Game; ownerIds: [string, string] } | { ok: false; error: string };

/**
 * Open seeks ("hooks") in the lobby. A seek is removed when it is joined,
 * cancelled, or its owner leaves the lobby. Each owner has at most one seek.
 */
export class Lobby {
  private readonly seeks = new Map<string, StoredSeek>();
  /** Called whenever the seek list changes. */
  onChange: () => void = () => {};

  constructor(private readonly games: GameService) {}

  /** Open seeks, flagging the ones owned by `viewerId`. */
  list(viewerId?: string): (Seek & { mine: boolean })[] {
    return [...this.seeks.values()].map(({ owner, ...seek }) => ({ ...seek, mine: owner.ownerId === viewerId }));
  }

  add(owner: Participant, clock: TimeControl, rated: boolean): SeekResult {
    if (!isValidClock(clock)) return { ok: false, error: 'invalid time control' };
    if (rated && !owner.user) return { ok: false, error: 'log in to play rated games' };
    this.removeByOwner(owner.ownerId, false);
    const speed = speedOf(clock);
    const seek: StoredSeek = {
      id: randomId(8),
      name: owner.user?.username ?? 'Anonymous',
      rating: owner.user ? Math.round(ratingOf(owner.user, speed).rating) : null,
      rated,
      clock,
      speed,
      owner,
    };
    this.seeks.set(seek.id, seek);
    this.onChange();
    const { owner: _owner, ...pub } = seek;
    return { ok: true, seek: pub };
  }

  join(seekId: string, joiner: Participant): JoinResult {
    const seek = this.seeks.get(seekId);
    if (!seek) return { ok: false, error: 'seek no longer available' };
    if (seek.owner.ownerId === joiner.ownerId) return { ok: false, error: 'cannot join your own seek' };
    if (seek.rated && !joiner.user) return { ok: false, error: 'log in to play rated games' };
    this.seeks.delete(seekId);
    this.removeByOwner(joiner.ownerId, false);
    this.onChange();
    const ownerWhite = Math.random() < 0.5;
    const [white, black] = ownerWhite ? [seek.owner, joiner] : [joiner, seek.owner];
    const game = this.games.create(white, black, seek.clock, seek.rated);
    return { ok: true, game, ownerIds: [seek.owner.ownerId, joiner.ownerId] };
  }

  removeByOwner(ownerId: string, notify = true): void {
    let changed = false;
    for (const [id, s] of this.seeks) {
      if (s.owner.ownerId === ownerId) {
        this.seeks.delete(id);
        changed = true;
      }
    }
    if (changed && notify) this.onChange();
  }
}

export function isValidClock(tc: TimeControl): boolean {
  if (POOLS.some((p) => p.limit === tc.limit && p.increment === tc.increment)) return true;
  return (
    Number.isInteger(tc.limit) &&
    Number.isInteger(tc.increment) &&
    tc.limit >= 30 &&
    tc.limit <= 180 * 60 &&
    tc.increment >= 0 &&
    tc.increment <= 180
  );
}
