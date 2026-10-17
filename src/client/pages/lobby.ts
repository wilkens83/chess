import { Board } from '../board.ts';
import { StrongSocket } from '../socket.ts';
import { el, formatClock, playerName } from '../util.ts';
import { POOLS, speedOf, tcLabel, type Seek, type TimeControl } from '../../shared/protocol.ts';

type LobbySeek = Seek & { mine: boolean };

interface Featured {
  id: string;
  fen: string;
  lm: string | null;
  white: { name: string | null; rating: number | null };
  black: { name: string | null; rating: number | null };
  wc: number;
  bc: number;
}

const loggedIn = document.body.dataset.user !== '';
const poolsNode = document.getElementById('pools')!;
const seeksNode = document.getElementById('seeks')!;
const seeksEmpty = document.getElementById('seeks-empty')!;
const featuredNode = document.getElementById('featured')!;
const errorNode = document.getElementById('lobby-error')!;
const ratedBox = document.getElementById('rated') as HTMLInputElement;
ratedBox.disabled = !loggedIn;
if (!loggedIn) ratedBox.parentElement!.title = 'Log in to play rated games';

let seeks: LobbySeek[] = [];
let featuredBoard: Board | null = null;
let featuredId: string | null = null;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sameClock = (a: TimeControl, b: TimeControl) => a.limit === b.limit && a.increment === b.increment;

function renderPools(): void {
  const mine = seeks.find((s) => s.mine);
  poolsNode.replaceChildren(
    ...POOLS.map((tc) => {
      const waiting = mine && sameClock(mine.clock, tc);
      return el(
        'button.pool',
        {
          type: 'button',
          class: waiting ? 'waiting' : '',
          onclick: () => {
            errorNode.hidden = true;
            if (waiting) return socket.send('cancelSeek');
            // Join a compatible open seek if there is one, otherwise create our own.
            const match = seeks.find((s) => !s.mine && sameClock(s.clock, tc) && s.rated === ratedBox.checked);
            if (match) socket.send('joinSeek', match.id);
            else socket.send('seek', { ...tc, rated: ratedBox.checked });
          },
        },
        el('strong', null, tcLabel(tc)),
        el('span', null, waiting ? 'Waiting… click to cancel' : capitalize(speedOf(tc))),
      );
    }),
  );
}

function renderSeeks(): void {
  seeksEmpty.hidden = seeks.length > 0;
  seeksNode.replaceChildren(
    ...seeks.map((s) =>
      el(
        'tr',
        {
          class: s.mine ? 'mine' : 'joinable',
          title: s.mine ? 'Your challenge — click to cancel' : 'Click to play',
          onclick: () => (s.mine ? socket.send('cancelSeek') : socket.send('joinSeek', s.id)),
        },
        el('td', null, s.name),
        el('td', null, s.rating ? String(s.rating) : '–'),
        el('td', null, tcLabel(s.clock)),
        el('td', null, s.rated ? 'Rated' : 'Casual'),
      ),
    ),
  );
}

function renderFeatured(f: Featured): void {
  const lastMove = f.lm ? ([f.lm.slice(0, 2), f.lm.slice(2, 4)] as [string, string]) : null;
  if (featuredId !== f.id || !featuredBoard) {
    featuredId = f.id;
    const boardBox = el('div.mini-board');
    featuredNode.replaceChildren(
      el('a.featured-link', { href: `/${f.id}` }, el('div.mini-player', null, playerName(f.black), el('span.mini-clock#fc-black')), boardBox, el('div.mini-player', null, playerName(f.white), el('span.mini-clock#fc-white'))),
    );
    featuredBoard = new Board(boardBox, { fen: f.fen, orientation: 'white', lastMove, movable: null, dests: new Map() }, { coordinates: false });
    socket.send('startWatching', f.id);
  } else featuredBoard.set({ fen: f.fen, lastMove });
  document.getElementById('fc-white')!.textContent = formatClock(f.wc);
  document.getElementById('fc-black')!.textContent = formatClock(f.bc);
}

const socket = new StrongSocket('/lobby/socket/v5', null, {
  message: (t, d) => {
    switch (t) {
      case 'seeks':
        seeks = d as LobbySeek[];
        renderSeeks();
        renderPools();
        return;
      case 'featured':
        return renderFeatured(d as Featured);
      case 'fen': {
        const f = d as { id: string; fen: string; lm: string; wc: number; bc: number };
        if (f.id === featuredId && featuredBoard) {
          featuredBoard.set({ fen: f.fen, lastMove: [f.lm.slice(0, 2), f.lm.slice(2, 4)] });
          document.getElementById('fc-white')!.textContent = formatClock(f.wc);
          document.getElementById('fc-black')!.textContent = formatClock(f.bc);
        }
        return;
      }
      case 'redirect':
        location.href = `/${(d as { id: string }).id}`;
        return;
      case 'error':
        errorNode.textContent = String(d);
        errorNode.hidden = false;
        return;
    }
  },
  counts: (players, games) => {
    document.getElementById('nb-players')!.textContent = String(players);
    document.getElementById('nb-games')!.textContent = String(games);
  },
});

renderPools();
renderSeeks();
