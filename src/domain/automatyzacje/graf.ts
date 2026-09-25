import { z } from "zod";

/**
 * Definicja automatyzacji jako graf (wzorzec Klaviyo: plaska lista wezlow, krawedzie
 * w `links`). Czysta domena: zero bazy, zero Reacta. Ten sam kod waliduje graf na
 * serwerze przed wlaczeniem i w przegladarce podczas edycji.
 *
 * Zasady grafu (wymuszone przez `zwalidujGraf`, nie przez dobra wole edytora):
 *  - dokladnie jeden wyzwalacz i jest nim `start`;
 *  - kazdy link wskazuje istniejacy wezel; kazdy wezel jest osiagalny ze startu;
 *  - graf jest acykliczny (osoba nie moze krazyc w kolko i dostawac maila bez konca);
 *  - kazda sciezka konczy sie wezlem `koniec` ("galaz bez konca" blokuje wlaczenie);
 *  - wezel e-mail ma temat i tresc (to sprawdza serwer, bo tresc lezy w bazie).
 */

export const WERSJA_GRAFU = 1;

export const ZDARZENIA_WYZWALACZA = {
  "popup.submitted": "zapis z formularza",
  "order.created": "złożone zamówienie",
  "list.joined": "dołączenie do listy",
} as const;
export type ZdarzenieWyzwalacza = keyof typeof ZDARZENIA_WYZWALACZA;

export const JEDNOSTKI = { minuty: "min", godziny: "godz.", dni: "dni" } as const;
export type Jednostka = keyof typeof JEDNOSTKI;
const MINUTY: Record<Jednostka, number> = { minuty: 1, godziny: 60, dni: 1440 };

export const DNI_TYGODNIA = ["pn", "wt", "śr", "cz", "pt", "so", "nd"] as const;

const id = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i);
const uuid = z.string().uuid();
const link = z.string().min(1).max(64).nullable();

export const schematReguly = z.discriminatedUnion("rodzaj", [
  z.object({ rodzaj: z.literal("kupil_w_dniach"), dni: z.number().int().min(1).max(3650) }),
  z.object({ rodzaj: z.literal("kupil_od_wejscia") }),
  z.object({ rodzaj: z.literal("kliknal_poprzedni") }),
  z.object({ rodzaj: z.literal("ma_zgode") }),
  z.object({ rodzaj: z.literal("w_segmencie"), segmentId: uuid }),
  z.object({ rodzaj: z.literal("wartosc_zamowienia"), minMinor: z.number().int().min(0).max(1_000_000_000) }),
]);
export type RegulaWarunku = z.infer<typeof schematReguly>;

export const schematAkcjiProfilu = z.discriminatedUnion("rodzaj", [
  z.object({ rodzaj: z.literal("dodaj_do_listy"), listId: uuid }),
  z.object({ rodzaj: z.literal("usun_z_listy"), listId: uuid }),
]);
export type AkcjaProfilu = z.infer<typeof schematAkcjiProfilu>;

const linkNext = z.object({ next: link });

export const schematWezla = z.discriminatedUnion("typ", [
  z.object({
    id,
    typ: z.literal("wyzwalacz"),
    zdarzenie: z.enum(["popup.submitted", "order.created", "list.joined"]),
    listId: uuid.optional(),
    /**
     * Tylko `list.joined`: czy wpuszczac takze dodania MASOWE (import, dodanie segmentu,
     * inne automatyzacje). Domyslnie nie: import 20 tys. adresow na liste z wlaczonym
     * powitaniem wyslalby 20 tys. powitan naraz, a tego nie da sie cofnac.
     */
    takzeMasowe: z.boolean().optional(),
    links: linkNext,
  }),
  z.object({
    id,
    typ: z.literal("opoznienie"),
    ilosc: z.number().int().min(1).max(100_000),
    jednostka: z.enum(["minuty", "godziny", "dni"]),
    links: linkNext,
  }),
  z.object({
    id,
    typ: z.literal("czekaj_do"),
    // ISO: 1 = poniedzialek ... 7 = niedziela
    dni: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    godzina: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    links: linkNext,
  }),
  z.object({
    id,
    typ: z.literal("warunek"),
    etykieta: z.string().max(80).optional(),
    regula: schematReguly,
    links: z.object({ next_if_true: link, next_if_false: link }),
  }),
  z.object({
    id,
    typ: z.literal("ab_split"),
    procentA: z.number().int().min(1).max(99),
    links: z.object({ a: link, b: link }),
  }),
  z.object({
    id,
    typ: z.literal("email"),
    emailId: uuid,
    links: linkNext,
  }),
  z.object({
    id,
    typ: z.literal("profil"),
    akcja: schematAkcjiProfilu,
    links: linkNext,
  }),
  z.object({ id, typ: z.literal("koniec") }),
]);
export type Wezel = z.infer<typeof schematWezla>;
export type TypWezla = Wezel["typ"];
export type WezelTypu<T extends TypWezla> = Extract<Wezel, { typ: T }>;

