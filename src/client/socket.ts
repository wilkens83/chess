// Resilient WebSocket client, modelled on the behaviour observed in lichess.org's
// client: a per-tab socket id (sri), "p" pings every 2.5s with lag averaging,
// ackable sends that are resent until acknowledged, a queue for messages sent
// while disconnected, and event versions so reconnects replay missed events.

export interface SocketHandlers {
  /** Any non-pong message. `v` is set for versioned game events. */
  message: (t: string, d: unknown, v?: number) => void;
  /** The server could not replay missed events; reload state over HTTP. */
  resync?: () => void;
  /** Lobby pong carrying online counters. */
  counts?: (players: number, games: number) => void;
  status?: (online: boolean) => void;
}

const PING_DELAY_MS = 2500;
const PONG_TIMEOUT_MS = 9000;
const ACK_RESEND_MS = 1500;

const sri = Math.random().toString(36).slice(2, 14);

export class StrongSocket {
  private ws: WebSocket | null = null;
  private pingTimer: number | undefined;
  private pongTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private lastPingAt = 0;
  private attempts = 0;
  private closedByUs = false;
  private queue: string[] = [];
  private ackId = 0;
  private pendingAcks = new Map<number, { msg: string; sentAt: number }>();
  private ackTimer: number | undefined;
  /** Exponential moving average of ping round-trip time, in milliseconds. */
  averageLag = 0;

  constructor(
    private readonly path: string,
    /** Last event version seen, or null for sockets without versioned events. */
    public version: number | null,
    private readonly handlers: SocketHandlers,
  ) {
    this.connect();
    window.addEventListener('online', () => this.reconnectSoon(0));
    this.ackTimer = window.setInterval(() => this.resendAcks(), ACK_RESEND_MS);
  }

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ sri });
    if (this.version !== null) params.set('v', String(this.version));
    return `${proto}//${location.host}${this.path}?${params}`;
  }

  private connect(): void {
    clearTimeout(this.reconnectTimer);
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.status?.(true);
      this.pingNow();
      for (const m of this.queue) ws.send(m);
      this.queue = [];
      this.resendAcks(true);
    };
    ws.onmessage = (e) => this.receive(String(e.data));
    ws.onclose = () => {
      clearTimeout(this.pingTimer);
      clearTimeout(this.pongTimer);
      this.handlers.status?.(false);
      if (!this.closedByUs) this.reconnectSoon();
    };
  }

  private reconnectSoon(delay = Math.min(500 * 2 ** this.attempts++, 8000)): void {
    if (this.closedByUs) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
      this.connect();
    }, delay);
  }

  private pingNow(): void {
    clearTimeout(this.pingTimer);
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastPingAt = performance.now();
    this.ws.send('p');
    clearTimeout(this.pongTimer);
    // No pong in time: the connection is dead even if the browser hasn't noticed.
    this.pongTimer = window.setTimeout(() => this.reconnectSoon(0), PONG_TIMEOUT_MS);
  }

  private pong(): void {
    clearTimeout(this.pongTimer);
    const lag = performance.now() - this.lastPingAt;
    this.averageLag = this.averageLag === 0 ? lag : this.averageLag * 0.8 + lag * 0.2;
    this.pingTimer = window.setTimeout(() => this.pingNow(), PING_DELAY_MS);
  }

  private receive(raw: string): void {
    if (raw === '0') return this.pong();
    let msg: { t: string; d?: unknown; v?: number; r?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'n') {
      this.pong();
      this.handlers.counts?.(msg.d as number, msg.r ?? 0);
      return;
    }
    if (msg.t === 'ack') {
      this.pendingAcks.delete(msg.d as number);
      return;
    }
    if (msg.t === 'resync') {
      this.handlers.resync?.();
      return;
    }
    if (typeof msg.v === 'number' && this.version !== null) {
      if (msg.v <= this.version) return; // already seen
      if (msg.v > this.version + 1) {
        this.handlers.resync?.();
        return;
      }
      this.version = msg.v;
    }
    this.handlers.message(msg.t, msg.d, msg.v);
  }

  send(t: string, d?: unknown, opts: { ackable?: boolean } = {}): void {
    let payload = d;
    let id: number | null = null;
    if (opts.ackable) {
      id = ++this.ackId;
      payload = { ...(d as object), a: id };
    }
    const msg = JSON.stringify(payload === undefined ? { t } : { t, d: payload });
    if (id !== null) this.pendingAcks.set(id, { msg, sentAt: performance.now() });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
    else if (id === null) this.queue.push(msg);
  }

  private resendAcks(all = false): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    for (const p of this.pendingAcks.values()) {
      if (all || now - p.sentAt > ACK_RESEND_MS) {
        p.sentAt = now;
        this.ws.send(p.msg);
      }
    }
  }

  /** Drop unacknowledged messages, e.g. after a resync made them obsolete. */
  clearPending(): void {
    this.pendingAcks.clear();
  }

  destroy(): void {
    this.closedByUs = true;
    clearTimeout(this.pingTimer);
    clearTimeout(this.pongTimer);
    clearInterval(this.ackTimer);
    this.ws?.close();
  }
}
