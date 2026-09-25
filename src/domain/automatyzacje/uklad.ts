import { cel, porty, wezel, type Graf, type Wezel } from "./graf";

/**
 * Uklad pionowej kanwy (jak w Klaviyo): wyzwalacz na gorze, sciezka w dol, galezie
 * warunku obok siebie pod wspolna pozioma magistrala. Czysta funkcja: graf + wysokosci
 * kart -> wspolrzedne kart, krawedzi, etykiet galezi i szczelin "+".
 *
 * Graf jest drzewem (edytor nie potrafi zlaczyc galezi). Gdyby wezel byl osiagalny
 * z dwoch rodzicow (definicja spoza edytora), rysujemy go pod pierwszym, a druga
 * krawedz prowadzi do tej samej pozycji.
 */

export const SZEROKOSC_KARTY = 288;
export const SZEROKOSC_KONCA = 96;
export const WYSOKOSC_KONCA = 32;
export const ODSTEP_X = 56;
export const ODSTEP_LINIOWY = 72;
export const ODSTEP_GALEZI = 136;
export const MARGINES = 48;

export interface PozycjaWezla {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Punkt {
  x: number;
  y: number;
}

export interface Krawedz {
  od: string;
  port: string;
  do: string;
  etykieta: string | null;
  /** lamana od dolu rodzica do gory dziecka */
  punkty: Punkt[];
  /** srodek przycisku "+" */
  slot: Punkt;
  /** srodek etykiety galezi (tylko dla rozgalezien) */
  etykietaPunkt: Punkt | null;
}

export interface Uklad {
  wezly: PozycjaWezla[];
  krawedzie: Krawedz[];
  szerokosc: number;
  wysokosc: number;
}

export function ulozGraf(g: Graf, wysokosc: (w: Wezel) => number): Uklad {
  const szerokosc = (w: Wezel) => (w.typ === "koniec" ? SZEROKOSC_KONCA : SZEROKOSC_KARTY);
  const odwiedzone = new Set<string>();
  const szerokosciPoddrzew = new Map<string, number>();

  // dzieci w kolejnosci portow, tylko te jeszcze nieprzypisane (drzewo)
  const dzieci = new Map<string, { port: string; etykieta: string | null; id: string }[]>();
  const przypisz = (id: string) => {
    if (odwiedzone.has(id)) return;
    odwiedzone.add(id);
    const w = wezel(g, id);
    if (!w) return;
    const lista: { port: string; etykieta: string | null; id: string }[] = [];
    for (const p of porty(w)) {
      const c = cel(w, p.port);
      if (c && wezel(g, c) && !odwiedzone.has(c)) {
        lista.push({ port: p.port, etykieta: p.etykieta, id: c });
        przypisz(c);
      }
    }
    dzieci.set(id, lista);
  };
  przypisz(g.start);

  const szerokoscPoddrzewa = (id: string): number => {
    const zapamietana = szerokosciPoddrzew.get(id);
    if (zapamietana !== undefined) return zapamietana;
    const w = wezel(g, id)!;
    const d = dzieci.get(id) ?? [];
    const dzieciSzer = d.reduce((s, x) => s + szerokoscPoddrzewa(x.id), 0) + Math.max(0, d.length - 1) * ODSTEP_X;
    const wynik = Math.max(szerokosc(w), dzieciSzer);
    szerokosciPoddrzew.set(id, wynik);
    return wynik;
  };

  const pozycje = new Map<string, PozycjaWezla>();
  const krawedzie: Krawedz[] = [];

  const uloz = (id: string, srodekX: number, y: number) => {
    const w = wezel(g, id)!;
    const sz = szerokosc(w);
    const wys = w.typ === "koniec" ? WYSOKOSC_KONCA : wysokosc(w);
    pozycje.set(id, { id, x: srodekX - sz / 2, y, w: sz, h: wys });
    const d = dzieci.get(id) ?? [];
    if (!d.length) return;
    const rozgalezienie = porty(w).length > 1;
    const odstep = rozgalezienie ? ODSTEP_GALEZI : ODSTEP_LINIOWY;
    const yDziecka = y + wys + odstep;
    const calkowita = d.reduce((s, x) => s + szerokoscPoddrzewa(x.id), 0) + (d.length - 1) * ODSTEP_X;
    let kursor = srodekX - calkowita / 2;
    const dol = { x: srodekX, y: y + wys };
    for (const dziecko of d) {
      const szer = szerokoscPoddrzewa(dziecko.id);
      const cx = kursor + szer / 2;
      kursor += szer + ODSTEP_X;
      uloz(dziecko.id, cx, yDziecka);
      const gora = { x: cx, y: yDziecka };
      if (!rozgalezienie) {
        krawedzie.push({
          od: id, port: dziecko.port, do: dziecko.id, etykieta: null,
          punkty: [dol, gora],
          slot: { x: srodekX, y: dol.y + odstep / 2 },
          etykietaPunkt: null,
        });
      } else {
        const magistralaY = dol.y + 28;
        krawedzie.push({
          od: id, port: dziecko.port, do: dziecko.id, etykieta: dziecko.etykieta,
          punkty: [dol, { x: srodekX, y: magistralaY }, { x: cx, y: magistralaY }, gora],
          etykietaPunkt: { x: cx, y: magistralaY + 26 },
          slot: { x: cx, y: magistralaY + 72 },
        });
      }
    }
  };

  // krawedzie do wezlow juz ulozonych (drugi rodzic) - po ulozeniu wszystkiego
  uloz(g.start, 0, 0);
  for (const w of g.wezly) {
    const p = pozycje.get(w.id);
    if (!p) continue;
    for (const port of porty(w)) {
      const c = cel(w, port.port);
      if (!c) continue;
      if (krawedzie.some((k) => k.od === w.id && k.port === port.port)) continue;
      const cp = pozycje.get(c);
      if (!cp) continue;
      const dol = { x: p.x + p.w / 2, y: p.y + p.h };
      krawedzie.push({
        od: w.id, port: port.port, do: c, etykieta: port.etykieta,
        punkty: [dol, { x: dol.x, y: dol.y + 24 }, { x: cp.x + cp.w / 2, y: dol.y + 24 }, { x: cp.x + cp.w / 2, y: cp.y }],
        slot: { x: dol.x, y: dol.y + 12 },
        etykietaPunkt: null,
      });
    }
  }

  // normalizacja do (MARGINES, MARGINES)
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  for (const p of pozycje.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  if (!Number.isFinite(minX)) minX = 0;
  const dx = MARGINES - minX;
  const przesun = (pt: Punkt): Punkt => ({ x: pt.x + dx, y: pt.y + MARGINES });
  return {
    wezly: [...pozycje.values()].map((p) => ({ ...p, x: p.x + dx, y: p.y + MARGINES })),
    krawedzie: krawedzie.map((k) => ({
      ...k,
      punkty: k.punkty.map(przesun),
      slot: przesun(k.slot),
      etykietaPunkt: k.etykietaPunkt ? przesun(k.etykietaPunkt) : null,
    })),
    szerokosc: maxX - minX + 2 * MARGINES,
    wysokosc: maxY + 2 * MARGINES,
  };
}

/** Sciezka SVG lamanej z zaokraglonymi naroznikami (promien 10). */
export function sciezkaSvg(punkty: Punkt[], promien = 10): string {
  if (punkty.length < 2) return "";
  if (punkty.length === 2) return `M ${punkty[0].x} ${punkty[0].y} L ${punkty[1].x} ${punkty[1].y}`;
  let d = `M ${punkty[0].x} ${punkty[0].y}`;
  for (let i = 1; i < punkty.length - 1; i++) {
    const a = punkty[i - 1], b = punkty[i], c = punkty[i + 1];
    const dAB = Math.hypot(b.x - a.x, b.y - a.y);
    const dBC = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(promien, dAB / 2, dBC / 2);
    if (r <= 0) {
      d += ` L ${b.x} ${b.y}`;
      continue;
    }
    const p1 = { x: b.x - ((b.x - a.x) / dAB) * r, y: b.y - ((b.y - a.y) / dAB) * r };
    const p2 = { x: b.x + ((c.x - b.x) / dBC) * r, y: b.y + ((c.y - b.y) / dBC) * r };
    d += ` L ${p1.x} ${p1.y} Q ${b.x} ${b.y} ${p2.x} ${p2.y}`;
  }
  const ost = punkty[punkty.length - 1];
  d += ` L ${ost.x} ${ost.y}`;
  return d;
}