export const schematGrafu = z.object({
  wersja: z.literal(WERSJA_GRAFU),
  start: id,
  ustawienia: z.object({
    // osoba, ktora kupila PO wejsciu, wypada z automatyzacji (win-back, porzucony koszyk)
    wyjsciePoZakupie: z.boolean().default(false),
  }).default({ wyjsciePoZakupie: false }),
  wezly: z.array(schematWezla).min(1).max(200),
});
export type Graf = z.infer<typeof schematGrafu>;

/** Porty wyjsciowe wezla, w kolejnosci rysowania (lewa galaz najpierw). */
export function porty(w: Wezel): { port: string; etykieta: string | null }[] {
  switch (w.typ) {
    case "koniec":
      return [];
    case "warunek":
      return [
        { port: "next_if_true", etykieta: "Tak" },
        { port: "next_if_false", etykieta: "Nie" },
      ];
    case "ab_split":
      return [
        { port: "a", etykieta: `A · ${w.procentA}%` },
        { port: "b", etykieta: `B · ${100 - w.procentA}%` },
      ];
    default:
      return [{ port: "next", etykieta: null }];
  }
}

export function cel(w: Wezel, port: string): string | null {
  if (w.typ === "koniec") return null;
  return ((w.links as Record<string, string | null>)[port] ?? null) as string | null;
}

export function zCelem(w: Wezel, port: string, nowyCel: string | null): Wezel {
  if (w.typ === "koniec") return w;
  return { ...w, links: { ...(w.links as Record<string, string | null>), [port]: nowyCel } } as Wezel;
}

export function wezel(g: Graf, wezelId: string): Wezel | undefined {
  return g.wezly.find((w) => w.id === wezelId);
}

let licznik = 0;
/** Krotki, lokalnie unikalny identyfikator wezla (nie wychodzi poza definicje flow). */
export function noweIdWezla(typ: TypWezla, g?: Graf): string {
  for (;;) {
    licznik++;
    const kandydat = `${typ}_${Date.now().toString(36)}${licznik.toString(36)}`;
    if (!g || !wezel(g, kandydat)) return kandydat;
  }
}

/** Pusty graf: wyzwalacz -> koniec. */
export function pustyGraf(zdarzenie: ZdarzenieWyzwalacza, listId?: string): Graf {
  return {
    wersja: WERSJA_GRAFU,
    start: "wyzwalacz",
    ustawienia: { wyjsciePoZakupie: false },
    wezly: [
      { id: "wyzwalacz", typ: "wyzwalacz", zdarzenie, ...(listId ? { listId } : {}), links: { next: "koniec" } },
      { id: "koniec", typ: "koniec" },
    ],
  };
}

// ── Operacje (czyste, zwracaja nowy graf) ─────────────────────────────────────

export interface Slot {
  /** wezel, za ktorym wstawiamy */
  po: string;
  port: string;
}

/**
 * Wstawienie wezla w szczelinie miedzy `po`(port) a jego dotychczasowym celem.
 * Wezel rozgaleziajacy dostaje na kazdej nowej galezi wlasny `koniec`, a dotychczasowy
 * ciag dalszy trafia na PIERWSZA galaz (Tak / A) - jak w Klaviyo.
 */
