// Browser engine: Stockfish compiled to WebAssembly, running in a Web Worker
// and driven over UCI. The lite single-threaded build (~1.9 MB) is installed
// into /engine by `npm run engine`.

export const ENGINE_URL = '/engine/stockfish-19-lite-single.js';

export interface EngineInfo {
  depth: number;
  /** Centipawns from White's point of view, when not a mate score. */
  cp: number | null;
  /** Moves to mate from White's point of view (negative: Black mates). */
  mate: number | null;
  /** Principal variation in UCI. */
  pv: string[];
  nps: number | null;
}

export class Engine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private searching = false;
  private pending: { fen: string; onInfo: (i: EngineInfo) => void } | null = null;
  private current: { fen: string; onInfo: (i: EngineInfo) => void } | null = null;

  static async available(): Promise<boolean> {
    try {
      const res = await fetch(ENGINE_URL, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  private boot(): Promise<void> {
    this.ready ??= new Promise((resolve, reject) => {
      const w = new Worker(ENGINE_URL);
      this.worker = w;
      w.onerror = (e) => reject(new Error(e.message));
      w.onmessage = (e: MessageEvent<string>) => {
        const line = String(e.data);
        if (line === 'uciok') w.postMessage('isready');
        else if (line === 'readyok') resolve();
        else this.line(line);
      };
      w.postMessage('uci');
    });
    return this.ready;
  }

  /** Analyse `fen` until stopped, reporting each completed depth. */
  async analyse(fen: string, onInfo: (i: EngineInfo) => void): Promise<void> {
    await this.boot();
    if (this.searching) {
      this.pending = { fen, onInfo };
      this.worker!.postMessage('stop');
      return;
    }
    this.go({ fen, onInfo });
  }

  stop(): void {
    this.pending = null;
    if (this.searching) this.worker?.postMessage('stop');
  }

  private go(job: { fen: string; onInfo: (i: EngineInfo) => void }): void {
    this.current = job;
    this.searching = true;
    this.worker!.postMessage(`position fen ${job.fen}`);
    this.worker!.postMessage('go depth 22');
  }

  private line(line: string): void {
    if (line.startsWith('bestmove')) {
      this.searching = false;
      const next = this.pending;
      this.pending = null;
      if (next) this.go(next);
      return;
    }
    if (!line.startsWith('info') || !line.includes(' pv ') || !this.current) return;
    const multipv = / multipv (\d+)/.exec(line)?.[1];
    if (multipv && multipv !== '1') return;
    const whiteToMove = this.current.fen.split(' ')[1] === 'w';
    const sign = whiteToMove ? 1 : -1;
    const num = (re: RegExp) => {
      const m = re.exec(line);
      return m ? Number(m[1]) : null;
    };
    const cp = num(/ score cp (-?\d+)/);
    const mate = num(/ score mate (-?\d+)/);
    this.current.onInfo({
      depth: num(/ depth (\d+)/) ?? 0,
      cp: cp === null ? null : cp * sign,
      mate: mate === null ? null : mate * sign,
      pv: line.split(' pv ')[1]!.trim().split(' '),
      nps: num(/ nps (\d+)/),
    });
  }
}

export function formatEval(i: EngineInfo): string {
  if (i.mate !== null) return `#${i.mate}`;
  if (i.cp === null) return '–';
  const pawns = i.cp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

/** Share of the eval bar that is White's, from 0 to 1. */
export function evalBarShare(i: EngineInfo): number {
  if (i.mate !== null) return i.mate > 0 ? 1 : 0;
  const cp = i.cp ?? 0;
  return 1 / (1 + Math.exp(-0.004 * cp));
}
