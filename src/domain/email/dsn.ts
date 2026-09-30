/**
 * Parser raportów zwrotnych ze skrzynki nadawcy (Blok D, audyt 24.09 #3).
 *
 * Czysta domena: wejściem jest surowy mail (RFC 5322), wyjściem struktura, którą
 * use-case dopasowuje do wiadomości i przekazuje do `zapiszZgloszenieDostawcy`.
 * Żadnej bazy, żadnej sieci.
 *
 * Trzy rodzaje raportów, w kolejności wiarygodności:
 *   dsn         — RFC 3464: multipart/report z częścią message/delivery-status. Per
 *                 odbiorca: Final-Recipient, Action, Status (RFC 3463), Diagnostic-Code.
 *                 Tak raportują Gmail, Microsoft 365/Exchange, Postfix, Exim, Yahoo.
 *   arf         — RFC 5965: multipart/report; report-type=feedback-report, czyli skarga
 *                 z pętli zwrotnej (Feedback-Type: abuse). Tak raportują Yahoo, Microsoft
 *                 JMRP, Comcast; Gmail nie ma FBL per wiadomość.
 *   heurystyka  — odbicie bez DSN (stare serwery, część hostingów): temat i nadawca
 *                 wyglądają na odbicie, a w treści jest kod SMTP i adres. Mniej pewne,
 *                 dlatego wynik niesie `pewnosc: "niska"` i use-case wyklucza adres
 *                 wyłącznie przy twardym kodzie.
 *   nie_odbicie — cokolwiek innego (odpowiedź człowieka, autoresponder, newsletter).
 *
 * Oryginalna wiadomość rozpoznawana jest, w kolejności pewności, po: naszym nagłówku
 * X-MidRev-Message-Id z kopii nagłówków oryginału (przekaźnik go nie przepisuje), potem
 * po Message-ID z części message/rfc822 albo text/rfc822-headers, z In-Reply-To/References
 * raportu, albo z X-Original-Message-ID. Adres odbiorcy jest kluczem zapasowym.
 */

export type AkcjaDsn = "failed" | "delayed" | "delivered" | "relayed" | "expanded";

export interface OdbiorcaRaportu {
  /** adres z Final-Recipient/Original-Recipient (bez „rfc822;"), małymi literami */
  adres: string | null;
  akcja: AkcjaDsn | null;
  /** kod rozszerzony z pola Status (np. „5.1.1") */
  status: string | null;
  /** Diagnostic-Code bez prefiksu „smtp;" — to, co powiedział serwer odbiorcy */
  diagnostyka: string | null;
}

export interface RaportZwrotny {
  rodzaj: "dsn" | "arf" | "heurystyka" | "nie_odbicie";
  pewnosc: "wysoka" | "niska";
  /** Message-ID oryginału w formie `<…>` albo null */
  messageIdOryginalu: string | null;
  /**
   * Nasz identyfikator wiadomości z nagłówka `X-MidRev-Message-Id` w ZAŁĄCZONEJ kopii
   * nagłówków oryginału (message/rfc822, text/rfc822-headers). Przekaźnik (SES) nadpisuje
   * Message-ID, ale własny nagłówek przepuszcza, więc to najpewniejszy klucz dopasowania.
   * Tylko w kształcie UUID (id wiadomości); cokolwiek innego = null.
   */
  naszIdOryginalu: string | null;
  odbiorcy: OdbiorcaRaportu[];
  /** data raportu ZE ŹRÓDŁA: nagłówek Date raportu, w ostateczności Arrival-Date */
  kiedy: Date | null;
  /** ARF: Feedback-Type (abuse, fraud, not-spam, …) */
  typSkargi: string | null;
  temat: string;
  nadawca: string | null;
  /** Reporting-MTA z DSN, do diagnostyki */
  mtaRaportujacy: string | null;
}

// ---------------------------------------------------------------------------
// Minimalny MIME
// ---------------------------------------------------------------------------

export interface CzescMime {
  naglowki: Map<string, string[]>;
  typ: string;
  parametry: Record<string, string>;
  /** treść po zdekodowaniu Content-Transfer-Encoding (dla części tekstowych) */
  tresc: string;
  czesci: CzescMime[];
}