export function wstawWezel(g: Graf, slot: Slot, nowy: Wezel): Graf {
  const rodzic = wezel(g, slot.po);
  if (!rodzic || rodzic.typ === "koniec") return g;
  const dalej = cel(rodzic, slot.port);
  const dodane: Wezel[] = [];
  let wstawiany: Wezel = nowy;
  const wyjscia = porty(nowy);
  if (wyjscia.length === 1) {
    wstawiany = zCelem(nowy, wyjscia[0].port, dalej);
  } else if (wyjscia.length > 1) {
    wyjscia.forEach((p, i) => {
      if (i === 0) {
        wstawiany = zCelem(wstawiany, p.port, dalej);
      } else {
        const k: Wezel = { id: noweIdWezla("koniec", g), typ: "koniec" };
        dodane.push(k);
        wstawiany = zCelem(wstawiany, p.port, k.id);
      }
    });
  }
  // jesli nowy wezel to `koniec`, a dalej cos bylo - odcinamy: usuwa sie nizej przez `usunWezel`
  const wezly = g.wezly.map((w) => (w.id === rodzic.id ? zCelem(w, slot.port, nowy.id) : w));
  return { ...g, wezly: [...wezly, wstawiany, ...dodane] };
}

/** Wszystkie wezly osiagalne z `startId` (BFS po portach). */
export function osiagalne(g: Graf, startId: string): Set<string> {
  const odwiedzone = new Set<string>();
  const kolejka = [startId];
  while (kolejka.length) {
    const biezacy = kolejka.shift()!;
    if (odwiedzone.has(biezacy)) continue;
    const w = wezel(g, biezacy);
    if (!w) continue;
    odwiedzone.add(biezacy);
    for (const p of porty(w)) {
      const c = cel(w, p.port);
      if (c && !odwiedzone.has(c)) kolejka.push(c);
    }
  }
  return odwiedzone;
}

/**
 * Usuniecie wezla. Wezel liniowy jest "wycinany" (rodzic laczy sie z jego nastepca).
 * Wezel rozgaleziajacy zabiera ze soba cale poddrzewo poza PIERWSZA galezia, ktora
 * przejmuje jego miejsce (odwrotnosc `wstawWezel`). Wyzwalacza i wezla `koniec`
 * nie da sie usunac - koniec znika razem z galezia, ktora do niego prowadzi.
 */
export function usunWezel(g: Graf, wezelId: string): Graf {
  const w = wezel(g, wezelId);
  if (!w || w.typ === "wyzwalacz" || w.typ === "koniec") return g;
  const wyjscia = porty(w);
  const nastepca = wyjscia.length ? cel(w, wyjscia[0].port) : null;
  // poddrzewa pozostalych galezi do usuniecia (tylko to, co NIE jest osiagalne inaczej)
  const bezWezla: Graf = {
    ...g,
    wezly: g.wezly
      .filter((x) => x.id !== wezelId)
      .map((x) => {
        let y = x;
        for (const p of porty(x)) if (cel(x, p.port) === wezelId) y = zCelem(y, p.port, nastepca);
        return y;
      }),
  };
  const zywe = osiagalne(bezWezla, bezWezla.start);
  return { ...bezWezla, wezly: bezWezla.wezly.filter((x) => zywe.has(x.id)) };
}

export function zmienWezel(g: Graf, wezelId: string, zmiany: Partial<Wezel>): Graf {
  return { ...g, wezly: g.wezly.map((w) => (w.id === wezelId ? ({ ...w, ...zmiany } as Wezel) : w)) };
}

// ── Walidacja (bramka wlaczenia) ─────────────────────────────────────────────

export interface BladGrafu {
  wezelId: string | null;
  tresc: string;
}

export interface KontekstWalidacji {
  /** wiadomosci e-mail znane serwerowi: temat i czy jest tresc */
  emaile?: Record<string, { temat: string; maTresc: boolean }>;
  listy?: Set<string>;
  segmenty?: Set<string>;
}

