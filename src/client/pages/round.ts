import { Chess } from 'chess.js';
import { Board } from '../board.ts';
import { checkSquare, destsOf, playUci, turnColor } from '../chess.ts';
import { StrongSocket } from '../socket.ts';
import { compact, el, formatClock, pageData, playSound, playerName } from '../util.ts';
import {
  isFinished,
  opposite,
  tcLabel,
  type ClockState,
  type Color,
  type CrowdEvent,
  type EndEvent,
  type GameData,
  type GamePageData,
  type MoveEvent,
} from '../../shared/protocol.ts';

const page = pageData<GamePageData>();
let game: GameData = page.game;
const player: Color | null = page.player;
let orientation: Color = page.orientation;
let chess = new Chess();
/** Ply being viewed when browsing history, or null to follow the game. */
let viewPly: number | null = null;
let clock = { white: 0, black: 0, running: null as Color | null, at: 0 };
let crowd: CrowdEvent = { white: game.players.white.onGame ?? false, black: game.players.black.onGame ?? false, watchers: { nb: 0 } };
let rematchBy: Color | null = null;
let online = true;

function loadGame(g: GameData): void {
  game = g;
  chess = new Chess(g.initialFen);
  for (const uci of g.moves ? g.moves.split(' ') : []) playUci(chess, uci);
  setClock(g.clockState);
}

function setClock(c: ClockState | null | undefined): void {
  if (!c) return;
  clock = { white: c.white, black: c.black, running: c.running && !isFinished(game.status) ? turnColor(chess) : null, at: performance.now() };
}

const remaining = (c: Color): number => clock[c] - (clock.running === c ? (performance.now() - clock.at) / 1000 : 0);

loadGame(game);

// ---- DOM -----------------------------------------------------------------

const root = document.getElementById('round')!;
const boardWrap = el('div.round-board');
const side = el('div.round-side');
const playerTop = el('div.player.top');
const playerBottom = el('div.player.bottom');
const clockTop = el('div.clock.top');
const clockBottom = el('div.clock.bottom');
const moveList = el('div.moves');
const controls = el('div.controls');
const status = el('div.status');
const meta = el('div.game-meta');
const crowdLine = el('div.crowd');
side.append(meta, clockTop, playerTop, moveList, status, controls, playerBottom, clockBottom, crowdLine);
root.append(boardWrap, side);

const board = new Board(boardWrap, boardState(), {
  onMove: (from, to, promotion) => {
    const uci = from + to + (promotion ?? '');
    let move;
    try {
      move = playUci(chess, uci);
    } catch {
      render();
      return;
    }
    // Optimistically switch clocks; the server's move event corrects them.
    if (clock.running === player && player) {
      clock[player] = remaining(player) + game.clock.increment;
      clock.running = opposite(player);
      clock.at = performance.now();
    }
    socket.send('move', { u: uci, l: Math.round(socket.averageLag / 2) }, { ackable: true });
    playSound(move.captured ? 'capture' : 'move');
    render();
  },
});

function boardState() {
  const live = viewPly === null;
  const view = live ? chess : positionAt(viewPly!);
  const history = view.history({ verbose: true });
  const last = history.at(-1);
  const canMove = live && player !== null && !isFinished(game.status) && turnColor(chess) === player;
  return {
    fen: view.fen(),
    orientation,
    lastMove: last ? ([last.from, last.to] as [string, string]) : null,
    check: checkSquare(view),
    movable: canMove ? player : null,
    dests: canMove ? destsOf(chess) : new Map(),
  };
}

function positionAt(ply: number): Chess {
  const c = new Chess(game.initialFen);
  for (const m of chess.history({ verbose: true }).slice(0, ply)) c.move(m.san);
  return c;
}

// ---- rendering -----------------------------------------------------------