function naglowek(n: Map<string, string[]>, nazwa: string): string | null {
  return n.get(nazwa.toLowerCase())?.[0] ?? null;
}

/** Nagłówki z rozwinięciem zawijania (RFC 5322 §2.2.3). Klucze małymi literami. */
export function parsujNaglowki(blok: string): Map<string, string[]> {
  const wynik = new Map<string, string[]>();
  const linie = blok.split(/\r?\n/);
  let biezacy: { nazwa: string; wartosc: string } | null = null;
  const domknij = () => {
    if (!biezacy) return;
    const lista = wynik.get(biezacy.nazwa) ?? [];
    lista.push(biezacy.wartosc.trim());
    wynik.set(biezacy.nazwa, lista);
    biezacy = null;
  };
  for (const linia of linie) {
    if (/^[ \t]/.test(linia) && biezacy) {
      biezacy.wartosc += ` ${linia.trim()}`;
      continue;
    }
    domknij();
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(linia);
    if (m) biezacy = { nazwa: m[1].toLowerCase(), wartosc: m[2] };
  }
  domknij();
  return wynik;
}

function parsujContentType(wartosc: string | null): { typ: string; parametry: Record<string, string> } {
  if (!wartosc) return { typ: "text/plain", parametry: {} };
  const [typSurowy, ...reszta] = wartosc.split(";");
  const parametry: Record<string, string> = {};
  for (const p of reszta) {
    const m = /^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/.exec(p);
    if (m) parametry[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return { typ: typSurowy.trim().toLowerCase(), parametry };
}

function dekodujQp(tekst: string): string {
  const bajty = tekst
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  // bajty jako latin1 -> utf8 (QP niesie oktety)
  return Buffer.from(bajty, "latin1").toString("utf8");
}

function dekodujTresc(surowa: string, kodowanie: string | null): string {
  const k = (kodowanie ?? "").trim().toLowerCase();
  if (k === "base64") return Buffer.from(surowa.replace(/\s+/g, ""), "base64").toString("utf8");
  if (k === "quoted-printable") return dekodujQp(surowa);
  return surowa;
}

function podzielNaglowkiITresc(surowy: string): { naglowki: string; tresc: string } {
  const m = /\r?\n\r?\n/.exec(surowy);
  if (!m) return { naglowki: surowy, tresc: "" };
  return { naglowki: surowy.slice(0, m.index), tresc: surowy.slice(m.index + m[0].length) };
}

/** Rozbiera surowy mail na drzewo części. Głębokość ograniczona: raport to nie archiwum. */
export function parsujMime(surowy: string, glebokosc = 0): CzescMime {
  const { naglowki: blok, tresc } = podzielNaglowkiITresc(surowy);
  const naglowki = parsujNaglowki(blok);
  const { typ, parametry } = parsujContentType(naglowek(naglowki, "content-type"));
  const czesc: CzescMime = { naglowki, typ, parametry, tresc: "", czesci: [] };
  const boundary = parametry.boundary;
  if (typ.startsWith("multipart/") && boundary && glebokosc < 6) {
    const granica = `--${boundary}`;
    const linie = tresc.split(/\r?\n/);
    let biezaca: string[] | null = null;
    for (const linia of linie) {
      if (linia === granica || linia === `${granica}--`) {
        if (biezaca) czesc.czesci.push(parsujMime(biezaca.join("\n"), glebokosc + 1));
        biezaca = linia === granica ? [] : null;
        if (linia === `${granica}--`) break;
        continue;
      }
      if (biezaca) biezaca.push(linia);
    }
    if (biezaca) czesc.czesci.push(parsujMime(biezaca.join("\n"), glebokosc + 1));
    return czesc;
  }
  if (typ === "message/rfc822" && glebokosc < 6) {
    // osadzony mail: nagłówki oryginału są tym, czego szukamy (Message-ID)
    const zdekodowana = dekodujTresc(tresc, naglowek(naglowki, "content-transfer-encoding"));
    czesc.tresc = zdekodowana;
    czesc.czesci.push(parsujMime(zdekodowana, glebokosc + 1));
    return czesc;
  }
  czesc.tresc = dekodujTresc(tresc, naglowek(naglowki, "content-transfer-encoding"));
  return czesc;
}

function* wszystkieCzesci(c: CzescMime): Generator<CzescMime> {
  yield c;
  for (const p of c.czesci) yield* wszystkieCzesci(p);
}

// ---------------------------------------------------------------------------
// DSN (RFC 3464)
// ---------------------------------------------------------------------------

/** Adres z pola typu „rfc822; user@domain", także w nawiasach ostrych. */
function adresZPola(wartosc: string | null): string | null {
  if (!wartosc) return null;
  const bezTypu = wartosc.replace(/^\s*rfc822\s*;\s*/i, "").trim();
  const m = /<?([^\s<>@"]+@[^\s<>@"]+)>?/.exec(bezTypu);
  return m ? m[1].toLowerCase() : null;
}

function akcjaZPola(wartosc: string | null): AkcjaDsn | null {
  const a = (wartosc ?? "").trim().toLowerCase();
  return a === "failed" || a === "delayed" || a === "delivered" || a === "relayed" || a === "expanded" ? a : null;
}

function statusZPola(wartosc: string | null): string | null {
  const m = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(wartosc ?? "");
  return m ? m[0] : null;
}

function diagnostykaZPola(wartosc: string | null): string | null {
  if (!wartosc) return null;
  const bezTypu = wartosc.replace(/^\s*(smtp|x-[a-z0-9-]+)\s*;\s*/i, "").trim();
  return bezTypu ? bezTypu.slice(0, 2000) : null;
}

/** Grupy pól delivery-status rozdzielone pustą linią: pierwsza per-message, reszta per-recipient. */
function parsujDeliveryStatus(tresc: string): { perMessage: Map<string, string[]>; odbiorcy: OdbiorcaRaportu[] } {
  const grupy = tresc
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((g) => g.trim())
    .filter(Boolean)
    .map(parsujNaglowki);
  const perMessage = grupy[0] ?? new Map<string, string[]>();
  const odbiorcy: OdbiorcaRaportu[] = [];
  for (const g of grupy.slice(1)) {
    const adres = adresZPola(naglowek(g, "final-recipient")) ?? adresZPola(naglowek(g, "original-recipient"));
    const akcja = akcjaZPola(naglowek(g, "action"));
    const status = statusZPola(naglowek(g, "status"));
    const diagnostyka = diagnostykaZPola(naglowek(g, "diagnostic-code"));
    if (!adres && !akcja && !status) continue;
    odbiorcy.push({ adres, akcja, status, diagnostyka });
  }
  return { perMessage, odbiorcy };
}

// ---------------------------------------------------------------------------
// Pomocnicze: daty, Message-ID
// ---------------------------------------------------------------------------

/** RFC 5322 Date → Date. Usuwa komentarze w nawiasach („(CEST)"), których JS nie trawi. */
export function parsujDateNaglowka(wartosc: string | null): Date | null {
  if (!wartosc) return null;
  const czysta = wartosc.replace(/\([^)]*\)/g, "").trim();
  const d = new Date(czysta);
  if (Number.isNaN(d.getTime())) return null;
  // ochrona przed absurdem (zegar serwera odbiorcy ustawiony na 1970 albo 2099)
  const rok = d.getUTCFullYear();
  if (rok < 2000 || rok > 2100) return null;
  return d;
}

function messageIdZ(wartosc: string | null): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(wartosc ?? "");
  return m ? `<${m[1]}>` : null;
}