export function zwalidujGraf(surowy: unknown, ctx: KontekstWalidacji = {}): { graf: Graf | null; bledy: BladGrafu[] } {
  const parsed = schematGrafu.safeParse(surowy);
  if (!parsed.success) {
    const p = parsed.error.issues[0];
    return { graf: null, bledy: [{ wezelId: null, tresc: `Definicja nie przeszła walidacji (${p?.path.join(".") || "graf"}: ${p?.message ?? "błąd"}).` }] };
  }
  const g = parsed.data;
  const bledy: BladGrafu[] = [];
  const ids = new Set<string>();
  for (const w of g.wezly) {
    if (ids.has(w.id)) bledy.push({ wezelId: w.id, tresc: "Dwa kroki mają ten sam identyfikator." });
    ids.add(w.id);
  }
  const wyzwalacze = g.wezly.filter((w) => w.typ === "wyzwalacz");
  if (wyzwalacze.length !== 1) bledy.push({ wezelId: null, tresc: "Automatyzacja musi mieć dokładnie jeden wyzwalacz." });
  const start = wezel(g, g.start);
  if (!start || start.typ !== "wyzwalacz") bledy.push({ wezelId: null, tresc: "Pierwszym krokiem musi być wyzwalacz." });

  for (const w of g.wezly) {
    for (const p of porty(w)) {
      const c = cel(w, p.port);
      if (c === null) {
        bledy.push({ wezelId: w.id, tresc: p.etykieta ? `Gałąź „${p.etykieta}” nie ma końca.` : "Ta gałąź nie ma końca." });
      } else if (!ids.has(c)) {
        bledy.push({ wezelId: w.id, tresc: "Krok wskazuje na krok, którego nie ma." });
      } else if (c === w.id) {
        bledy.push({ wezelId: w.id, tresc: "Krok nie może prowadzić do samego siebie." });
      }
    }
    switch (w.typ) {
      case "wyzwalacz":
        if (w.zdarzenie === "list.joined") {
          if (!w.listId) bledy.push({ wezelId: w.id, tresc: "Wyzwalacz „dołączenie do listy” wymaga wybrania listy." });
          else if (ctx.listy && !ctx.listy.has(w.listId)) bledy.push({ wezelId: w.id, tresc: "Wybrana lista już nie istnieje." });
        }
        break;
      case "email": {
        if (g.wezly.some((x) => x !== w && x.typ === "email" && x.emailId === w.emailId)) {
          bledy.push({ wezelId: w.id, tresc: "Ta sama wiadomość jest w dwóch krokach. Druga osoba dostałaby ją tylko raz." });
        }
        const e = ctx.emaile?.[w.emailId];
        if (ctx.emaile && !e) bledy.push({ wezelId: w.id, tresc: "Wiadomość tego kroku nie istnieje." });
        else if (e && !e.temat.trim()) bledy.push({ wezelId: w.id, tresc: "Wiadomość nie ma tematu." });
        else if (e && !e.maTresc) bledy.push({ wezelId: w.id, tresc: "Wiadomość nie ma treści." });
        break;
      }
      case "warunek":
        if (w.regula.rodzaj === "w_segmencie" && ctx.segmenty && !ctx.segmenty.has(w.regula.segmentId)) {
          bledy.push({ wezelId: w.id, tresc: "Segment z warunku już nie istnieje." });
        }
        break;
      case "profil":
        if (ctx.listy && !ctx.listy.has(w.akcja.listId)) bledy.push({ wezelId: w.id, tresc: "Lista z tego kroku już nie istnieje." });
        break;
    }
  }

  // osiagalnosc i cykle (DFS z kolorowaniem) - tylko gdy krawedzie sa poprawne
  if (start && start.typ === "wyzwalacz" && !bledy.some((b) => b.tresc.includes("którego nie ma"))) {
    const zywe = osiagalne(g, g.start);
    for (const w of g.wezly) if (!zywe.has(w.id)) bledy.push({ wezelId: w.id, tresc: "Krok nie jest połączony ze ścieżką od wyzwalacza." });
    const kolor = new Map<string, 1 | 2>();
    const cykl = (wid: string): boolean => {
      const k = kolor.get(wid);
      if (k === 1) return true;
      if (k === 2) return false;
      kolor.set(wid, 1);
      const w = wezel(g, wid);
      if (w) for (const p of porty(w)) {
        const c = cel(w, p.port);
        if (c && cykl(c)) return true;
      }
      kolor.set(wid, 2);
      return false;
    };
    if (cykl(g.start)) bledy.push({ wezelId: null, tresc: "Ścieżka zawraca do wcześniejszego kroku (pętla). Osoba krążyłaby bez końca." });
  }
  return { graf: g, bledy };
}

