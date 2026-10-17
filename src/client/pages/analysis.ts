import { Chess, type Move } from 'chess.js';
import { Board } from '../board.ts';
import { checkSquare, destsOf, playUci, turnColor } from '../chess.ts';
import { Engine, evalBarShare, formatEval } from '../engine.ts';
import { el } from '../util.ts';
import { INITIAL_FEN, opposite, type Color } from '../../shared/protocol.ts';

interface AnalysisData {
  moves: string[];
  fen: string | null;
  gameId: string | null;
}

const data = JSON.parse(document.getElementById('page-data')?.textContent ?? '{}') as AnalysisData;

let startFen = INITIAL_FEN;
/** Mainline as played; moves after `ply` are kept until a different move is made. */
let line: Move[] = [];
let ply = 0;
let orientation: Color = 'white';
const engine = new Engine();
let engineOn = false;

function load(fen: string, uciMoves: string[]): string | null {
  let c: Chess;
  try {
    c = new Chess(fen);
  } catch (e) {
    return (e as Error).message;
  }
  startFen = c.fen();
  for (const uci of uciMoves) {
    try {
      playUci(c, uci);
    } catch {
      break;
    }
  }
  line = c.history({ verbose: true });
  ply = line.length;
  return null;
}

function position(at = ply): Chess {
  const c = new Chess(startFen);
  for (const m of line.slice(0, at)) c.move(m.san);
  return c;
}

load(data.fen ?? INITIAL_FEN, data.moves);

// ---- DOM -----------------------------------------------------------------

const root = document.getElementById('analysis')!;
const evalBar = el('div.eval-bar', null, el('div.eval-fill'));
const boardWrap = el('div.analysis-board');
const side = el('div.analysis-side');
const enginePanel = el('div.engine');
const moveList = el('div.moves');
const nav = el('div.nav');
const fenInput = el('input.fen', { type: 'text', spellcheck: 'false', 'aria-label': 'FEN' });
const pgnArea = el('textarea.pgn', { rows: 5, spellcheck: 'false', 'aria-label': 'PGN', placeholder: 'Paste a PGN and press Import' });
const message = el('p.error', { hidden: true });
root.append(el('div.analysis-main', null, evalBar, boardWrap), side);
side.append(
  enginePanel,
  moveList,
  nav,
  el('label.field', null, 'FEN', fenInput),
  el('label.field', null, 'PGN', pgnArea),
  el(
    'div.controls',
    null,
    el('button.button', { type: 'button', onclick: importPgn }, 'Import PGN'),
    el('button.button', { type: 'button', onclick: () => navigator.clipboard?.writeText(pgnArea.value) }, 'Copy PGN'),
    el('button.button', { type: 'button', onclick: () => (load(INITIAL_FEN, []), render()) }, 'Reset'),
    data.gameId ? el('a.button', { href: `/${data.gameId}` }, 'Back to game') : null,
  ),
  message,
);

const board = new Board(boardWrap, boardState(), {
  onMove: (from, to, promotion) => {
    const c = position();
    let m: Move;
    try {
      m = c.move({ from, to, promotion });
    } catch {
      render();
      return;
    }
    // Keep the existing continuation when the same move is replayed.
    if (line[ply]?.san === m.san) ply++;
    else {
      line = [...line.slice(0, ply), m];
      ply = line.length;
    }
    render();
  },
});

function boardState() {
  const c = position();
  const last = line[ply - 1];
  return {
    fen: c.fen(),
    orientation,
    lastMove: last ? ([last.from, last.to] as [string, string]) : null,
    check: checkSquare(c),
    movable: c.isGameOver() ? null : turnColor(c),
    dests: destsOf(c),
  };
}

const navBtn = (label: string, title: string, fn: () => void) => el('button.button', { type: 'button', title, onclick: fn }, label);
nav.append(
  navBtn('⏮', 'First move', () => go(0)),
  navBtn('◀', 'Previous move', () => go(ply - 1)),
  navBtn('▶', 'Next move', () => go(ply + 1)),
  navBtn('⏭', 'Last move', () => go(line.length)),
  navBtn('⇅', 'Flip board', () => {
    orientation = opposite(orientation);
    render();
  }),
);

function go(to: number): void {
  ply = Math.max(0, Math.min(line.length, to));
  render();
}

