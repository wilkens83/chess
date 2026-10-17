import { Chess } from 'chess.js';
import type { Dests, Square } from './board.ts';
import type { Color } from '../shared/protocol.ts';

export const turnColor = (c: Chess): Color => (c.turn() === 'w' ? 'white' : 'black');

export function destsOf(c: Chess): Dests {
  const dests: Dests = new Map();
  for (const m of c.moves({ verbose: true })) {
    const list = dests.get(m.from) ?? [];
    if (!list.includes(m.to)) list.push(m.to);
    dests.set(m.from, list);
  }
  return dests;
}

/** Square of the side-to-move's king when it is in check. */
export function checkSquare(c: Chess): Square | null {
  if (!c.inCheck()) return null;
  const color = c.turn();
  for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

export const uciOf = (m: { from: string; to: string; promotion?: string }): string => m.from + m.to + (m.promotion ?? '');

export function playUci(c: Chess, uci: string): ReturnType<Chess['move']> {
  return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}
