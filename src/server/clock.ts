import type { ClockState, Color, TimeControl } from '../shared/protocol.ts';
import { opposite } from '../shared/protocol.ts';

/**
 * Server-authoritative chess clock.
 *
 * Time is only ever deducted on the server. A client may report its network
 * lag with each move. The server refunds up to MAX_COMP_MS of it per move,
 * drawn from a per-player quota that refills slowly, so a client lying about
 * lag gains at most a bounded amount of time.
 */
export const MAX_COMP_MS = 1000;
export const QUOTA_START_MS = 2000;
export const QUOTA_GAIN_MS = 100;
export const QUOTA_MAX_MS = 3000;

export class Clock {
  readonly increment: number;
  private remaining: Record<Color, number>;
  private quota: Record<Color, number> = { white: QUOTA_START_MS, black: QUOTA_START_MS };
  /** Color whose time is running, or null while stopped. */
  private running: Color | null = null;
  private turnStartedAt = 0;
  lastCompensation = 0;

  constructor(
    tc: TimeControl,
    private readonly now: () => number = Date.now,
  ) {
    this.remaining = { white: tc.limit * 1000, black: tc.limit * 1000 };
    this.increment = tc.increment * 1000;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  get runningColor(): Color | null {
    return this.running;
  }

  start(color: Color): void {
    this.running = color;
    this.turnStartedAt = this.now();
  }

  stop(): void {
    if (!this.running) return;
    this.remaining[this.running] = this.remainingMs(this.running);
    this.running = null;
  }

  remainingMs(color: Color): number {
    const base = this.remaining[color];
    if (this.running !== color) return base;
    return Math.max(0, base - (this.now() - this.turnStartedAt));
  }

  /** Color whose flag has fallen, if any. */
  flagged(): Color | null {
    return this.running && this.remainingMs(this.running) <= 0 ? this.running : null;
  }

  /**
   * The running player completed a move: deduct their elapsed time (minus lag
   * compensation), add the increment and start the opponent's clock.
   * Returns false when the player had already run out of time.
   */
  press(color: Color, reportedLagMs = 0): boolean {
    if (this.running !== color) throw new Error(`clock is not running for ${color}`);
    const elapsed = this.now() - this.turnStartedAt;
    const comp = Math.min(Math.max(0, reportedLagMs), MAX_COMP_MS, this.quota[color], elapsed);
    this.quota[color] = Math.min(QUOTA_MAX_MS, this.quota[color] - comp + QUOTA_GAIN_MS);
    this.lastCompensation = comp;
    const left = this.remaining[color] - (elapsed - comp);
    if (left <= 0) {
      this.remaining[color] = 0;
      this.running = null;
      return false;
    }
    this.remaining[color] = left + this.increment;
    this.start(opposite(color));
    return true;
  }

  giveTime(color: Color, ms: number): void {
    this.remaining[color] += ms;
  }

  state(): ClockState {
    return {
      white: centis(this.remainingMs('white')),
      black: centis(this.remainingMs('black')),
      lag: Math.round(this.lastCompensation / 10),
      running: this.running !== null,
    };
  }
}

const centis = (ms: number): number => Math.round(ms / 10) / 100;
