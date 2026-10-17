// Interactive chessboard: click-to-move, drag-and-drop, promotion picker,
// last-move and check highlights. Pieces are Unicode glyphs styled with CSS,
// so no image assets are needed.

import type { Color } from '../shared/protocol.ts';

export type Square = string; // "e4"
export type Dests = Map<Square, Square[]>;

export interface BoardState {
  fen: string;
  orientation: Color;
  lastMove?: [Square, Square] | null;
  /** Square of the king in check, if any. */
  check?: Square | null;
  /** Side allowed to move pieces, or null for a read-only board. */
  movable: Color | null;
  dests: Dests;
}

export interface BoardOptions {
  onMove?: (from: Square, to: Square, promotion?: string) => void;
  coordinates?: boolean;
}

const GLYPHS: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';

interface Piece {
  role: string; // k q r b n p
  color: Color;
}

export function parseBoard(fen: string): Map<Square, Piece> {
  const out = new Map<Square, Piece>();
  const rows = (fen.split(' ')[0] ?? '').split('/');
  rows.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        out.set(`${FILES[file]}${8 - i}`, { role: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'white' : 'black' });
        file++;
      }
    }
  });
  return out;
}

export class Board {
  readonly root: HTMLElement;
  private readonly squares = new Map<Square, HTMLElement>();
  private state: BoardState;
  private selected: Square | null = null;
  private drag: { from: Square; ghost: HTMLElement; startX: number; startY: number; moved: boolean } | null = null;
  private promotion: HTMLElement | null = null;

  constructor(
    container: HTMLElement,
    initial: BoardState,
    private readonly opts: BoardOptions = {},
  ) {
    this.state = initial;
    this.root = document.createElement('div');
    this.root.className = 'board';
    container.append(this.root);
    this.root.addEventListener('pointerdown', (e) => this.pointerDown(e));
    window.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.build();
    this.render();
  }

  set(patch: Partial<BoardState>): void {
    const flipped = patch.orientation && patch.orientation !== this.state.orientation;
    this.state = { ...this.state, ...patch };
    if (patch.fen !== undefined || patch.movable !== undefined) this.selected = null;
    this.closePromotion();
    if (flipped) this.build();
    this.render();
  }

  get orientation(): Color {
    return this.state.orientation;
  }