const UUID_WIADOMOSCI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function naszIdZ(wartosc: string | null): string | null {
  const w = (wartosc ?? "").trim().replace(/^<|>$/g, "");
  return UUID_WIADOMOSCI.test(w) ? w.toLowerCase() : null;
}

/**
 * `X-MidRev-Message-Id` WYŁĄCZNIE z załączonej kopii oryginału — nie z nagłówków samego
 * raportu i nie z cytatu w treści: tam trafia to, co napisze autor raportu, a kopia
 * nagłówków to ta część DSN/ARF, którą serwer odbiorcy odsyła z naszej wiadomości.
 */
function znajdzNaszIdOryginalu(korzen: CzescMime): string | null {
  for (const c of wszystkieCzesci(korzen)) {
    if (c === korzen) continue;
    if (c.typ === "message/rfc822") {
      const osadzony = c.czesci[0];
      const id = naszIdZ(osadzony ? naglowek(osadzony.naglowki, "x-midrev-message-id") : null);
      if (id) return id;
    }
    if (c.typ === "text/rfc822-headers" || c.typ === "message/global-headers") {
      const id = naszIdZ(naglowek(parsujNaglowki(c.tresc), "x-midrev-message-id"));
      if (id) return id;
    }
  }
  return null;
}

function znajdzMessageIdOryginalu(korzen: CzescMime): string | null {
  // 1. kopia oryginału (message/rfc822 albo text/rfc822-headers)
  for (const c of wszystkieCzesci(korzen)) {
    if (c === korzen) continue;
    if (c.typ === "message/rfc822") {
      const osadzony = c.czesci[0];
      const id = messageIdZ(osadzony ? naglowek(osadzony.naglowki, "message-id") : null);
      if (id) return id;
    }
    if (c.typ === "text/rfc822-headers" || c.typ === "message/global-headers") {
      const id = messageIdZ(naglowek(parsujNaglowki(c.tresc), "message-id"));
      if (id) return id;
    }
  }
  // 2. nagłówki samego raportu
  for (const nazwa of ["x-original-message-id", "in-reply-to", "references"]) {
    const id = messageIdZ(naglowek(korzen.naglowki, nazwa));
    if (id) return id;
  }
  // 3. cytowane nagłówki w treści tekstowej (heurystyka)
  for (const c of wszystkieCzesci(korzen)) {
    if (!c.typ.startsWith("text/")) continue;
    const m = /^\s*Message-I[dD]:\s*(<[^<>\s]+@[^<>\s]+>)/m.exec(c.tresc);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Heurystyka odbić bez DSN
// ---------------------------------------------------------------------------

const TEMATY_ODBIC =
  /undeliver|delivery (status )?notification|delivery (has )?failed|mail delivery fail|returned mail|delivery failure|failure notice|could not be delivered|not delivered|niedostarczon|nie mo[żz]na dostarczy|zwrot wiadomo|delivery report|nondeliver|non-deliver|mail system error|Unzustellbar|no se pudo entregar/i;
const NADAWCY_ODBIC = /mailer-daemon|postmaster|mail delivery (system|subsystem)|no-?reply@.*(bounce|mailer)/i;

function heurystykaOdbicia(korzen: CzescMime, temat: string, nadawca: string | null): OdbiorcaRaportu[] {
  const wyglada = TEMATY_ODBIC.test(temat) || NADAWCY_ODBIC.test(nadawca ?? "");
  if (!wyglada) return [];
  const teksty: string[] = [];
  for (const c of wszystkieCzesci(korzen)) {
    if (c.typ.startsWith("text/") && c.tresc) teksty.push(c.tresc);
  }
  const tekst = teksty.join("\n").replace(/<[^>]{1,40}>/g, (x) => (x.includes("@") ? x : " "));
  const odbiorcy: OdbiorcaRaportu[] = [];
  const widziane = new Set<string>();
  // linia z kodem SMTP i adresem w pobliżu: na tej samej linii (Postfix: "<x@y>: host …
  // said: 550 5.1.1 …") albo w jednej z trzech linii wyżej (qmail: "<x@y>:" i pod spodem
  // "Sorry, no mailbox here by that name. (#5.1.1)")
  const linie = tekst.split(/\r?\n/);
  const adresWLinii = (l: string) => /<?([^\s<>@"':]+@[^\s<>@"':]+)>?/.exec(l)?.[1]?.toLowerCase() ?? null;
  for (let i = 0; i < linie.length; i++) {
    const linia = linie[i];
    const kod = /\b([45])\.(\d{1,3})\.(\d{1,3})\b|\b([45])\d{2}\b/.exec(linia);
    if (!kod) continue;
    let adres = adresWLinii(linia);
    for (let j = i - 1; !adres && j >= Math.max(0, i - 3); j--) adres = adresWLinii(linie[j]);
    const klucz = adres ?? "?";
    if (widziane.has(klucz)) continue;
    widziane.add(klucz);
    odbiorcy.push({
      adres,
      akcja: kod[0].startsWith("4") ? "delayed" : "failed",
      status: statusZPola(linia),
      diagnostyka: linia.trim().slice(0, 2000),
    });
  }
  if (odbiorcy.length === 0) {
    // kod nie na tej samej linii co adres: weź pierwszy adres i pierwszy kod z całości
    const kod = /\b([45])\.(\d{1,3})\.(\d{1,3})\b/.exec(tekst) ?? /\b([45])\d{2}\b/.exec(tekst);
    const adres = /<([^\s<>@"']+@[^\s<>@"']+)>/.exec(tekst)?.[1]?.toLowerCase() ?? null;
    if (kod && adres) {
      odbiorcy.push({
        adres,
        akcja: kod[0].startsWith("4") ? "delayed" : "failed",
        status: statusZPola(kod[0]),
        diagnostyka: tekst.split(/\r?\n/).find((l) => l.includes(kod[0]))?.trim().slice(0, 2000) ?? kod[0],
      });
    }
  }
  return odbiorcy;
}

// ---------------------------------------------------------------------------
// Wejście
// ---------------------------------------------------------------------------

export function parsujRaportZwrotny(surowy: string): RaportZwrotny {
  const korzen = parsujMime(surowy);
  const n = korzen.naglowki;
  const temat = naglowek(n, "subject") ?? "";
  const nadawca = naglowek(n, "from");
  const kiedyRaportu = parsujDateNaglowka(naglowek(n, "date"));
  const messageIdOryginalu = znajdzMessageIdOryginalu(korzen);
  const naszIdOryginalu = znajdzNaszIdOryginalu(korzen);
  const typRaportu = (korzen.parametry["report-type"] ?? "").toLowerCase();

  const baza = {
    messageIdOryginalu,
    naszIdOryginalu,
    temat,
    nadawca,
    typSkargi: null as string | null,
    mtaRaportujacy: null as string | null,
  };

  // ARF: skarga z pętli zwrotnej
  const fbl = [...wszystkieCzesci(korzen)].find((c) => c.typ === "message/feedback-report");
  if (fbl || typRaportu === "feedback-report") {
    const pola = fbl ? parsujNaglowki(fbl.tresc.trim()) : new Map<string, string[]>();
    const typSkargi = (naglowek(pola, "feedback-type") ?? "abuse").trim().toLowerCase();
    const adres = adresZPola(naglowek(pola, "original-rcpt-to")) ?? adresZPola(naglowek(pola, "removal-recipient"));
    const kiedy = kiedyRaportu ?? parsujDateNaglowka(naglowek(pola, "arrival-date")) ?? parsujDateNaglowka(naglowek(pola, "received-date"));
    return {
      ...baza,
      rodzaj: "arf",
      pewnosc: "wysoka",
      typSkargi,
      odbiorcy: [{ adres, akcja: null, status: null, diagnostyka: null }],
      kiedy,
    };
  }

  // DSN
  const ds = [...wszystkieCzesci(korzen)].find((c) => c.typ === "message/delivery-status" || c.typ === "message/global-delivery-status");
  if (ds) {
    const { perMessage, odbiorcy } = parsujDeliveryStatus(ds.tresc);
    const kiedy = kiedyRaportu ?? parsujDateNaglowka(naglowek(perMessage, "arrival-date"));
    return {
      ...baza,
      // Gmail wpisuje Message-ID oryginału także w grupie per-message raportu
      messageIdOryginalu: messageIdOryginalu ?? messageIdZ(naglowek(perMessage, "x-original-message-id")),
      rodzaj: "dsn",
      pewnosc: "wysoka",
      mtaRaportujacy: naglowek(perMessage, "reporting-mta")?.replace(/^\s*dns\s*;\s*/i, "") ?? null,
      odbiorcy,
      kiedy,
    };
  }

  // Autoresponder to nie odbicie, nawet jeśli temat ma „Delivery" w nazwie
  const autoSubmitted = (naglowek(n, "auto-submitted") ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { ...baza, rodzaj: "nie_odbicie", pewnosc: "wysoka", odbiorcy: [], kiedy: kiedyRaportu };
  }

  const odbiorcy = heurystykaOdbicia(korzen, temat, nadawca);
  if (odbiorcy.length) {
    return { ...baza, rodzaj: "heurystyka", pewnosc: "niska", odbiorcy, kiedy: kiedyRaportu };
  }
  return { ...baza, rodzaj: "nie_odbicie", pewnosc: "wysoka", odbiorcy: [], kiedy: kiedyRaportu };
}