function statusText(): string {
  const w = game.winner;
  const winner = w ? `${w === 'white' ? 'White' : 'Black'} is victorious` : '';
  switch (game.status) {
    case 'created':
    case 'started': {
      const turn = turnColor(chess);
      if (player) return turn === player ? 'Your turn' : "Waiting for opponent";
      return `${turn === 'white' ? 'White' : 'Black'} to play`;
    }
    case 'mate':
      return `Checkmate • ${winner}`;
    case 'resign':
      return `${w === 'white' ? 'Black' : 'White'} resigned • ${winner}`;
    case 'outoftime':
      return w ? `${w === 'white' ? 'Black' : 'White'} ran out of time • ${winner}` : 'Time out • Draw (insufficient material)';
    case 'stalemate':
      return 'Stalemate • Draw';
    case 'draw':
      return 'Draw';
    case 'aborted':
      return 'Game aborted';
    case 'noStart':
      return 'Game was not started';
    case 'timeout':
      return `${winner}`;
  }
}

function renderPlayer(node: HTMLElement, color: Color): void {
  const p = game.players[color];
  const diff = p.ratingDiff;
  node.replaceChildren(
    ...compact([
    el('span.dot', { class: crowd[color] ? 'on' : 'off', title: crowd[color] ? 'Online' : 'Offline' }),
    el('span.name', null, p.name ? el('a', { href: `/@/${p.name}` }, playerName(p)) : playerName(p)),
    diff ? el('span.diff', { class: diff > 0 ? 'up' : 'down' }, `${diff > 0 ? '+' : ''}${diff}`) : null,
    color === player ? el('span.you', null, 'you') : null,
    ]),
  );
}

function renderClocks(): void {
  for (const [node, color] of [
    [clockTop, opposite(orientation)],
    [clockBottom, orientation],
  ] as const) {
    const secs = remaining(color);
    node.textContent = formatClock(secs);
    node.classList.toggle('running', clock.running === color);
    node.classList.toggle('low', secs < 10 && clock.running === color);
  }
}

