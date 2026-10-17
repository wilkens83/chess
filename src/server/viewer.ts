import type { IncomingMessage } from 'node:http';
import { parseCookies, randomId } from './auth.ts';
import type { Db, UserRow } from './db.ts';

export const SESSION_COOKIE = 'session';
export const ANON_COOKIE = 'anon';

/** Whoever is making a request: a logged-in user, or an anonymous browser. */
export interface Viewer {
  /** User id when logged in, otherwise the anonymous browser id. */
  id: string;
  user: UserRow | null;
  /** Set when a new anonymous id was minted and must be stored in a cookie. */
  newAnonId: string | null;
}

export function resolveViewer(req: IncomingMessage, db: Db): Viewer {
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies[SESSION_COOKIE];
  const user = session ? db.sessionUser(session) : null;
  if (user) return { id: user.id, user, newAnonId: null };
  const anon = cookies[ANON_COOKIE];
  if (anon && /^[a-zA-Z0-9]{16}$/.test(anon)) return { id: `anon:${anon}`, user: null, newAnonId: null };
  const fresh = randomId(16);
  return { id: `anon:${fresh}`, user: null, newAnonId: fresh };
}
