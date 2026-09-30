import { getPool } from "../../adapters/db/pool";
import { config } from "../../config";
import {
  etykietaMetryki,
  funkcjeWymagajaceV2,
  grafDoZapisu,
  kluczMetryki,
  noweIdWezla,
  pustyGraf,
  schematGrafu,
  schematMetrykiRef,
  triggerEventGrafu,
  wstawWezel,
  wyzwalaczGrafu,
  zdarzenieV1,
  zrodloZV1,
  zwalidujGraf,
  ZDARZENIA_WYZWALACZA,
  type BladGrafu,
  type Graf,
  type KontekstWalidacji,
  type MetrykaRef,
  type Wezel,
  type ZdarzenieWyzwalacza,
  type ZrodloWyzwalacza,
} from "../../domain/automatyzacje/graf";
import type { MetrykaKatalogu } from "../../domain/automatyzacje/wyzwalanie";
import { maZmienne, sprawdzSzablon } from "../../domain/email/szablon";
import { ponowneWejscieDostepne } from "./ponowne-wejscie";
import { katalogMetryk, zrodloZdarzen } from "./zrodlo-zdarzen";
import { nowyBlok, pustyDokument, wczytajDokument, type DokumentMaila } from "../../domain/email/bloki";
import { renderujDokument } from "../tresc/render-blokow";
import { kanonicznyJson, przygotujDokument } from "../tresc/zapisz-tresc";
import { przychodAutomatyzacji, type SumaZrodla } from "../przelicz-atrybucje";
import { zapiszZdarzenie } from "../wysylka/wyslij-kampanie";
import type { PoolClient } from "pg";

/**
 * Use-case'y panelu automatyzacji. Model: `flows` = graf ze szkicem i definicja
 * opublikowana, `journeys` = wiadomosci e-mail (wezly) tego grafu. SQL tu, nie
 * w repozytoria.ts (ten sam dlug co w zapisz-tresc); kazde zapytanie z tenant_id (AD-2).
 */

export const TRIGGERY: Record<string, string> = ZDARZENIA_WYZWALACZA;

/** Etykieta wyzwalacza do listy automatyzacji: zdarzenie v1, `list.joined` albo `metryka:<integracja>:<nazwa>`. */
export function etykietaWyzwalacza(zdarzenie: string | null | undefined): string {
  if (!zdarzenie) return "—";
  if (zdarzenie in TRIGGERY) return TRIGGERY[zdarzenie];
  const m = /^metryka:([^:]+):(.+)$/.exec(zdarzenie);
  return m ? etykietaMetryki({ integracja: m[1], nazwa: m[2] }) : zdarzenie;
}

import { STATUSY, type StatusAutomatyzacji } from "../../domain/automatyzacje/statusy";
export { STATUSY, type StatusAutomatyzacji };