function renderMoves(): void {
  const sans = chess.history();
  const current = viewPly ?? sans.length;
  const rows: HTMLElement[] = [];
  for (let i = 0; i < sans.length; i += 2) {
    const cell = (ply: number) =>
      sans[ply - 1] === undefined
        ? el('span.move.empty')
        : el('button.move', { type: 'button', class: ply === current ? 'active' : '', onclick: () => view(ply) }, sans[ply - 1]!);
    rows.push(el('div.row', null, el('span.index', null, `${i / 2 + 1}.`), cell(i + 1), cell(i + 2)));
  }
  moveList.replaceChildren(...rows);
  moveList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function renderControls(): void {
  const buttons: HTMLElement[] = [];
  const finished = isFinished(game.status);
  if (player && !finished) {
    if (chess.history().length < 2) buttons.push(btn('Abort', () => socket.send('abort')));
    else {
      buttons.push(btn('Resign', () => confirm('Resign this game?') && socket.send('resign')));
      if (game.drawOffer === opposite(player)) {
        buttons.push(btn('Accept draw', () => socket.send('draw-yes'), 'primary'), btn('Decline', () => socket.send('draw-no')));
      } else if (game.drawOffer === player) {
        buttons.push(btn('Cancel draw offer', () => socket.send('draw-no')));
      } else buttons.push(btn('Offer draw', () => socket.send('draw-yes')));
    }
  }
  if (player && finished && game.status !== 'aborted' && game.status !== 'noStart') {
    const label = rematchBy === player ? 'Rematch offered…' : rematchBy ? 'Accept rematch' : 'Rematch';
    const b = btn(label, () => socket.send('rematch'), rematchBy && rematchBy !== player ? 'primary' : undefined);
    if (rematchBy === player) b.disabled = true;
    buttons.push(b);
  }
  if (finished) buttons.push(el('a.button', { href: '/' }, 'New game'));
  buttons.push(
    btn('Flip', () => {
      orientation = opposite(orientation);
      render();
    }),
    el('a.button', { href: `/analysis/${game.id}` }, 'Analyse'),
    el('a.button', { href: `/game/export/${game.id}.pgn` }, 'PGN'),
  );
  controls.replaceChildren(...buttons);
}

function btn(label: string, onclick: () => unknown, kind?: string): HTMLButtonElement {
  return el('button.button', { type: 'button', class: kind ?? '', onclick }, label);
}

function render(): void {
  board.set(boardState());
  renderPlayer(playerTop, opposite(orientation));
  renderPlayer(playerBottom, orientation);
  renderClocks();
  renderMoves();
  renderControls();
  status.textContent = statusText();
  status.classList.toggle('finished', isFinished(game.status));
  meta.replaceChildren(
    ...compact([
    el('span', null, `${tcLabel(game.clock)} • ${game.rated ? 'Rated' : 'Casual'} • ${game.speed}`),
    page.tv ? el('span.badge', null, 'TV') : null,
    online ? null : el('span.badge.offline', null, 'Reconnecting…'),
    ]),
  );
  crowdLine.textContent = crowd.watchers.nb ? `Spectators: ${crowd.watchers.nb}${crowd.watchers.names?.length ? ` (${crowd.watchers.names.join(', ')})` : ''}` : '';
  const yourTurn = player && !isFinished(game.status) && turnColor(chess) === player;
  document.title = `${yourTurn ? '▶ Your turn • ' : ''}${game.players.white.name ?? 'Anonymous'} vs ${game.players.black.name ?? 'Anonymous'} • Chess`;
}

function view(ply: number | null): void {
  const total = chess.history().length;
  viewPly = ply === null || ply >= total ? null : Math.max(0, ply);
  render();
}

// ---- socket --------------------------------------------------------------

function onMove(d: MoveEvent): void {
  const ply = chess.history().length;
  const last = chess.history({ verbose: true }).at(-1);
  if (d.ply === ply + 1) {
    try {
      const m = playUci(chess, d.uci);
      playSound(m.captured ? 'capture' : 'move');
    } catch {
      return void resync();
    }
  } else if (!(d.ply === ply && last && last.from + last.to + (last.promotion ?? '') === d.uci)) {
    return void resync();
  }
  game.status = 'started';
  game.drawOffer = game.drawOffer && game.drawOffer !== turnColor(chess) ? game.drawOffer : null;
  setClock(d.clock);
  render();
}

function onEnd(d: EndEvent): void {
  game.status = d.status;
  game.winner = d.winner;
  game.drawOffer = null;
  if (d.ratingDiff) {
    game.players.white.ratingDiff = d.ratingDiff.white;
    game.players.black.ratingDiff = d.ratingDiff.black;
  }
  clock.running = null;
  playSound('notify');
  render();
  if (page.tv) setTimeout(() => location.reload(), 4000);
}

async function resync(): Promise<void> {
  socket.clearPending();
  const res = await fetch(`/api/game/${game.id}`, { cache: 'no-store' });
  if (!res.ok) return;
  const body = (await res.json()) as { game: GameData };
  loadGame(body.game);
  socket.version = body.game.version;
  viewPly = null;
  render();
}

const socket = new StrongSocket(player ? `/play/${game.id}/v6` : `/watch/${game.id}/${orientation}/v6`, game.version, {
  message: (t, d) => {
    switch (t) {
      case 'move':
        return onMove(d as MoveEvent);
      case 'end':
        return onEnd(d as EndEvent);
      case 'drawOffer':
        game.drawOffer = (d as { by: Color | null }).by;
        if (game.drawOffer && game.drawOffer !== player) playSound('notify');
        return render();
      case 'crowd':
        crowd = d as CrowdEvent;
        return render();
      case 'rematchOffer':
        rematchBy = (d as { by: Color | null }).by;
        return render();
      case 'redirect':
        location.href = `/${(d as { id: string }).id}`;
        return;
    }
  },
  resync: () => void resync(),
  status: (isOnline) => {
    online = isOnline;
    render();
  },
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const current = viewPly ?? chess.history().length;
  if (e.key === 'ArrowLeft') view(current - 1);
  else if (e.key === 'ArrowRight') view(current + 1);
  else if (e.key === 'ArrowUp' || e.key === 'Home') view(0);
  else if (e.key === 'ArrowDown' || e.key === 'End') view(null);
  else if (e.key === 'f') {
    orientation = opposite(orientation);
    render();
  } else return;
  e.preventDefault();
});

setInterval(renderClocks, 100);
render();
