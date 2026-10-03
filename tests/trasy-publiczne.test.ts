import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../middleware";
import { czyTrasaPubliczna, sciezkaPoPrzepisaniu, TRASY_PUBLICZNE } from "../src/trasy-publiczne";

/**
 * Regresja P0-2 (audyt 28.09): pixel `/api/o` nie był na liście publicznej, więc w buildzie
 * produkcyjnym klient pocztowy dostawał przekierowanie na /logowanie zamiast GIF-a. Serwer
 * dev tego nie pokazywał, a testy wołały handlery bezpośrednio, z pominięciem middleware.
 *
 * Ten test:
 *   1. przechodzi CAŁE drzewo src/app i każdą trasę (page.tsx / route.ts) klasyfikuje:
 *      albo jest na jawnej liście OCZEKIWANE_PUBLICZNE, albo na OCZEKIWANE_CHRONIONE.
 *      Nowa trasa bez decyzji = czerwony test (trzeba świadomie wybrać),
 *   2. dla każdej trasy woła PRAWDZIWE middleware bez ciasteczka: publiczna ma przejść,
 *      chroniona ma odesłać na /logowanie,
 *   3. pilnuje, że lista publiczna nie jest szersza, niż trzeba (żaden wpis nie otwiera
 *      trasy chronionej, każdy wpis odpowiada istniejącej trasie albo zasobom Nexta).
 */

const KATALOG_APP = join(import.meta.dirname, "..", "src", "app");

/** Wzorce tras (jak w drzewie app, z [param]) dostępne bez sesji. */
const OCZEKIWANE_PUBLICZNE = new Set([
  "/logowanie",
  "/r/[token]",
  "/u/[token]",
  "/api/o/[token]",
  "/o/[plik]",
  "/akceptacja/[token]",
  "/s/[tenantId]",
  "/api/popup/[popupId]",
  // builder formularzy (0043): kolejny krok po e-mailu (token HMAC) i lekkie zdarzenie wyświetlenia
  "/api/popup/[popupId]/krok",
  "/api/popup/[popupId]/wyswietlenie",
  "/api/webhooks/woo/[storeId]",
  // zdarzenia SES przez SNS (podpis SNS + allowlista tematu, 0040)
  "/api/webhooks/ses",
  // instrukcja DNS dla informatyka klienta (token 14 dni, tylko odczyt, 0040)
  "/dns/[token]",
  "/api/zdrowie",
  "/api/events",
  // integracja custom (0044): skrypt midrev.js i Client API zgodne z Klaviyo
  "/js/v1/[plik]",
  "/client/events",
  "/client/profiles",
  "/client/subscriptions",
]);

/** Wzorce tras wymagające sesji panelu. */
const OCZEKIWANE_CHRONIONE_PREFIKSY = ["/t/[tenantId]", "/api/import/[tenantId]", "/api/obrazy/[tenantId]"];
// /api/wersja: strażnik wersji panelu, tylko dla zalogowanych (audyt UX 02.10)
const OCZEKIWANE_CHRONIONE_DOKLADNE = new Set(["/", "/api/wersja"]);

function trasyZDrzewa(katalog: string): string[] {
  const wynik: string[] = [];
  for (const wpis of readdirSync(katalog)) {
    const pelna = join(katalog, wpis);
    if (statSync(pelna).isDirectory()) {
      // foldery prywatne (_x) nie są segmentami trasy
      if (wpis.startsWith("_")) continue;
      wynik.push(...trasyZDrzewa(pelna));
    } else if (/^(page|route)\.(tsx?|jsx?)$/.test(wpis)) {
      const segmenty = relative(KATALOG_APP, katalog)
        .split(sep)
        .filter(Boolean)
        // grupy (x) nie są częścią adresu
        .filter((s) => !/^\(.*\)$/.test(s));
      wynik.push("/" + segmenty.join("/"));
    }
  }
  return wynik;
}

/** Przykładowy adres dla wzorca: [param] → wartość. */
function przyklad(wzorzec: string): string {
  return wzorzec.replace(/\[([^\]]+)\]/g, (_c, nazwa: string) => (nazwa === "token" ? "tok123" : nazwa === "plik" ? "abc.png" : "0199e8f0-0000-7000-8000-000000000001"));
}

function wywolaj(sciezka: string, ciasteczko = false) {
  const zadanie = new NextRequest(new URL(sciezka, "https://esp.midrev.test"), {
    headers: ciasteczko ? { cookie: "midrev_sesja=cos" } : {},
  });
  return middleware(zadanie);
}

function przeszlo(odp: Response): boolean {
  // NextResponse.next() niesie nagłówek x-middleware-next; przekierowanie ma Location
  return odp.headers.get("x-middleware-next") === "1" && !odp.headers.get("location");
}