type Wynik<T = object> = ({ ok: true } & T) | { ok: false; blad: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Szkic rozni sie od wersji wlaczonej": graf inny ALBO temat/tresc ktoregos maila ze
 * szkicu inna niz jego migawka w wersji live (0025). Liczone w bazie dla wiersza `f`
 * (alias tabeli flows), wiec lista, kanwa i zapis mowia to samo.
 */
const SQL_NIEPUBLIKOWANE = `(f.live is null or f.live <> f.draft or exists (
  select 1 from journeys j
    left join flow_versions v on v.tenant_id = f.tenant_id and v.flow_id = f.id and v.version = f.live_version
   where j.tenant_id = f.tenant_id and j.flow_id = f.id
     and exists (select 1 from jsonb_array_elements(f.draft->'wezly') w
                  where w->>'typ' = 'email' and w->>'emailId' = j.id::text)
     and (v.emails->(j.id::text) is null
          or v.emails->(j.id::text)->>'subject' is distinct from coalesce(j.subject, '')
          or v.emails->(j.id::text)->>'html' is distinct from coalesce(j.content->>'html', ''))))`;

/** Wiadomosci wskazane w grafie (bez sierot: wiadomosci "+ e-mail" usunietych z kanwy). */
const SQL_EMAILI_W_SZKICU = `(select count(*)::int from jsonb_array_elements(f.draft->'wezly') w where w->>'typ' = 'email')`;

/** Limit wiadomosci na automatyzacje: kanwa tworzy wiersz przy kazdym "+ e-mail". */
const LIMIT_WIADOMOSCI = 100;

type Kl = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

async function czyNiepublikowane(klient: Kl, tenantId: string, flowId: string): Promise<boolean> {
  const { rows } = await klient.query(`select ${SQL_NIEPUBLIKOWANE} as n from flows f where f.tenant_id = $1 and f.id = $2`, [tenantId, flowId]);
  return rows[0]?.n ?? false;
}

function jestDuplikatemNazwy(blad: unknown): boolean {
  return (blad as { code?: string })?.code === "23505" && String((blad as { constraint?: string })?.constraint ?? "").includes("name");
}

// ── Lista ───────────────────────────────────────────────────────────────────

export interface AutomatyzacjaNaLiscie {
  id: string;
  name: string;
  status: StatusAutomatyzacji;
  zdarzenie: string | null;
  wToku: number;
  wyslane: number;
  emaili: number;
  przychod: SumaZrodla | null;
  niepublikowane: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function automatyzacjeTenanta(tenantId: string): Promise<{ lista: AutomatyzacjaNaLiscie[]; przebiegAt: Date | null }> {
  const pool = getPool();
  const [{ rows }, atrybucja] = await Promise.all([
    pool.query(
      `select f.id, f.name, f.status, f.created_at, f.updated_at,
              coalesce(f.trigger_event, f.draft->'wezly'->0->>'zdarzenie',
                       case f.draft->'wezly'->0->'zrodlo'->>'rodzaj'
                         when 'lista' then 'list.joined'
                         when 'metryka' then 'metryka:' || (f.draft->'wezly'->0->'zrodlo'->'metryka'->>'integracja')
                                               || ':' || (f.draft->'wezly'->0->'zrodlo'->'metryka'->>'nazwa')
                       end) as zdarzenie,
              ${SQL_NIEPUBLIKOWANE} as niepublikowane,
              (select count(*)::int from flow_participants p
                where p.tenant_id = f.tenant_id and p.flow_id = f.id and p.status = 'w_toku') as w_toku,
              ${SQL_EMAILI_W_SZKICU} as emaili,
              -- wyslane liczone ze ZDARZENIA sent (mail, ktory sie odbil, WYSZEDL)
              (select count(*)::int from message_events e
                 join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
                 join journeys j on j.tenant_id = m.tenant_id and j.id = m.source_id
                where e.tenant_id = f.tenant_id and e.event_type = 'sent'
                  and m.source_type = 'journey' and j.flow_id = f.id) as wyslane,
              coalesce((select array_agg(j.id) from journeys j where j.tenant_id = f.tenant_id and j.flow_id = f.id), '{}') as email_ids
         from flows f
        where f.tenant_id = $1
        order by f.created_at desc`,
      [tenantId],
    ),
    przychodAutomatyzacji(tenantId),
  ]);
  const lista = rows.map((r) => {
    let przychod: SumaZrodla | null = null;
    if (atrybucja.przebiegAt) {
      przychod = { zamowien: 0, przychodMinor: 0 };
      for (const id of r.email_ids as string[]) {
        const s = atrybucja.perAutomatyzacja[id];
        if (s) {
          przychod.zamowien += s.zamowien;
          przychod.przychodMinor += s.przychodMinor;
        }
      }
    }
    return {
      id: r.id, name: r.name, status: r.status, zdarzenie: r.zdarzenie, wToku: r.w_toku, wyslane: r.wyslane,
      emaili: r.emaili, przychod, niepublikowane: r.niepublikowane, created_at: r.created_at, updated_at: r.updated_at,
    };
  });
  return { lista, przebiegAt: atrybucja.przebiegAt };
}

/**
 * Zgodnosc z ekranem przegladu (`t/[tenantId]/page.tsx`, cudzy plik): ten sam ksztalt
 * co dawna lista journeyow. `active` = flow wlaczony; `wyslane` = suma z wszystkich
 * wiadomosci flow. UWAGA: przeglad kluczuje przychod po `perAutomatyzacja[id]`, a ten
 * slownik jest per WIADOMOSC (journeys.id). Dla flow zmigrowanych z 0019 id sie zgadzaja,
 * dla nowych flow przeglad pokaze 0 - do poprawy w przegladzie (opisane w raporcie).
 */
export interface Journey {
  id: string;
  name: string;
  trigger_event: string;
  delay_minutes: number;
  subject: string;
  content: { html?: string };
  active: boolean;
  active_since: string | null;
  created_at: string;
  wyslane: number;
}

export async function journeyeTenanta(tenantId: string): Promise<Journey[]> {
  const { lista } = await automatyzacjeTenanta(tenantId);
  return lista.map((f) => ({
    id: f.id,
    name: f.name,
    trigger_event: f.zdarzenie ?? "",
    delay_minutes: 0,
    subject: "",
    content: {},
    active: f.status === "wlaczony",
    active_since: null,
    created_at: String(f.created_at),
    wyslane: f.wyslane,
  }));
}

// ── Tworzenie ───────────────────────────────────────────────────────────────

function sprawdzNazwe(name: string): string | null {
  if (!name.trim()) return "Automatyzacja musi mieć nazwę.";
  if (name.length > 200) return "Nazwa jest za długa (maks. 200 znaków).";
  return null;
}

export async function utworzAutomatyzacje(
  tenantId: string,
  dane: { name: string; zdarzenie?: string; metryka?: unknown; listId?: string | null },
): Promise<Wynik<{ id: string }>> {
  const bladNazwy = sprawdzNazwe(dane.name);
  if (bladNazwy) return { ok: false, blad: bladNazwy };
  let zrodlo: ZrodloWyzwalacza;
  if (dane.metryka !== undefined && dane.metryka !== null && dane.metryka !== "") {
    // metryka z listy wyboru: klucz naturalny (integracja, nazwa) z katalogu TEGO tenanta
    const m = schematMetrykiRef.safeParse(typeof dane.metryka === "string" ? rozbierzKluczMetryki(dane.metryka) : dane.metryka);
    if (!m.success) return { ok: false, blad: "Nieznana metryka." };
    const znana = (await katalogMetryk().lista(getPool(), tenantId)).find((x) => kluczMetryki(x) === kluczMetryki(m.data));
    if (!znana) return { ok: false, blad: "Tej metryki nie ma w koncie." };
    if (!znana.canTrigger) return { ok: false, blad: "Ta metryka nie może uruchamiać automatyzacji." };
    if (!zdarzenieV1(m.data) && !config().MIDREV_GRAF_V2) return { ok: false, blad: "Ta metryka będzie dostępna jako wyzwalacz po włączeniu nowych automatyzacji." };
    zrodlo = { rodzaj: "metryka", metryka: m.data };
  } else {
    if (!dane.zdarzenie || !(dane.zdarzenie in ZDARZENIA_WYZWALACZA)) return { ok: false, blad: "Nieznany wyzwalacz." };
    const zdarzenie = dane.zdarzenie as ZdarzenieWyzwalacza;
    let listId: string | undefined;
    if (zdarzenie === "list.joined") {
      if (!dane.listId || !UUID.test(dane.listId)) return { ok: false, blad: "Wyzwalacz „dołączenie do listy” wymaga wybrania listy." };
      const { rows } = await getPool().query("select 1 from lists where tenant_id = $1 and id = $2", [tenantId, dane.listId]);
      if (!rows[0]) return { ok: false, blad: "Wybrana lista nie istnieje." };
      listId = dane.listId;
    }
    zrodlo = zrodloZV1(zdarzenie, listId);
  }
  const graf = pustyGraf(zrodlo, undefined, { ponowneWejscieDostepne: await ponowneWejscieDostepne(getPool()) });
  const { rows } = await getPool().query(
    `insert into flows (tenant_id, name, draft) values ($1, $2, $3)
     on conflict (tenant_id, name) do nothing returning id`,
    [tenantId, dane.name.trim(), JSON.stringify(grafDoZapisu(graf))],
  );
  if (!rows[0]) return { ok: false, blad: "Automatyzacja o tej nazwie już istnieje." };
  return { ok: true, id: rows[0].id };
}

/** `integracja|nazwa` z pola formularza -> klucz naturalny metryki. */
export function rozbierzKluczMetryki(klucz: string): MetrykaRef | null {
  const i = klucz.indexOf("|");
  return i > 0 ? { integracja: klucz.slice(0, i), nazwa: klucz.slice(i + 1) } : null;
}

/** Metryki tenanta do wyboru wyzwalacza (port katalogu; po scaleniu A: tabela metrics). */
export async function metrykiDoWyzwalacza(tenantId: string): Promise<(MetrykaKatalogu & { klucz: string; etykieta: string })[]> {
  const lista = await katalogMetryk().lista(getPool(), tenantId);
  return lista
    // bez MIDREV_GRAF_V2 wyzwalaczem moga byc tylko metryki wbudowane v1 (rollback kodu)
    .filter((m) => config().MIDREV_GRAF_V2 || zdarzenieV1(m) !== null)
    .map((m) => ({ ...m, klucz: kluczMetryki(m), etykieta: etykietaMetryki(m) }))
    .sort((a, b) => a.etykieta.localeCompare(b.etykieta, "pl"));
}

// ── Biblioteka gotowych automatyzacji ───────────────────────────────────────

function dokumentZTekstu(akapity: string[], przycisk?: { tekst: string; link: string }): DokumentMaila {
  const d = pustyDokument();
  const bloki = akapity.map((html) => ({ ...nowyBlok("tekst"), html }));
  if (przycisk) bloki.push({ ...nowyBlok("przycisk"), tekst: przycisk.tekst, link: przycisk.link } as any);
  return { ...d, bloki };
}

interface SzablonEmaila {
  nazwa: string;
  temat: string;
  akapity: string[];
  przycisk?: { tekst: string; sciezka: string };
}

export interface SzablonBiblioteki {
  klucz: string;
  name: string;
  opis: string;
  zdarzenie: ZdarzenieWyzwalacza;
  kroki: string[];
  /** buduje graf; `email(i)` zwraca id wiadomosci o indeksie i z `emaile` */
  zbuduj: (email: (i: number) => string) => Graf;
  emaile: SzablonEmaila[];
  wyjsciePoZakupie?: boolean;
}

const N = (typ: Wezel["typ"], i: number) => `${typ}_${i}`;

export const BIBLIOTEKA: SzablonBiblioteki[] = [
  {
    klucz: "powitanie",
    name: "Powitanie: 3 maile",
    opis: "Po zapisie z formularza: mail od razu, po 2 dniach drugi (tylko dla tych, którzy nie kupili), po kolejnych 3 dniach trzeci.",
    zdarzenie: "popup.submitted",
    kroki: ["Zapis z formularza", "Mail 1 od razu", "2 dni", "Kupił?", "Mail 2", "3 dni", "Mail 3"],
    emaile: [
      { nazwa: "Mail 1: powitanie", temat: "Witaj! Dobrze, że jesteś", akapity: ["Cześć!", "Dziękujemy za zapis. Od teraz jako pierwsza osoba dowiesz się o nowościach i promocjach.", "Na dobry początek zajrzyj do sklepu:"], przycisk: { tekst: "Zobacz sklep", sciezka: "" } },
      { nazwa: "Mail 2: bestsellery", temat: "Od czego zacząć? Nasze bestsellery", akapity: ["Cześć!", "Nie wiesz, co wybrać? Zebraliśmy produkty, które klienci kupują najczęściej i do których wracają."], przycisk: { tekst: "Zobacz bestsellery", sciezka: "" } },
      { nazwa: "Mail 3: historia marki", temat: "Kim jesteśmy i dlaczego to robimy", akapity: ["Cześć!", "Kilka słów o tym, skąd się wzięliśmy i co jest dla nas ważne. Jeśli masz pytanie, po prostu odpisz na tego maila."], przycisk: { tekst: "Poznaj nas", sciezka: "" } },
    ],
    zbuduj: (email) => ({
      wersja: 2,
      start: "wyzwalacz",
      ustawienia: { wyjsciePoZakupie: false, ponowneWejscie: { tryb: "raz" } },
      wezly: [
        { id: "wyzwalacz", typ: "wyzwalacz", zrodlo: zrodloZV1("popup.submitted"), links: { next: N("email", 1) } },
        { id: N("email", 1), typ: "email", emailId: email(0), links: { next: N("opoznienie", 1) } },
        { id: N("opoznienie", 1), typ: "opoznienie", ilosc: 2, jednostka: "dni", links: { next: N("warunek", 1) } },
        { id: N("warunek", 1), typ: "warunek", etykieta: "Kupił po zapisie?", regula: { rodzaj: "kupil_od_wejscia" }, links: { next_if_true: N("koniec", 1), next_if_false: N("email", 2) } },
        { id: N("koniec", 1), typ: "koniec" },
        { id: N("email", 2), typ: "email", emailId: email(1), links: { next: N("opoznienie", 2) } },
        { id: N("opoznienie", 2), typ: "opoznienie", ilosc: 3, jednostka: "dni", links: { next: N("email", 3) } },
        { id: N("email", 3), typ: "email", emailId: email(2), links: { next: N("koniec", 2) } },
        { id: N("koniec", 2), typ: "koniec" },
      ],
    }),
  },
  {
    klucz: "po_zakupie",
    name: "Po zakupie",
    opis: "Godzinę po zamówieniu podziękowanie; po 7 dniach polecane produkty, ale tylko dla osób, które kliknęły w pierwszy mail.",
    zdarzenie: "order.created",
    kroki: ["Zamówienie", "1 godz.", "Podziękowanie", "7 dni", "Kliknął?", "Polecane"],
    emaile: [
      { nazwa: "Podziękowanie", temat: "Dziękujemy za zamówienie", akapity: ["Cześć!", "Dziękujemy za zakup. Zamówienie jest już u nas i zajmujemy się nim od razu.", "Gdyby cokolwiek było niejasne, po prostu odpisz na tę wiadomość."], przycisk: { tekst: "Zobacz sklep", sciezka: "" } },
      { nazwa: "Polecane produkty", temat: "Do tego zamówienia klienci dobierają…", akapity: ["Cześć!", "Zobacz, co klienci najczęściej dobierają do takiego zamówienia jak Twoje."], przycisk: { tekst: "Zobacz polecane", sciezka: "/polecane" } },
    ],
    zbuduj: (email) => ({
      wersja: 2,
      start: "wyzwalacz",
      ustawienia: { wyjsciePoZakupie: false, ponowneWejscie: { tryb: "raz" } },
      wezly: [
        { id: "wyzwalacz", typ: "wyzwalacz", zrodlo: zrodloZV1("order.created"), links: { next: N("opoznienie", 1) } },
        { id: N("opoznienie", 1), typ: "opoznienie", ilosc: 1, jednostka: "godziny", links: { next: N("email", 1) } },
        { id: N("email", 1), typ: "email", emailId: email(0), links: { next: N("opoznienie", 2) } },
        { id: N("opoznienie", 2), typ: "opoznienie", ilosc: 7, jednostka: "dni", links: { next: N("warunek", 1) } },
        { id: N("warunek", 1), typ: "warunek", etykieta: "Kliknął w podziękowanie?", regula: { rodzaj: "kliknal_poprzedni" }, links: { next_if_true: N("email", 2), next_if_false: N("koniec", 1) } },
        { id: N("email", 2), typ: "email", emailId: email(1), links: { next: N("koniec", 2) } },
        { id: N("koniec", 1), typ: "koniec" },
        { id: N("koniec", 2), typ: "koniec" },
      ],
    }),
  },
  {
    klucz: "win_back",
    name: "Win-back po 90 dniach",
    opis: "90 dni po zamówieniu sprawdza, czy było kolejne. Jeśli nie, wysyła mail z zachętą do powrotu. Kto kupi w trakcie, wypada z automatyzacji.",
    zdarzenie: "order.created",
    kroki: ["Zamówienie", "90 dni", "Kupił ponownie?", "Mail „wróć”"],
    emaile: [
      { nazwa: "Wróć do nas", temat: "Dawno Cię nie było", akapity: ["Cześć!", "Minęło trochę czasu od Twojego ostatniego zamówienia. Sporo się u nas zmieniło. Zobacz, co nowego."], przycisk: { tekst: "Zobacz nowości", sciezka: "" } },
    ],
    wyjsciePoZakupie: true,
    zbuduj: (email) => ({
      wersja: 2,
      start: "wyzwalacz",
      ustawienia: { wyjsciePoZakupie: true, ponowneWejscie: { tryb: "raz" } },
      wezly: [
        { id: "wyzwalacz", typ: "wyzwalacz", zrodlo: zrodloZV1("order.created"), links: { next: N("opoznienie", 1) } },
        { id: N("opoznienie", 1), typ: "opoznienie", ilosc: 90, jednostka: "dni", links: { next: N("warunek", 1) } },
        { id: N("warunek", 1), typ: "warunek", etykieta: "Kupił ponownie?", regula: { rodzaj: "kupil_od_wejscia" }, links: { next_if_true: N("koniec", 1), next_if_false: N("email", 1) } },
        { id: N("koniec", 1), typ: "koniec" },
        { id: N("email", 1), typ: "email", emailId: email(0), links: { next: N("koniec", 2) } },
        { id: N("koniec", 2), typ: "koniec" },
      ],
    }),
  },
];

export async function utworzZBiblioteki(tenantId: string, klucz: string, opcje: { sklepUrl: string }): Promise<Wynik<{ id: string }>> {
  const szablon = BIBLIOTEKA.find((s) => s.klucz === klucz);
  if (!szablon) return { ok: false, blad: "Nieznany szablon." };
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    // nazwa: przy powtorce dopisujemy numer, zamiast odmawiac (drugi sklep tej samej agencji)
    const { rows: nazwy } = await klient.query("select name from flows where tenant_id = $1 and name like $2", [tenantId, `${szablon.name}%`]);
    const zajete = new Set(nazwy.map((r) => r.name));
    // Nazwa wolna w chwili odczytu moze zniknac przed insertem (dwa klikniecia, dwie karty):
    // insert z `on conflict do nothing` i kolejny numer, zamiast wyjatku 23505 (review).
    let flowId: string | null = null;
    for (let i = 1; !flowId && i <= 50; i++) {
      const name = i === 1 ? szablon.name : `${szablon.name} (${i})`;
      if (zajete.has(name)) continue;
      const { rows: f } = await klient.query(
        "insert into flows (tenant_id, name, draft) values ($1, $2, $3) on conflict (tenant_id, name) do nothing returning id",
        [tenantId, name, JSON.stringify(grafDoZapisu(pustyGraf(szablon.zdarzenie)))],
      );
      flowId = f[0]?.id ?? null;
    }
    if (!flowId) {
      await klient.query("rollback");
      return { ok: false, blad: "Nie udało się nadać nazwy: za dużo automatyzacji z tego szablonu." };
    }
    const ids: string[] = [];
    for (const e of szablon.emaile) {
      const dokument = dokumentZTekstu(
        e.akapity,
        e.przycisk ? { tekst: e.przycisk.tekst, link: `${opcje.sklepUrl.replace(/\/$/, "")}${e.przycisk.sciezka}` } : undefined,
      );
      const render = renderujDokument(dokument);
      const { rows } = await klient.query(
        `insert into journeys (tenant_id, name, subject, content, flow_id, node_id)
         values ($1, $2, $3, $4, $5, '') returning id`,
        [tenantId, e.nazwa, e.temat, JSON.stringify({ html: render.html, wersjaSchematu: dokument.wersjaSchematu, style: dokument.style, bloki: dokument.bloki }), flowId],
      );
      ids.push(rows[0].id);
    }
    const graf = szablon.zbuduj((i) => ids[i]);
    // node_id wiadomosci = id wezla, ktory ja wysyla (do sciezki osoby i statystyk)
    for (const w of graf.wezly) {
      if (w.typ === "email") await klient.query("update journeys set node_id = $3 where tenant_id = $1 and id = $2", [tenantId, w.emailId, w.id]);
    }
    await klient.query("update flows set draft = $3, updated_at = now() where tenant_id = $1 and id = $2", [tenantId, flowId, JSON.stringify(grafDoZapisu(graf))]);
    // odczyt zwrotny: graf w bazie przechodzi bramke z realnymi wiadomosciami
    const widok = await pobierzAutomatyzacjeKlientem(klient, tenantId, flowId);
    if (!widok || widok.bramka.length) {
      await klient.query("rollback");
      return { ok: false, blad: `Szablon nie przeszedł bramki: ${widok?.bramka[0]?.tresc ?? "brak automatyzacji po zapisie"}` };
    }
    await klient.query("commit");
    return { ok: true, id: flowId };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

// ── Odczyt jednej automatyzacji ─────────────────────────────────────────────

export interface WiadomoscFlow {
  id: string;
  nazwa: string;
  temat: string;
  maTresc: boolean;
  /** journeys.draft_version (0026): kontrola wspolbieznosci zapisu i publikacji */
  wersja: number;
}

export interface WidokAutomatyzacji {
  id: string;
  name: string;
  status: StatusAutomatyzacji;
  graf: Graf;
  live: Graf | null;
  liveVersion: number | null;
  draftVersion: number;
  niepublikowane: boolean;
  emaile: Record<string, WiadomoscFlow>;
  listy: { id: string; name: string }[];
  segmenty: { id: string; name: string }[];
  /** metryki tenanta do wyboru wyzwalacza */
  metryki: { integracja: string; nazwa: string; canTrigger: boolean; etykieta: string }[];
  /** tryby ponownego wejscia inne niz "raz" (po 0036 i fladze) */
  ponowneWejscieDostepne: boolean;
  /** filtr wyzwalacza i metryki spoza wbudowanych (flaga MIDREV_GRAF_V2) */
  grafV2Dostepny: boolean;
  bramka: BladGrafu[];
  updatedAt: Date;
}

type Klient = Kl;

async function kontekstWalidacji(klient: Klient, tenantId: string, flowId: string) {
  const [emaile, listy, segmenty] = await Promise.all([
    klient.query("select id, name, subject, draft_version, coalesce(content->>'html', '') <> '' as ma_tresc from journeys where tenant_id = $1 and flow_id = $2 order by created_at", [tenantId, flowId]),
    klient.query("select id, name from lists where tenant_id = $1 order by name", [tenantId]),
    klient.query("select id, name from segments where tenant_id = $1 order by name", [tenantId]),
  ]);
  const mapaEmaili: Record<string, WiadomoscFlow> = {};
  for (const e of emaile.rows) mapaEmaili[e.id] = { id: e.id, nazwa: e.name, temat: e.subject ?? "", maTresc: e.ma_tresc, wersja: e.draft_version };
  const [metryki, ponowne] = await Promise.all([
    katalogMetryk().lista(klient as unknown as Parameters<ReturnType<typeof katalogMetryk>["lista"]>[0], tenantId),
    ponowneWejscieDostepne(klient),
  ]);
  const ctx: KontekstWalidacji = {
    emaile: Object.fromEntries(emaile.rows.map((e) => [e.id, { temat: e.subject ?? "", maTresc: e.ma_tresc }])),
    listy: new Set(listy.rows.map((l) => l.id)),
    segmenty: new Set(segmenty.rows.map((s) => s.id)),
    metryki: new Map(metryki.map((m) => [kluczMetryki(m), { canTrigger: m.canTrigger }])),
    ponowneWejscieDostepne: ponowne,
    grafV2Dostepny: config().MIDREV_GRAF_V2,
  };
  return { mapaEmaili, listy: listy.rows, segmenty: segmenty.rows, metryki, ponowneWejscieDostepne: ponowne, grafV2Dostepny: config().MIDREV_GRAF_V2, ctx };
}

async function pobierzAutomatyzacjeKlientem(klient: Klient, tenantId: string, flowId: string): Promise<WidokAutomatyzacji | null> {
  if (!UUID.test(flowId)) return null;
  const { rows } = await klient.query(
    `select id, name, status, draft, draft_version, live, live_version, updated_at,
            ${SQL_NIEPUBLIKOWANE} as niepublikowane
       from flows f where tenant_id = $1 and id = $2`,
    [tenantId, flowId],
  );
  const f = rows[0];
  if (!f) return null;
  const draft = schematGrafu.safeParse(f.draft);
  if (!draft.success) return null;
  const live = f.live ? schematGrafu.safeParse(f.live) : null;
  const { mapaEmaili, listy, segmenty, metryki, ponowneWejscieDostepne: ponowne, grafV2Dostepny, ctx } = await kontekstWalidacji(klient, tenantId, flowId);
  return {
    grafV2Dostepny,
    metryki: metryki.map((m) => ({ integracja: m.integracja, nazwa: m.nazwa, canTrigger: m.canTrigger, etykieta: etykietaMetryki(m) })),
    ponowneWejscieDostepne: ponowne,
    id: f.id,
    name: f.name,
    status: f.status,
    graf: draft.data,
    live: live?.success ? live.data : null,
    liveVersion: f.live_version,
    draftVersion: f.draft_version,
    niepublikowane: f.niepublikowane,
    emaile: mapaEmaili,
    listy,
    segmenty,
    bramka: zwalidujGraf(draft.data, ctx).bledy,
    updatedAt: f.updated_at,
  };
}

export function pobierzAutomatyzacje(tenantId: string, flowId: string) {
  return pobierzAutomatyzacjeKlientem(getPool(), tenantId, flowId);
}

// ── Szkic ───────────────────────────────────────────────────────────────────

export type WynikSzkicu =
  | { ok: true; bramka: BladGrafu[]; zapisanoO: string; draftVersion: number; niepublikowane: boolean }
  | { ok: false; blad: string; konflikt?: boolean };

/**
 * Zapis grafu szkicu z optymistyczna wspolbieznoscia: klient podaje `draft_version`, ktory
 * widzial; zapis przechodzi tylko, gdy w bazie jest wciaz ta sama wersja. Dwie karty (albo
 * dwie osoby) nie nadpisza sobie nawzajem grafu po cichu (review).
 * Nazwa automatyzacji ma osobny zapis (`zmienNazwe`): duplikat nazwy nie moze blokowac
 * zapisu grafu.
 */
export async function zapiszSzkic(
  tenantId: string,
  flowId: string,
  zmiany: { graf: unknown; oczekiwanaWersja: number },
): Promise<WynikSzkicu> {
  if (!UUID.test(flowId)) return { ok: false, blad: "Automatyzacja nie istnieje." };
  if (!Number.isInteger(zmiany.oczekiwanaWersja)) return { ok: false, blad: "Brak wersji szkicu. Odśwież stronę." };
  let dane = zmiany.graf;
  if (typeof dane === "string") {
    if (dane.length > 500_000) return { ok: false, blad: "Definicja jest za duża (limit 500 kB)." };
    try {
      dane = JSON.parse(dane);
    } catch {
      return { ok: false, blad: "Definicja przyszła uszkodzona. Odśwież stronę." };
    }
  }
  const parsed = schematGrafu.safeParse(dane);
  if (!parsed.success) {
    const p = parsed.error.issues[0];
    return { ok: false, blad: `Definicja nie przeszła walidacji (${p?.path.join(".") || "graf"}: ${p?.message ?? "błąd"}).` };
  }
  const graf: Graf = parsed.data;
  // Szkic w v2 przed wlaczeniem MIDREV_GRAF_V2 = definicja, ktorej stary kod po rollbacku nie
  // przeczyta. Ponowne wejscie ma osobna bramke (publikacja), bo zapisuje sie w ustawieniach.
  const v2 = funkcjeWymagajaceV2(graf);
  if (v2.length && !config().MIDREV_GRAF_V2) {
    return { ok: false, blad: `${v2.join(" i ")} będzie dostępne po włączeniu nowych automatyzacji. Zmiana nie została zapisana.` };
  }
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query("select draft_version from flows where tenant_id = $1 and id = $2 for no key update", [tenantId, flowId]);
    if (!rows[0]) {
      await klient.query("rollback");
      return { ok: false, blad: "Automatyzacja nie istnieje." };
    }
    if (rows[0].draft_version !== zmiany.oczekiwanaWersja) {
      await klient.query("rollback");
      return { ok: false, konflikt: true, blad: "Ktoś w międzyczasie zmienił tę automatyzację (inna karta albo osoba). Odśwież stronę, żeby zobaczyć aktualną wersję; ta zmiana nie została zapisana." };
    }
    // kazdy wezel e-mail musi wskazywac wiadomosc TEJ automatyzacji tego tenanta:
    // inaczej spreparowana definicja wysylalaby cudze tresci
    const emailIds = graf.wezly.filter((w): w is Extract<Wezel, { typ: "email" }> => w.typ === "email").map((w) => w.emailId);
    if (emailIds.length) {
      const { rows: swoje } = await klient.query(
        "select id from journeys where tenant_id = $1 and flow_id = $2 and id = any($3::uuid[])",
        [tenantId, flowId, emailIds],
      );
      if (swoje.length !== new Set(emailIds).size) {
        await klient.query("rollback");
        return { ok: false, blad: "Krok e-mail wskazuje wiadomość spoza tej automatyzacji." };
      }
    }
    for (const w of graf.wezly) {
      if (w.typ === "email") await klient.query("update journeys set node_id = $3 where tenant_id = $1 and id = $2 and node_id is distinct from $3", [tenantId, w.emailId, w.id]);
    }
    const { rows: zapis } = await klient.query(
      `update flows set draft = $3, draft_version = draft_version + 1, updated_at = now()
        where tenant_id = $1 and id = $2 and draft_version = $4 returning draft, draft_version`,
      [tenantId, flowId, JSON.stringify(grafDoZapisu(graf)), zmiany.oczekiwanaWersja],
    );
    if (!zapis[0] || kanonicznyJson(zapis[0].draft) !== kanonicznyJson(grafDoZapisu(graf))) {
      await klient.query("rollback");
      return { ok: false, blad: "Zapis nie zgadza się z odczytem z bazy. Odśwież stronę." };
    }
    // Sieroty: wiadomosci utworzone "+ e-mail" i usuniete z kanwy. Tylko te, ktorych nie
    // wskazuje zadna wersja ani wiadomosc wyslana (atrybucja ma do nich klucz obcy), i starsze
    // niz godzina: swiezo utworzona wiadomosc moze jeszcze czekac na zapis grafu z innej karty.
    await klient.query(
      `delete from journeys j
        where j.tenant_id = $1 and j.flow_id = $2 and j.created_at < now() - interval '1 hour'
          and not (j.id = any($3::uuid[]))
          and not exists (select 1 from flow_versions v where v.tenant_id = j.tenant_id and v.flow_id = j.flow_id and v.emails ? j.id::text)
          and not exists (select 1 from messages m where m.tenant_id = j.tenant_id and m.source_type = 'journey' and m.source_id = j.id)
          and not exists (select 1 from attributions a where a.tenant_id = j.tenant_id and a.journey_id = j.id)`,
      [tenantId, flowId, emailIds],
    );
    const { ctx } = await kontekstWalidacji(klient, tenantId, flowId);
    const niepublikowane = await czyNiepublikowane(klient, tenantId, flowId);
    await klient.query("commit");
    return { ok: true, bramka: zwalidujGraf(graf, ctx).bledy, zapisanoO: new Date().toISOString(), draftVersion: zapis[0].draft_version, niepublikowane };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/** Zmiana nazwy automatyzacji, osobno od grafu. Duplikat = czytelna odmowa, nie wyjatek. */
export async function zmienNazwe(tenantId: string, flowId: string, name: unknown): Promise<Wynik<{ name: string }>> {
  if (!UUID.test(flowId)) return { ok: false, blad: "Automatyzacja nie istnieje." };
  if (typeof name !== "string") return { ok: false, blad: "Nazwa musi być tekstem." };
  const czysta = name.trim();
  const blad = sprawdzNazwe(czysta);
  if (blad) return { ok: false, blad };
  try {
    const { rows } = await getPool().query(
      "update flows set name = $3, updated_at = now() where tenant_id = $1 and id = $2 returning name",
      [tenantId, flowId, czysta],
    );
    if (!rows[0]) return { ok: false, blad: "Automatyzacja nie istnieje." };
    if (rows[0].name !== czysta) return { ok: false, blad: "Zapis nazwy nie zgadza się z odczytem z bazy." };
    return { ok: true, name: czysta };
  } catch (e) {
    if (jestDuplikatemNazwy(e)) return { ok: false, blad: "Automatyzacja o tej nazwie już istnieje. Nazwa nie została zmieniona." };
    throw e;
  }
}

// ── Wiadomosci (wezly e-mail) ───────────────────────────────────────────────

export async function utworzWiadomosc(tenantId: string, flowId: string, nazwa: string): Promise<Wynik<{ id: string }>> {
  if (!UUID.test(flowId)) return { ok: false, blad: "Automatyzacja nie istnieje." };
  const czysta = nazwa.trim().slice(0, 200) || "Wiadomość";
  const { rows: ile } = await getPool().query("select count(*)::int as n from journeys where tenant_id = $1 and flow_id = $2", [tenantId, flowId]);
  if ((ile[0]?.n ?? 0) >= LIMIT_WIADOMOSCI) {
    return { ok: false, blad: `Automatyzacja ma już ${LIMIT_WIADOMOSCI} wiadomości. Usuń nieużywane kroki e-mail (sprzątają się godzinę po usunięciu z kanwy).` };
  }
  const { rows } = await getPool().query(
    `insert into journeys (tenant_id, name, subject, content, flow_id, node_id)
     select $1, $3, '', '{}'::jsonb, f.id, '' from flows f where f.tenant_id = $1 and f.id = $2
     returning id`,
    [tenantId, flowId, czysta],
  );
  if (!rows[0]) return { ok: false, blad: "Automatyzacja nie istnieje." };
  return { ok: true, id: rows[0].id };
}

export async function wiadomoscFlow(tenantId: string, flowId: string, emailId: string) {
  if (!UUID.test(flowId) || !UUID.test(emailId)) return null;
  const { rows } = await getPool().query(
    `select j.id, j.name, j.subject, j.content, j.node_id, j.draft_version, f.name as flow_name, f.status as flow_status
       from journeys j join flows f on f.tenant_id = j.tenant_id and f.id = j.flow_id
      where j.tenant_id = $1 and j.flow_id = $2 and j.id = $3`,
    [tenantId, flowId, emailId],
  );
  const w = rows[0];
  if (!w) return null;
  return { id: w.id, nazwa: w.name as string, temat: (w.subject ?? "") as string, content: (w.content ?? {}) as Record<string, unknown>, nodeId: w.node_id as string, flowName: w.flow_name as string, flowStatus: w.flow_status as StatusAutomatyzacji, wersja: w.draft_version as number };
}

/**
 * Zapis wiadomosci kroku: temat, nazwa robocza i dokument blokow (ten sam edytor,
 * ta sama walidacja i render co w kampaniach). Tresc dziala od nastepnej wysylki:
 * wiadomosci juz zbudowane maja wlasny HTML (AD-32).
 */
export async function zapiszWiadomosc(
  tenantId: string,
  flowId: string,
  emailId: string,
  zmiany: { nazwa?: string; temat?: string; dokumentJson?: string; oczekiwanaWersja?: number },
): Promise<Wynik<{ uwagi: string[]; zapisanoO: string; niepublikowane: boolean; wersja: number }> | { ok: false; blad: string; konflikt: true }> {
  if (!UUID.test(flowId) || !UUID.test(emailId)) return { ok: false, blad: "Wiadomość nie istnieje." };
  let dokument: DokumentMaila | null = null;
  if (zmiany.dokumentJson !== undefined) {
    const p = przygotujDokument(zmiany.dokumentJson);
    if (!p.ok) return p;
    dokument = p.dokument;
  }
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      "select name, subject, content, draft_version from journeys where tenant_id = $1 and flow_id = $2 and id = $3 for no key update",
      [tenantId, flowId, emailId],
    );
    if (!rows[0]) {
      await klient.query("rollback");
      return { ok: false, blad: "Wiadomość nie istnieje." };
    }
    // Kontrola wspolbieznosci (review runda 2, #6): zapis z nieaktualna wersja nie nadpisuje
    // zmiany z innej karty. Wolajacy bez wersji (skrypty, testy) zapisuje bez kontroli.
    if (zmiany.oczekiwanaWersja !== undefined && rows[0].draft_version !== zmiany.oczekiwanaWersja) {
      await klient.query("rollback");
      return { ok: false, konflikt: true, blad: "Ktoś w międzyczasie zmienił tę wiadomość (inna karta albo osoba). Odśwież stronę; ta zmiana nie została zapisana." };
    }
    const nazwa = zmiany.nazwa !== undefined ? zmiany.nazwa.trim().slice(0, 200) || "Wiadomość" : String(rows[0].name);
    const temat = zmiany.temat !== undefined ? zmiany.temat.trim() : String(rows[0].subject ?? "");
    if (temat.length > 250) {
      await klient.query("rollback");
      return { ok: false, blad: "Temat jest za długi (maks. 250 znaków)." };
    }
    let nowaTresc: Record<string, unknown> | null = null;
    let uwagi: string[] = [];
    let html = String((rows[0].content as any)?.html ?? "");
    if (dokument) {
      const render = renderujDokument(dokument);
      uwagi = render.uwagi;
      html = render.html;
      nowaTresc = { html, wersjaSchematu: dokument.wersjaSchematu, style: dokument.style, bloki: dokument.bloki };
    }
    await klient.query(
      `update journeys set name = $4, subject = $5,
              content = case when $6::jsonb is null then content else coalesce(content, '{}'::jsonb) || $6::jsonb end,
              draft_version = draft_version + 1, updated_at = now()
        where tenant_id = $1 and flow_id = $2 and id = $3`,
      [tenantId, flowId, emailId, nazwa, temat, nowaTresc ? JSON.stringify(nowaTresc) : null],
    );
    // odczyt zwrotny ZAPISANEGO rekordu: silnik wysyla content.html
    const { rows: po } = await klient.query(
      "select name, subject, content->>'html' as html, content->'bloki' as bloki, draft_version from journeys where tenant_id = $1 and id = $2",
      [tenantId, emailId],
    );
    const z = po[0];
    if (!z || z.name !== nazwa || z.subject !== temat || (z.html ?? "") !== html || (nowaTresc && kanonicznyJson(z.bloki) !== kanonicznyJson(nowaTresc.bloki))) {
      await klient.query("rollback");
      return { ok: false, blad: "Zapis wiadomości nie zgadza się z odczytem z bazy. Odśwież stronę." };
    }
    const niepublikowane = await czyNiepublikowane(klient, tenantId, flowId);
    await klient.query("commit");
    return { ok: true, uwagi, zapisanoO: new Date().toISOString(), niepublikowane, wersja: z.draft_version };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

export function dokumentWiadomosci(content: unknown) {
  return wczytajDokument(content);
}


// ── Migawka tresci i publikacja ─────────────────────────────────────────────

/**
 * `szablon: "liquid"`: migawka opublikowana PO wprowadzeniu zmiennych i zwalidowana
 * (`sprawdzSzablon`). Tylko takie silnik renderuje; starsze wersje wychodza jak dotad.
 */
type Migawka = Record<string, { subject: string; html: string; szablon?: "liquid" }>;

/** Temat i HTML kazdej wiadomosci wskazanej w grafie, w chwili publikacji (0025). */
async function migawkaTresci(klient: Kl, tenantId: string, flowId: string, graf: Graf): Promise<Migawka> {
  const ids = graf.wezly.filter((w): w is Extract<Wezel, { typ: "email" }> => w.typ === "email").map((w) => w.emailId);
  if (!ids.length) return {};
  const { rows } = await klient.query(
    `select id, coalesce(subject, '') as subject, coalesce(content->>'html', '') as html
       from journeys where tenant_id = $1 and flow_id = $2 and id = any($3::uuid[])`,
    [tenantId, flowId, ids],
  );
  // znacznik tylko przy uzyciu zmiennych: migawka bez nich jest identyczna jak dotad (brak
  // zbednej nowej wersji przy publikacji starego flow), a render i tak bylby tozsamoscia
  return Object.fromEntries(rows.map((r) => [r.id, maZmienne(r.subject) || maZmienne(r.html)
    ? { subject: r.subject, html: r.html, szablon: "liquid" as const }
    : { subject: r.subject, html: r.html }]));
}

/**
 * Publikacja szkicu (graf + migawka tresci maili) jako nowa wersja live. Wymaga
 * zablokowanego wiersza flows (`for update`) w transakcji `klient`. Zwraca numer wersji
 * albo bledy bramki. Gdy nic sie nie zmienilo, nie tworzy nowej wersji.
 */
async function opublikujWTransakcji(
  klient: Kl,
  tenantId: string,
  flowId: string,
  f: { draft: unknown; live: unknown; live_version: number | null; draft_version: number },
  widziane?: WersjeWidziane,
): Promise<{ ok: true; wersja: number; nowa: boolean; graf: Graf } | { ok: false; bledy: BladGrafu[]; konflikt?: string }> {
  const { ctx, mapaEmaili } = await kontekstWalidacji(klient, tenantId, flowId);
  if (widziane) {
    // Publikujacy musi widziec DOKLADNIE to, co publikuje (review runda 2, #6): graf i kazda
    // wiadomosc w wersji, ktora mial na ekranie. Inaczej wypuscilby zmiane z innej karty.
    const graf0 = schematGrafu.safeParse(f.draft);
    const ids = graf0.success ? graf0.data.wezly.filter((w): w is Extract<Wezel, { typ: "email" }> => w.typ === "email").map((w) => w.emailId) : [];
    const zmienione = f.draft_version !== widziane.draft || ids.some((id) => mapaEmaili[id]?.wersja !== widziane.emaile?.[id]);
    if (zmienione) {
      return { ok: false, bledy: [], konflikt: "Ktoś w międzyczasie zmienił tę automatyzację albo jedną z jej wiadomości. Odśwież stronę i sprawdź zmiany przed publikacją." };
    }
  }
  const { graf, bledy } = zwalidujGraf(f.draft, ctx);
  if (!graf || bledy.length) return { ok: false, bledy };
  const migawka = await migawkaTresci(klient, tenantId, flowId, graf);
  // zmienne {{ }} w temacie i tresci: blad skladni, nieznany filtr, zablokowany znacznik
  // wychodza TERAZ, na kanwie, a nie jako przerwane sciezki ludzi przy wysylce
  const bledySzablonu: BladGrafu[] = [];
  for (const w of graf.wezly) {
    if (w.typ !== "email" || !migawka[w.emailId]) continue;
    const b = sprawdzSzablon(migawka[w.emailId].subject, migawka[w.emailId].html);
    if (b) bledySzablonu.push({ wezelId: w.id, tresc: `Błąd w zmiennych wiadomości: ${b}` });
  }
  if (bledySzablonu.length) return { ok: false, bledy: bledySzablonu };
  let staraMigawka: Migawka | null = null;
  if (f.live_version) {
    const { rows } = await klient.query("select emails from flow_versions where tenant_id = $1 and flow_id = $2 and version = $3", [tenantId, flowId, f.live_version]);
    staraMigawka = rows[0]?.emails ?? null;
  }
  // porownanie po normalizacji (v1 w bazie vs v2 w pamieci to ten sam graf)
  const staryLive = f.live ? schematGrafu.safeParse(f.live) : null;
  const nowa = !staryLive?.success || kanonicznyJson(staryLive.data) !== kanonicznyJson(graf) || kanonicznyJson(staraMigawka) !== kanonicznyJson(migawka);
  const wersja: number = nowa ? (f.live_version ?? 0) + 1 : (f.live_version as number);
  if (nowa) {
    await klient.query(
      "insert into flow_versions (tenant_id, flow_id, version, definition, emails) values ($1, $2, $3, $4, $5)",
      [tenantId, flowId, wersja, JSON.stringify(grafDoZapisu(graf)), JSON.stringify(migawka)],
    );
  }
  const start = wyzwalaczGrafu(graf)!;
  const metricId = start.zrodlo.rodzaj === "metryka" ? await zrodloZdarzen().idMetryki(klient, tenantId, start.zrodlo.metryka) : null;
  await klient.query(
    "update flows set live = $3, live_version = $4, trigger_event = $5, trigger_metric_id = $6, updated_at = now() where tenant_id = $1 and id = $2",
    [tenantId, flowId, JSON.stringify(grafDoZapisu(graf)), wersja, triggerEventGrafu(graf), metricId],
  );
  // odczyt zwrotny: wersja w bazie ma dokladnie te migawke
  const { rows: po } = await klient.query(
    "select f.live_version, v.emails from flows f join flow_versions v on v.tenant_id = f.tenant_id and v.flow_id = f.id and v.version = f.live_version where f.tenant_id = $1 and f.id = $2",
    [tenantId, flowId],
  );
  if (po[0]?.live_version !== wersja || kanonicznyJson(po[0]?.emails) !== kanonicznyJson(migawka)) {
    throw new Error("publikacja: zapis wersji nie zgadza się z odczytem z bazy");
  }
  // Odczyt zwrotny ZAPISANEJ migawki (review #7): kazdy krok e-mail ma w bazie niepusty temat i tresc.
  const zapisana = po[0].emails as Migawka;
  for (const w of graf.wezly) {
    if (w.typ !== "email") continue;
    const e = zapisana[w.emailId];
    if (!e || !String(e.subject ?? "").trim() || !String(e.html ?? "").trim()) {
      throw new Error(`publikacja: zapisana migawka kroku ${w.id} nie ma tematu albo treści`);
    }
  }
  return { ok: true, wersja, nowa, graf };
}

export type DocelowyStatus = StatusAutomatyzacji;

/** Wersje, ktore operator mial na ekranie w chwili publikacji (graf + kazda wiadomosc). */
export interface WersjeWidziane {
  draft: number;
  emaile: Record<string, number>;
}

type WynikStatusu =
  | { ok: true; status: StatusAutomatyzacji; wersja: number | null; komunikat: string }
  | { ok: false; blad: string; bledy?: BladGrafu[] };

/**
 * Zmiana statusu na STAN DOCELOWY (nie "przelacz"): ponowiony submit nie odwraca decyzji.
 *  - szkic -> wlaczony: publikacja szkicu (bramka) + wlaczenie; granica active_since = teraz;
 *  - wstrzymany -> wlaczony: WZNOWIENIE. Wersja live bez zmian, bez bramki szkicu: wznowienie
 *    nie moze wymagac naprawienia polowicznej edycji (review). Zdarzenia z czasu przerwy nie wchodza;
 *  - wlaczony -> wstrzymany: nikt nie wchodzi, nikt sie nie rusza;
 *  - * -> szkic (wylaczenie): osoby w toku dostaja 'przerwany' z powodem.
 * Nowa wersja we wlaczonej automatyzacji to osobna akcja: `opublikuj`.
 */
export async function zmienStatus(tenantId: string, flowId: string, docelowy: DocelowyStatus, widziane?: WersjeWidziane): Promise<WynikStatusu> {
  if (!UUID.test(flowId)) return { ok: false, blad: "Automatyzacja nie istnieje." };
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query("select status, draft, draft_version, live, live_version from flows where tenant_id = $1 and id = $2 for no key update", [tenantId, flowId]);
    const f = rows[0];
    if (!f) {
      await klient.query("rollback");
      return { ok: false, blad: "Automatyzacja nie istnieje." };
    }
    const obecny: StatusAutomatyzacji = f.status;

    if (docelowy === "wlaczony") {
      if (obecny === "wlaczony") {
        await klient.query("rollback");
        return { ok: true, status: "wlaczony", wersja: f.live_version, komunikat: "Automatyzacja jest już włączona." };
      }
      let wersja: number = f.live_version;
      if (obecny === "szkic") {
        const pub = await opublikujWTransakcji(klient, tenantId, flowId, f, widziane);
        if (!pub.ok) {
          await klient.query("rollback");
          if (pub.konflikt) return { ok: false, blad: pub.konflikt };
          return { ok: false, blad: "Automatyzacji nie da się włączyć: popraw kroki oznaczone na kanwie.", bledy: pub.bledy };
        }
        wersja = pub.wersja;
      } else if (!f.live_version) {
        await klient.query("rollback");
        return { ok: false, blad: "Ta automatyzacja nie ma opublikowanej wersji do wznowienia." };
      }
      await klient.query(
        "update flows set status = 'wlaczony', active_since = now(), updated_at = now() where tenant_id = $1 and id = $2",
        [tenantId, flowId],
      );
      // kursor skanu wyzwalacza startuje od nowego active_since: zdarzenia z czasu przerwy i tak
      // nie wchodza, a stary kursor sprzed doby dawalby falszywy alert "skan zalegly"
      await klient.query("delete from flow_trigger_state where tenant_id = $1 and flow_id = $2", [tenantId, flowId]);
      if (obecny === "wstrzymany") {
        // Wiadomosc zbudowana przed dluga przerwa nie wychodzi fala po wznowieniu (review #2):
        // starsze niz doba koncza jako `suppressed` z powodem; swiezsze wychodza normalnie.
        await wygasKolejke(klient, tenantId, flowId, "przeterminowane_po_pauzie", "24 hours");
      }
      if (obecny === "szkic") {
        // Bezpiecznik: nikt nie moze czekac "w toku" z wejscia sprzed tego wlaczenia
        // (np. wejscie, ktore przemknelo sie przed wylaczeniem) - dostalby stary mail za tygodnie.
        await przerwijWToku(klient, tenantId, flowId, "wejście sprzed ponownego włączenia");
      }
      const { rows: po } = await klient.query("select status, live_version from flows where tenant_id = $1 and id = $2", [tenantId, flowId]);
      if (po[0]?.status !== "wlaczony" || po[0]?.live_version !== wersja) {
        await klient.query("rollback");
        return { ok: false, blad: "Zapis statusu nie zgadza się z odczytem z bazy." };
      }
      await klient.query("commit");
      return {
        ok: true, status: "wlaczony", wersja,
        komunikat: obecny === "wstrzymany"
          ? `Wznowiono na wersji ${wersja}. Zdarzenia z czasu wstrzymania nie wchodzą; osoby, które stały w miejscu, ruszają dalej.`
          : `Włączono (wersja ${wersja}). Reaguje na zdarzenia od tej chwili, nie wstecz.`,
      };
    }

    if (docelowy === "wstrzymany") {
      if (obecny !== "wlaczony") {
        await klient.query("rollback");
        return { ok: false, blad: obecny === "wstrzymany" ? "Automatyzacja jest już wstrzymana." : "Szkicu nie da się wstrzymać: nie jest włączony." };
      }
      await klient.query("update flows set status = 'wstrzymany', updated_at = now() where tenant_id = $1 and id = $2", [tenantId, flowId]);
      await klient.query("commit");
      return { ok: true, status: "wstrzymany", wersja: f.live_version, komunikat: "Wstrzymano. Nikt nie wchodzi i nikt się nie przesuwa; osoby w toku stoją w miejscu do wznowienia." };
    }

    // wylaczenie
    if (obecny === "szkic") {
      await klient.query("rollback");
      return { ok: true, status: "szkic", wersja: f.live_version, komunikat: "Automatyzacja jest już wyłączona." };
    }
    const przerwani = await przerwijWToku(klient, tenantId, flowId, "automatyzacja wyłączona");
    await klient.query("update flows set status = 'szkic', updated_at = now() where tenant_id = $1 and id = $2", [tenantId, flowId]);
    await klient.query("commit");
    return {
      ok: true, status: "szkic", wersja: f.live_version,
      komunikat: przerwani ? `Wyłączono. ${przerwani} os. w toku zakończyło ścieżkę bez kolejnych maili.` : "Wyłączono.",
    };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/**
 * Wiadomosci tej automatyzacji, ktore czekaja w kolejce (`queued`), przechodza w stan koncowy
 * `suppressed` z powodem, w TEJ SAMEJ transakcji co zmiana statusu (review runda 2, #1).
 * Samo pomijanie ich przy zajmowaniu partii nie wystarczalo: po ponownym "Wlacz" wychodzily.
 * `for update` czeka na wiersze, ktore wlasnie ktos rusza, a po blokadzie Postgres sprawdza
 * warunek `queued` ponownie: wiadomosc zajeta w miedzyczasie przez wysylke nie jest ruszana.
 */
async function wygasKolejke(klient: Kl, tenantId: string, flowId: string, powod: string, starszeNiz: string | null = null): Promise<number> {
  const { rows } = await klient.query(
    `select m.id from messages m
       join journeys j on j.tenant_id = m.tenant_id and j.id = m.source_id
      where m.tenant_id = $1 and m.source_type = 'journey' and j.flow_id = $2
        and m.current_state = 'queued'
        and ($3::interval is null or m.created_at < now() - $3::interval)
      order by m.id
      for update of m`,
    [tenantId, flowId, starszeNiz],
  );
  for (const r of rows) {
    await zapiszZdarzenie(klient as unknown as PoolClient, tenantId, r.id, "suppressed", { kiedy: "teraz", payload: { powod } });
  }
  return rows.length;
}

async function przerwijWToku(klient: Kl, tenantId: string, flowId: string, powod: string): Promise<number> {
  await wygasKolejke(klient, tenantId, flowId, "automatyzacja_wylaczona");
  const { rows } = await klient.query(
    `with przerwani as (
       update flow_participants set status = 'przerwany', exit_reason = $3, finished_at = now(), resume_at = null
        where tenant_id = $1 and flow_id = $2 and status = 'w_toku'
        returning id, profile_id, version, node_id
     )
     insert into flow_transitions (tenant_id, participant_id, flow_id, profile_id, version, from_node, to_node, kind, detail, occurred_at)
     select $1, p.id, $2, p.profile_id, p.version, p.node_id, null, 'przerwanie', jsonb_build_object('powod', $3::text), now()
       from przerwani p
     returning participant_id`,
    [tenantId, flowId, powod],
  );
  return rows.length;
}

/**
 * "Opublikuj zmiany" we wlaczonej albo wstrzymanej automatyzacji: szkic (graf i tresc
 * maili) staje sie nowa wersja. Osoby w toku koncza na swojej wersji; nowe wejscia
 * i ich kroki ida po nowej. Status sie nie zmienia.
 */
export async function opublikuj(tenantId: string, flowId: string, widziane?: WersjeWidziane): Promise<WynikStatusu> {
  if (!UUID.test(flowId)) return { ok: false, blad: "Automatyzacja nie istnieje." };
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query("select status, draft, draft_version, live, live_version from flows where tenant_id = $1 and id = $2 for no key update", [tenantId, flowId]);
    const f = rows[0];
    if (!f) {
      await klient.query("rollback");
      return { ok: false, blad: "Automatyzacja nie istnieje." };
    }
    if (f.status === "szkic") {
      await klient.query("rollback");
      return { ok: false, blad: "Szkic publikuje się przyciskiem „Włącz”." };
    }
    const pub = await opublikujWTransakcji(klient, tenantId, flowId, f, widziane);
    if (!pub.ok) {
      await klient.query("rollback");
      if (pub.konflikt) return { ok: false, blad: pub.konflikt };
      return { ok: false, blad: "Zmian nie da się opublikować: popraw kroki oznaczone na kanwie.", bledy: pub.bledy };
    }
    await klient.query("commit");
    return {
      ok: true, status: f.status, wersja: pub.wersja,
      komunikat: pub.nowa
        ? `Opublikowano wersję ${pub.wersja}. Osoby w toku kończą na wersji, z którą weszły; nowe wejścia idą po nowej.`
        : "Nic do opublikowania: szkic jest taki sam jak wersja włączona.",
    };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

// ── Statystyki na zywo per wezel ────────────────────────────────────────────

export interface StatystykiEmaila {
  wyslane: number;
  dostarczone: number;
  klikniecia: number;
  /** undefined = nie liczono w tym odczycie (odpytywanie bez przychodu) */
  zamowien?: number;
  przychodMinor?: number | null;
}

export interface StatystykiAutomatyzacji {
  wToku: Record<string, number>;
  /** zakonczeni per wezel `koniec` (uczestnik zachowuje node_id konca) */
  zakonczeniPerWezel: Record<string, number>;
  /** ile osob poszlo gałęzią: klucz `${wezelRozgaleziajacy}:${celGalezi}` (z historii przejsc) */
  galezie: Record<string, number>;
  wejscia: number;
  zakonczyli: number;
  wyszli: number;
  przerwani: number;
  emaile: Record<string, StatystykiEmaila>;
  /** undefined = nie liczono (odpytywanie bez przychodu) */
  przebiegAt?: Date | null;
  pobranoO: string;
}

/**
 * Liczniki kanwy. `przychod: false` (odpytywanie co kilkanascie sekund) pomija atrybucje:
 * przychod zmienia sie tylko po przeliczeniu atrybucji, a liczenie go co 10 s to marnowanie
 * bazy (review). Wtedy `przychodMinor`/`zamowien` sa `undefined` i klient trzyma poprzednie.
 */
export async function statystykiAutomatyzacji(
  tenantId: string,
  flowId: string,
  opcje: { przychod?: boolean } = {},
): Promise<StatystykiAutomatyzacji | null> {
  if (!UUID.test(flowId)) return null;
  const pool = getPool();
  const [wezly, zakonczeni, galezie, statusy, emaile, atrybucja] = await Promise.all([
    pool.query("select node_id, count(*)::int as n from flow_participants where tenant_id = $1 and flow_id = $2 and status = 'w_toku' group by node_id", [tenantId, flowId]),
    pool.query("select node_id, count(*)::int as n from flow_participants where tenant_id = $1 and flow_id = $2 and status = 'zakonczony' group by node_id", [tenantId, flowId]),
    pool.query(
      `select from_node, to_node, count(distinct participant_id)::int as n from flow_transitions
        where tenant_id = $1 and flow_id = $2 and kind in ('warunek', 'podzial') group by from_node, to_node`,
      [tenantId, flowId],
    ),
    pool.query("select status, count(*)::int as n from flow_participants where tenant_id = $1 and flow_id = $2 group by status", [tenantId, flowId]),
    pool.query(
      `select j.id,
              (select count(*)::int from message_events e join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
                where e.tenant_id = $1 and e.event_type = 'sent' and m.source_type = 'journey' and m.source_id = j.id) as wyslane,
              (select count(*)::int from message_events e join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
                where e.tenant_id = $1 and e.event_type = 'delivered' and m.source_type = 'journey' and m.source_id = j.id) as dostarczone,
              (select count(distinct c.message_id)::int from clicks c join messages m on m.tenant_id = c.tenant_id and m.id = c.message_id
                where c.tenant_id = $1 and m.source_type = 'journey' and m.source_id = j.id) as klikniecia
         from journeys j where j.tenant_id = $1 and j.flow_id = $2`,
      [tenantId, flowId],
    ),
    opcje.przychod === false ? Promise.resolve(null) : przychodAutomatyzacji(tenantId),
  ]);
  const st = Object.fromEntries(statusy.rows.map((r) => [r.status, r.n]));
  const wynik: StatystykiAutomatyzacji = {
    wToku: Object.fromEntries(wezly.rows.map((r) => [r.node_id, r.n])),
    zakonczeniPerWezel: Object.fromEntries(zakonczeni.rows.map((r) => [r.node_id, r.n])),
    galezie: Object.fromEntries(galezie.rows.map((r) => [`${r.from_node}:${r.to_node}`, r.n])),
    wejscia: statusy.rows.reduce((s, r) => s + r.n, 0),
    zakonczyli: st.zakonczony ?? 0,
    wyszli: st.wyszedl ?? 0,
    przerwani: st.przerwany ?? 0,
    emaile: {},
    przebiegAt: atrybucja ? atrybucja.przebiegAt : undefined,
    pobranoO: new Date().toISOString(),
  };
  for (const e of emaile.rows) {
    const p = atrybucja?.perAutomatyzacja[e.id];
    wynik.emaile[e.id] = {
      wyslane: e.wyslane, dostarczone: e.dostarczone, klikniecia: e.klikniecia,
      ...(atrybucja ? { zamowien: p?.zamowien ?? 0, przychodMinor: atrybucja.przebiegAt ? p?.przychodMinor ?? 0 : null } : {}),
    };
  }
  return wynik;
}

/** Nazwy wiadomosci flow (do listy i "sciezki osoby"). */
export async function nazwyWiadomosci(tenantId: string, flowId: string): Promise<Record<string, { nazwa: string; temat: string }>> {
  const { rows } = await getPool().query("select id, name, subject from journeys where tenant_id = $1 and flow_id = $2", [tenantId, flowId]);
  return Object.fromEntries(rows.map((r) => [r.id, { nazwa: r.name, temat: r.subject ?? "" }]));
}

export { noweIdWezla, wstawWezel };
