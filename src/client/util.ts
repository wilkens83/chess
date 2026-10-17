export function pageData<T>(): T {
  const node = document.getElementById('page-data');
  return JSON.parse(node?.textContent ?? '{}') as T;
}

type Child = Node | string | null | undefined | false;

/** Tiny DOM builder: el('div.panel#x', { onclick }, child, ...). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  attrs: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const [, name, rest] = /^([a-z0-9]+)(.*)$/.exec(tag) ?? [];
  const node = document.createElement((name ?? 'div') as K);
  for (const part of (rest ?? '').match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '.') node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') node.className += ` ${String(v)}`;
    else if (k in node && typeof v !== 'string') (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 10) return `${Math.floor(s)}.${Math.floor((s * 10) % 10)}`;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const playerName = (p: { name: string | null; rating: number | null; provisional?: boolean }): string =>
  `${p.name ?? 'Anonymous'}${p.rating ? ` (${p.rating}${p.provisional ? '?' : ''})` : ''}`;

let audio: AudioContext | null = null;

/** Short synthesized click, so no audio files need to be shipped. */
export function playSound(kind: 'move' | 'capture' | 'notify'): void {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = kind === 'capture' ? 220 : kind === 'notify' ? 660 : 440;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.12);
  } catch {
    // Audio is optional.
  }
}

/** Drop empty entries so optional children can be written inline. */
export const compact = <T>(items: (T | null | undefined | false)[]): T[] => items.filter((x): x is T => !!x);