  private build(): void {
    this.root.replaceChildren();
    this.squares.clear();
    const white = this.state.orientation === 'white';
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const file = white ? f : 7 - f;
        const rank = white ? 8 - r : r + 1;
        const sq = `${FILES[file]}${rank}`;
        const node = document.createElement('div');
        node.className = `sq ${(file + rank) % 2 === 0 ? 'dark' : 'light'}`;
        node.dataset.sq = sq;
        if (this.opts.coordinates !== false) {
          if (r === 7) node.append(coord('file', FILES[file]!));
          if (f === 0) node.append(coord('rank', String(rank)));
        }
        this.squares.set(sq, node);
        this.root.append(node);
      }
    }
  }

  private render(): void {
    const pieces = parseBoard(this.state.fen);
    const dests = this.selected ? (this.state.dests.get(this.selected) ?? []) : [];
    for (const [sq, node] of this.squares) {
      node.querySelector('.piece')?.remove();
      const p = pieces.get(sq);
      if (p) {
        const span = document.createElement('span');
        span.className = `piece ${p.color} ${p.role}`;
        span.textContent = GLYPHS[p.role] ?? '';
        node.append(span);
      }
      const lm = this.state.lastMove;
      node.classList.toggle('last-move', !!lm && (lm[0] === sq || lm[1] === sq));
      node.classList.toggle('check', this.state.check === sq);
      node.classList.toggle('selected', this.selected === sq);
      node.classList.toggle('dest', dests.includes(sq));
      node.classList.toggle('occupied', !!p);
    }
    this.root.classList.toggle('movable', this.state.movable !== null);
  }

  private squareAt(x: number, y: number): Square | null {
    const rect = this.root.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return null;
    const f = Math.floor(((x - rect.left) / rect.width) * 8);
    const r = Math.floor(((y - rect.top) / rect.height) * 8);
    const white = this.state.orientation === 'white';
    const file = white ? f : 7 - f;
    const rank = white ? 8 - r : r + 1;
    return `${FILES[file]}${rank}`;
  }

  private ownPiece(sq: Square): boolean {
    const p = parseBoard(this.state.fen).get(sq);
    return !!p && p.color === this.state.movable && this.state.dests.has(sq);
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.promotion) return;
    const sq = this.squareAt(e.clientX, e.clientY);
    if (!sq || this.state.movable === null) return;
    if (this.selected && this.selected !== sq && (this.state.dests.get(this.selected) ?? []).includes(sq)) {
      this.tryMove(this.selected, sq);
      return;
    }
    if (!this.ownPiece(sq)) {
      this.selected = null;
      this.render();
      return;
    }
    e.preventDefault();
    this.selected = sq;
    this.render();
    const piece = this.squares.get(sq)?.querySelector('.piece');
    if (!(piece instanceof HTMLElement)) return;
    const ghost = piece.cloneNode(true) as HTMLElement;
    ghost.classList.add('ghost');
    const size = this.root.getBoundingClientRect().width / 8;
    ghost.style.width = ghost.style.height = `${size}px`;
    ghost.style.fontSize = getComputedStyle(piece).fontSize;
    ghost.style.left = `${e.clientX - size / 2}px`;
    ghost.style.top = `${e.clientY - size / 2}px`;
    ghost.hidden = true;
    document.body.append(ghost);
    this.drag = { from: sq, ghost, startX: e.clientX, startY: e.clientY, moved: false };
  }

  private pointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    if (!d.moved) {
      d.moved = true;
      d.ghost.hidden = false;
      this.squares.get(d.from)?.classList.add('dragging');
    }
    const size = parseFloat(d.ghost.style.width);
    d.ghost.style.left = `${e.clientX - size / 2}px`;
    d.ghost.style.top = `${e.clientY - size / 2}px`;
  }

  private pointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.ghost.remove();
    this.squares.get(d.from)?.classList.remove('dragging');
    if (!d.moved) return; // a click: keep the selection
    const to = this.squareAt(e.clientX, e.clientY);
    if (to && to !== d.from && (this.state.dests.get(d.from) ?? []).includes(to)) this.tryMove(d.from, to);
    else {
      this.selected = null;
      this.render();
    }
  }

  private tryMove(from: Square, to: Square): void {
    const piece = parseBoard(this.state.fen).get(from);
    const lastRank = to[1] === '8' || to[1] === '1';
    if (piece?.role === 'p' && lastRank) {
      this.askPromotion(from, to, piece.color);
      return;
    }
    this.finishMove(from, to);
  }

  private finishMove(from: Square, to: Square, promotion?: string): void {
    this.selected = null;
    // Lock the board until the caller sets the resulting position.
    this.state = { ...this.state, lastMove: [from, to], dests: new Map(), movable: null, check: null };
    this.render();
    this.opts.onMove?.(from, to, promotion);
  }

  private askPromotion(from: Square, to: Square, color: Color): void {
    const box = document.createElement('div');
    box.className = 'promotion';
    for (const role of ['q', 'n', 'r', 'b']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `piece ${color} ${role}`;
      b.textContent = GLYPHS[role] ?? '';
      b.title = { q: 'Queen', n: 'Knight', r: 'Rook', b: 'Bishop' }[role] ?? role;
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.closePromotion();
        this.finishMove(from, to, role);
      });
      box.append(b);
    }
    box.addEventListener('pointerdown', (e) => {
      if (e.target === box) {
        e.stopPropagation();
        this.closePromotion();
        this.selected = null;
        this.render();
      }
    });
    this.promotion = box;
    this.root.append(box);
  }

  private closePromotion(): void {
    this.promotion?.remove();
    this.promotion = null;
  }
}

function coord(kind: 'file' | 'rank', text: string): HTMLElement {
  const c = document.createElement('span');
  c.className = `coord ${kind}`;
  c.textContent = text;
  return c;
}