// ── Ostrzezenia (nie blokuja wlaczenia) ──────────────────────────────────────

/**
 * Rzeczy, ktore sa poprawne, ale prawie na pewno nie dzialaja tak, jak operator mysli.
 * Warunek "wartosc zamowienia" zaraz po wyzwalaczu "zlozone zamowienie": w chwili zdarzenia
 * zamowienie bywa jeszcze nieoplacone (pending), a warunek liczy tylko oplacone, wiec
 * prawie zawsze wybierze "Nie" (review runda 2, #12).
 */
export function ostrzezeniaGrafu(g: Graf): BladGrafu[] {
  const wynik: BladGrafu[] = [];
  const start = wezel(g, g.start);
  if (!start || start.typ !== "wyzwalacz" || start.zdarzenie !== "order.created") return wynik;
  const odwiedzone = new Set<string>();
  const idz = (id: string | null, poOpoznieniu: boolean) => {
    if (!id || odwiedzone.has(`${id}:${poOpoznieniu}`)) return;
    odwiedzone.add(`${id}:${poOpoznieniu}`);
    const w = wezel(g, id);
    if (!w) return;
    if (w.typ === "warunek" && w.regula.rodzaj === "wartosc_zamowienia" && !poOpoznieniu) {
      wynik.push({ wezelId: w.id, tresc: "Warunek wartości zamówienia stoi zaraz po złożeniu zamówienia, bez opóźnienia. Zamówienie bywa wtedy jeszcze nieopłacone, a liczą się tylko opłacone, więc prawie każdy pójdzie gałęzią „Nie”. Postaw przed warunkiem opóźnienie, np. 1 godzinę." });
    }
    const dalej = poOpoznieniu || w.typ === "opoznienie" || w.typ === "czekaj_do";
    for (const p of porty(w)) idz(cel(w, p.port), dalej);
  };
  idz(cel(start, "next"), false);
  return wynik;
}

// ── Opisy dla interfejsu i logow ─────────────────────────────────────────────

export const NAZWY_WEZLOW: Record<TypWezla, string> = {
  wyzwalacz: "Wyzwalacz",
  opoznienie: "Opóźnienie",
  czekaj_do: "Czekaj do",
  warunek: "Warunek",
  ab_split: "Test A/B",
  email: "Wyślij e-mail",
  profil: "Aktualizuj profil",
  koniec: "Koniec",
};

export interface Slowniki {
  listy?: Record<string, string>;
  segmenty?: Record<string, string>;
  emaile?: Record<string, { temat: string; nazwa: string }>;
}

function zl(minor: number): string {
  return `${Math.floor(minor / 100)} zł`;
}

export function opiszRegule(r: RegulaWarunku, s: Slowniki = {}): string {
  switch (r.rodzaj) {
    case "kupil_w_dniach":
      return `kupił w ostatnich ${r.dni} dniach`;
    case "kupil_od_wejscia":
      return "kupił od wejścia do automatyzacji";
    case "kliknal_poprzedni":
      return "kliknął w poprzedni e-mail";
    case "ma_zgode":
      return "ma zgodę na e-mail";
    case "w_segmencie":
      return `jest w segmencie „${s.segmenty?.[r.segmentId] ?? "…"}”`;
    case "wartosc_zamowienia":
      return `zamówienie warte co najmniej ${zl(r.minMinor)}`;
  }
}

export function opiszOpoznienie(ilosc: number, jednostka: Jednostka): string {
  if (jednostka === "minuty") return `${ilosc} min`;
  if (jednostka === "godziny") return ilosc === 1 ? "1 godz." : `${ilosc} godz.`;
  return ilosc === 1 ? "1 dzień" : `${ilosc} dni`;
}

export function minutOpoznienia(ilosc: number, jednostka: Jednostka): number {
  return ilosc * MINUTY[jednostka];
}

/**
 * Ile minut moze minac od zdarzenia do pierwszego "prawdziwego" kroku: suma opoznien
 * (i tygodnia na kazde "czekaj do") stojacych na starcie ciagiem. Okno skanu wejsc musi
 * byc co najmniej tak dlugie, inaczej zdarzenie z dlugim pierwszym opoznieniem, ktore
 * nie weszlo od razu (np. worker lezal), wypada z okna, zanim silnik go zobaczy.
 */