describe("Trasy publiczne: lista vs drzewo src/app vs middleware", () => {
  const trasy = [...new Set(trasyZDrzewa(KATALOG_APP))].sort();

  it("drzewo ma trasy (sanity: test nie przechodzi na pustym katalogu)", () => {
    expect(trasy.length).toBeGreaterThan(20);
    expect(trasy).toContain("/api/o/[token]");
  });

  it("KAŻDA trasa jest świadomie sklasyfikowana jako publiczna albo chroniona", () => {
    const bezDecyzji = trasy.filter(
      (t) =>
        !OCZEKIWANE_PUBLICZNE.has(t) &&
        !OCZEKIWANE_CHRONIONE_DOKLADNE.has(t) &&
        !OCZEKIWANE_CHRONIONE_PREFIKSY.some((p) => t === p || t.startsWith(p + "/")),
    );
    expect(bezDecyzji, "nowa trasa: dopisz ją do OCZEKIWANE_PUBLICZNE (i src/trasy-publiczne.ts) albo do chronionych").toEqual([]);
  });

  it.each([...OCZEKIWANE_PUBLICZNE].map((t) => [t]))("publiczna %s przechodzi przez middleware BEZ sesji", (wzorzec) => {
    expect(przeszlo(wywolaj(przyklad(wzorzec)))).toBe(true);
    expect(czyTrasaPubliczna(przyklad(wzorzec))).toBe(true);
  });

  it("chronione trasy bez sesji idą na /logowanie z adresem powrotu, z sesją przechodzą", () => {
    const chronione = trasy.filter((t) => !OCZEKIWANE_PUBLICZNE.has(t));
    expect(chronione.length).toBeGreaterThan(10);
    for (const t of chronione) {
      const bez = wywolaj(przyklad(t));
      expect(bez.headers.get("location"), t).toContain("/logowanie?dalej=");
      expect(przeszlo(wywolaj(przyklad(t), true)), t).toBe(true);
    }
  });

  it("pixel, obraz, wypis GET i POST, zgłoszenie popupu: dokładne adresy z maili i ze sklepu", () => {
    for (const s of ["/api/o/abc123.gif", "/o/Abc_def-123.png", "/u/tok", "/r/tok?l=0", "/s/0199e8f0-0000-7000-8000-000000000001", "/api/popup/x", "/api/webhooks/woo/x", "/api/zdrowie", "/_next/static/chunk.js", "/favicon.ico"]) {
      expect(przeszlo(wywolaj(s)), s).toBe(true);
    }
    const post = middleware(new NextRequest(new URL("/u/tok", "https://link.midrev.test"), { method: "POST", body: "List-Unsubscribe=One-Click" }));
    expect(przeszlo(post)).toBe(true);
  });

  it("API zgodne z Klaviyo: /api/events/ (z ukośnikiem, jak w n8n) jest PRZEPISANE bez 308, POST przechodzi", () => {
    const post = middleware(new NextRequest(new URL("/api/events/", "https://api.midrev.test"), { method: "POST", body: "{}" }));
    expect(post.headers.get("location")).toBeNull();
    expect(post.status).not.toBe(308);
    expect(post.headers.get("x-middleware-rewrite")).toBeNull();
    expect(przeszlo(post)).toBe(true);
    expect(sciezkaPoPrzepisaniu("/api/events/")).toBe("/api/events");
    expect(przeszlo(wywolaj("/api/events"))).toBe(true);
    // inne ścieżki z ukośnikiem: to samo 308 co wcześniej robił Next (skipTrailingSlashRedirect)
    const panel = wywolaj("/t/abc/profile/");
    expect(panel.status).toBe(308);
    expect(new URL(panel.headers.get("location")!).pathname).toBe("/t/abc/profile");
    expect(czyTrasaPubliczna("/api/eventsx")).toBe(false);
  });

  it("lista nie jest za szeroka: prefiksy nie łapią sąsiednich segmentów", () => {
    for (const s of ["/raporty", "/ustawienia", "/obrazy", "/api/obrazy/x", "/api/import/x", "/api/oauth", "/sklepy", "/t/x/r/y", "/uzytkownicy", "/api", "/api/zdrowie-x"]) {
      expect(czyTrasaPubliczna(s), s).toBe(false);
    }
  });

  it("każdy wpis listy publicznej odpowiada istniejącej trasie albo zasobom Nexta (brak martwych wpisów)", () => {
    const zasoby = new Set(["/_next", "/favicon.ico"]);
    for (const p of TRASY_PUBLICZNE) {
      if (zasoby.has(p)) continue;
      expect(
        trasy.some((t) => t === p || t.startsWith(p + "/")),
        `${p} nie odpowiada żadnej trasie w src/app`,
      ).toBe(true);
    }
  });
});
