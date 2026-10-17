// Glicko-2 rating system (Glickman, http://www.glicko.net/glicko/glicko2.pdf),
// applied per game the way online servers do: each game is its own rating period.

export interface Rating {
  rating: number;
  /** Rating deviation. */
  rd: number;
  volatility: number;
  games: number;
}

export const DEFAULT_RATING: Rating = { rating: 1500, rd: 500, volatility: 0.09, games: 0 };

const SCALE = 173.7178;
const TAU = 0.75;
const MIN_RD = 45;
const MAX_RD = 500;
const EPSILON = 0.000001;

/** Ratings with a deviation above this are shown with a "?" as provisional. */
export const PROVISIONAL_RD = 110;

export const isProvisional = (r: Rating): boolean => r.rd > PROVISIONAL_RD;

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number): number => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * Rating after one game.
 * @param score 1 for a win, 0.5 for a draw, 0 for a loss.
 */
export function updateRating(player: Rating, opponent: Rating, score: number): Rating {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.volatility;
  const muJ = (opponent.rating - 1500) / SCALE;
  const phiJ = opponent.rd / SCALE;

  const gJ = g(phiJ);
  const e = expected(mu, muJ, phiJ);
  const v = 1 / (gJ * gJ * e * (1 - e));
  const delta = v * gJ * (score - e);

  // Volatility update via the Illinois algorithm (step 5 of the paper).
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * (phi * phi + v + ex) ** 2;
    return num / den - (x - a) / (TAU * TAU);
  };
  let lo = a;
  let hi: number;
  if (delta * delta > phi * phi + v) {
    hi = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    hi = a - k * TAU;
  }
  let fLo = f(lo);
  let fHi = f(hi);
  while (Math.abs(hi - lo) > EPSILON) {
    const c = lo + ((lo - hi) * fLo) / (fHi - fLo);
    const fC = f(c);
    if (fC * fHi <= 0) {
      lo = hi;
      fLo = fHi;
    } else {
      fLo /= 2;
    }
    hi = c;
    fHi = fC;
  }
  const newSigma = Math.exp(lo / 2);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gJ * (score - e);

  return {
    rating: Math.round((newMu * SCALE + 1500) * 100) / 100,
    rd: Math.min(MAX_RD, Math.max(MIN_RD, newPhi * SCALE)),
    volatility: newSigma,
    games: player.games + 1,
  };
}