export function minutNaStarcie(g: Graf): number {
  let suma = 0;
  const start = wezel(g, g.start);
  let biezacy = start && start.typ !== "koniec" ? cel(start, "next") : null;
  const odwiedzone = new Set<string>();
  while (biezacy && !odwiedzone.has(biezacy)) {
    odwiedzone.add(biezacy);
    const w = wezel(g, biezacy);
    if (!w) break;
    if (w.typ === "opoznienie") suma += minutOpoznienia(w.ilosc, w.jednostka);
    else if (w.typ === "czekaj_do") suma += 7 * 1440;
    else break;
    biezacy = cel(w, "next");
  }
  return suma;
}

/** Zrodla `list_members.source`, ktore licza sie jako dodanie POJEDYNCZE (reczne, formularz). */
export const ZRODLA_POJEDYNCZE = ["reczny", "formularz", "popup"] as const;

/** Jednowierszowe podsumowanie konfiguracji wezla (jak w edrone i Klaviyo). */
export function opiszWezel(w: Wezel, s: Slowniki = {}): string {
  switch (w.typ) {
    case "wyzwalacz":
      return w.zdarzenie === "list.joined"
        ? `Gdy ktoś dołączy do listy „${s.listy?.[w.listId ?? ""] ?? "…"}”`
        : `Gdy ktoś ${w.zdarzenie === "popup.submitted" ? "zapisze się przez formularz" : "złoży zamówienie"}`;
    case "opoznienie":
      return `Czekaj ${opiszOpoznienie(w.ilosc, w.jednostka)}`;
    case "czekaj_do": {
      const dni = [...w.dni].sort((a, b) => a - b).map((d) => DNI_TYGODNIA[d - 1]).join(", ");
      return `Do ${w.dni.length === 7 ? "najbliższej" : dni}, godz. ${w.godzina}`;
    }
    case "warunek":
      return `Czy ${opiszRegule(w.regula, s)}?`;
    case "ab_split":
      return `Losowo: ${w.procentA}% na A, ${100 - w.procentA}% na B`;
    case "email":
      return s.emaile?.[w.emailId]?.temat?.trim() || "Bez tematu";
    case "profil":
      return `${w.akcja.rodzaj === "dodaj_do_listy" ? "Dodaj do listy" : "Usuń z listy"} „${s.listy?.[w.akcja.listId] ?? "…"}”`;
    case "koniec":
      return "Koniec";
  }
}

export function tytulWezla(w: Wezel, s: Slowniki = {}): string {
  if (w.typ === "email") return s.emaile?.[w.emailId]?.nazwa || NAZWY_WEZLOW.email;
  if (w.typ === "warunek" && w.etykieta?.trim()) return w.etykieta.trim();
  return NAZWY_WEZLOW[w.typ];
}

// ── Historia edycji (cofnij / ponow), generyczna ─────────────────────────────

export interface HistoriaGrafu {
  biezacy: Graf;
  przeszlosc: Graf[];
  przyszlosc: Graf[];
}
export const LIMIT_HISTORII_GRAFU = 100;
export function nowaHistoriaGrafu(g: Graf): HistoriaGrafu {
  return { biezacy: g, przeszlosc: [], przyszlosc: [] };
}
export function zapiszGraf(h: HistoriaGrafu, g: Graf): HistoriaGrafu {
  if (g === h.biezacy) return h;
  return { biezacy: g, przeszlosc: [...h.przeszlosc, h.biezacy].slice(-LIMIT_HISTORII_GRAFU), przyszlosc: [] };
}
export function cofnijGraf(h: HistoriaGrafu): HistoriaGrafu {
  const poprzedni = h.przeszlosc[h.przeszlosc.length - 1];
  if (!poprzedni) return h;
  return { biezacy: poprzedni, przeszlosc: h.przeszlosc.slice(0, -1), przyszlosc: [h.biezacy, ...h.przyszlosc] };
}
export function ponowGraf(h: HistoriaGrafu): HistoriaGrafu {
  const [nastepny, ...reszta] = h.przyszlosc;
  if (!nastepny) return h;
  return { biezacy: nastepny, przeszlosc: [...h.przeszlosc, h.biezacy], przyszlosc: reszta };
}