function renderMoves(): void {
  const offset = startFen.split(' ')[1] === 'b' ? 1 : 0;
  const startNumber = Number(startFen.split(' ')[5] ?? 1);
  const rows: HTMLElement[] = [];
  const cells = [...(offset ? [null] : []), ...line.map((m, i) => ({ m, i }))];
  for (let k = 0; k < cells.length; k += 2) {
    const cell = (x: (typeof cells)[number] | undefined) =>
      !x ? el('span.move.empty', null, x === null ? '…' : '') : el('button.move', { type: 'button', class: x.i + 1 === ply ? 'active' : '', onclick: () => go(x.i + 1) }, x.m.san);
    rows.push(el('div.row', null, el('span.index', null, `${startNumber + k / 2}.`), cell(cells[k]), cell(cells[k + 1])));
  }
  moveList.replaceChildren(...rows);
  moveList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function pgnText(): string {
  const c = new Chess(startFen);
  if (startFen !== INITIAL_FEN) {
    c.setHeader('SetUp', '1');
    c.setHeader('FEN', startFen);
  }
  for (const m of line) c.move(m.san);
  return c.pgn();
}

function importPgn(): void {
  const c = new Chess();
  try {
    c.loadPgn(pgnArea.value);
  } catch (e) {
    showMessage(`Invalid PGN: ${(e as Error).message}`);
    return;
  }
  const fen = c.getHeaders().FEN ?? INITIAL_FEN;
  load(fen, c.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')));
  showMessage(null);
  render();
}

function showMessage(text: string | null): void {
  message.hidden = !text;
  message.textContent = text ?? '';
}

fenInput.addEventListener('change', () => {
  const err = load(fenInput.value.trim(), []);
  showMessage(err ? `Invalid FEN: ${err}` : null);
  render();
});

// ---- engine --------------------------------------------------------------

const engineToggle = el('input', { type: 'checkbox', id: 'engine-toggle' });
const engineEval = el('strong.eval', null, '–');
const engineLine = el('div.pv');
const engineMeta = el('span.depth');
enginePanel.append(el('label.toggle', null, engineToggle, ' Stockfish'), engineEval, engineMeta, engineLine);

void Engine.available().then((ok) => {
  if (!ok) {
    engineToggle.disabled = true;
    engineMeta.textContent = 'Engine not installed (run npm run engine)';
  }
});
engineToggle.addEventListener('change', () => {
  engineOn = engineToggle.checked;
  if (!engineOn) {
    engine.stop();
  }
  render();
});

function analyse(): void {
  if (!engineOn) {
    engineEval.textContent = '–';
    engineLine.textContent = '';
    engineMeta.textContent = engineToggle.disabled ? engineMeta.textContent : '';
    evalBar.classList.add('off');
    return;
  }
  evalBar.classList.remove('off');
  const c = position();
  if (c.isGameOver()) {
    engine.stop();
    engineEval.textContent = c.isCheckmate() ? '#' : '½';
    engineLine.textContent = c.isCheckmate() ? 'Checkmate' : 'Draw';
    engineMeta.textContent = '';
    return;
  }
  const fen = c.fen();
  void engine.analyse(fen, (info) => {
    if (position().fen() !== fen) return;
    engineEval.textContent = formatEval(info);
    engineMeta.textContent = `depth ${info.depth}${info.nps ? ` • ${Math.round(info.nps / 1000)} kn/s` : ''}`;
    const pv = new Chess(fen);
    const sans: string[] = [];
    for (const uci of info.pv.slice(0, 10)) {
      try {
        sans.push(playUci(pv, uci).san);
      } catch {
        break;
      }
    }
    engineLine.textContent = sans.join(' ');
    (evalBar.firstElementChild as HTMLElement).style.height = `${(evalBarShare(info) * 100).toFixed(1)}%`;
  });
}

function render(): void {
  board.set(boardState());
  evalBar.classList.toggle('flipped', orientation === 'black');
  renderMoves();
  fenInput.value = position().fen();
  if (document.activeElement !== pgnArea) pgnArea.value = pgnText();
  analyse();
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'ArrowLeft') go(ply - 1);
  else if (e.key === 'ArrowRight') go(ply + 1);
  else if (e.key === 'ArrowUp' || e.key === 'Home') go(0);
  else if (e.key === 'ArrowDown' || e.key === 'End') go(line.length);
  else if (e.key === 'f') {
    orientation = opposite(orientation);
    render();
  } else return;
  e.preventDefault();
});

render();
