import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { adresKlienta } from "../../adapters/ip-klienta";
import { hostWDomenach } from "../../adapters/token-mx";
import { kluczStronyPublicznie, type KluczStrony } from "../../usecases/integracja/klucz-strony";
import { sprawdzLimit, type ProfilLimitu } from "../../usecases/api/limity";
import { originBezDanych, zanotujSygnal } from "../../usecases/integracja/podglad";
import { przeczytajOgraniczone } from "../api/przeczytaj-ograniczone";
import type { BladKlienta } from "../../usecases/integracja/klient-api";

/**
 * Wspólne bramki Client API zgodnego z Klaviyo (`/client/*?company_id=`):
 *
 *   klucz strony (400 przy złym/unieważnionym, bez rozróżniania) → CORS (origin z domen
 *   strony, gdy panel tak ustawił) → limit per IP, potem per klucz → typ treści (JSON albo
 *   text/plain, bo skrypt wysyła text/plain, żeby uniknąć preflightu) → limit ciała → JSON.
 *
 * Odpowiedzi nigdy nie niosą danych konta ani ciasteczek; CORS bez credentials, więc
 * cudza strona i tak nie ma czego odczytać. Ruch botów (User-Agent) dostaje 202 i nic się
 * nie zapisuje: bot nie ma uczyć się, że jest filtrowany, a my nie chcemy jego profili.
 */

export const LIMIT_IP: ProfilLimitu = { naSekunde: 10, naMinute: 120 };
export const LIMIT_KLUCZA: ProfilLimitu = { naSekunde: 100, naMinute: 3500 };

const BOT = /bot\b|crawl|spider|slurp|headless|phantomjs|lighthouse|pagespeed|preview|facebookexternalhit|bingpreview|python-requests|curl\/|wget\//i;

export function czyBot(ua: string | null): boolean {
  return !ua || BOT.test(ua);
}

function corsDla(origin: string | null, klucz: KluczStrony | null): Record<string, string> {
  const n: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, revision, X-Requested-With",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (klucz?.ograniczOriginy) {
    if (origin && originDozwolony(origin, klucz)) n["Access-Control-Allow-Origin"] = origin;
  } else {
    n["Access-Control-Allow-Origin"] = "*";
  }
  return n;
}

export function originDozwolony(origin: string, klucz: KluczStrony): boolean {
  if (!klucz.ograniczOriginy) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "https:" || u.protocol === "http:") && hostWDomenach(u.hostname, klucz.domeny);
  } catch {
    return false;
  }
}

const NAGLOWKI = { "Cache-Control": "no-store", "Content-Type": "application/vnd.api+json" };

export function bladKlienta(status: number, bledy: BladKlienta[] | { kod: string; opis: string; wskaznik?: string }[], cors: Record<string, string>, extra: Record<string, string> = {}) {
  return new NextResponse(
    JSON.stringify({
      errors: bledy.map((b) => ({
        id: randomUUID(),
        status,
        code: ("kod" in b && b.kod) || "invalid",
        title: status === 429 ? "Request was throttled." : status === 415 ? "Unsupported media type." : status === 413 ? "Request body too large." : "Invalid input.",
        detail: b.opis,
        source: b.wskaznik ? { pointer: b.wskaznik } : {},
      })),
    }),
    { status, headers: { ...NAGLOWKI, ...cors, ...extra } },
  );
}

export function przyjeto202(cors: Record<string, string>) {
  return new NextResponse(null, { status: 202, headers: { "Cache-Control": "no-store", ...cors } });
}

export async function preflight(zadanie: NextRequest) {
  // limit IP przed odczytem klucza także dla OPTIONS (review Codeksa r2)
  const ip = adresKlienta(zadanie.headers) ?? "nieznane";
  if (!sprawdzLimit("client-ip:options", ip, LIMIT_IP).ok) {
    return new NextResponse(null, { status: 429, headers: { "Retry-After": "60", "Access-Control-Allow-Origin": "*" } });
  }
  const klucz = await kluczStronyPublicznie(zadanie.nextUrl.searchParams.get("company_id"));
  return new NextResponse(null, { status: 204, headers: corsDla(zadanie.headers.get("origin"), klucz) });
}

export type WynikBramki =
  | { odpowiedz: NextResponse }
  | { klucz: KluczStrony; cialo: unknown; cors: Record<string, string>; origin: string | null; bot: boolean };

export async function bramkaKlienta(zadanie: NextRequest, opcje: { trasa: string; maksBajtow: number }): Promise<WynikBramki> {
  const origin = zadanie.headers.get("origin");
  // limit per IP PRZED odczytem klucza: losowe company_id nie omijają throttlingu i nie
  // zamieniają się w zapytania do bazy (review Codeksa r1)
  const ip = adresKlienta(zadanie.headers) ?? "nieznane";
  const li = sprawdzLimit(`client-ip:${opcje.trasa}`, ip, LIMIT_IP);
  if (!li.ok) return { odpowiedz: bladKlienta(429, [{ kod: "throttled", opis: "Too many requests." }], { "Access-Control-Allow-Origin": "*" }, { "Retry-After": String(li.poSekundach) }) };
  const klucz = await kluczStronyPublicznie(zadanie.nextUrl.searchParams.get("company_id"));
  const cors = corsDla(origin, klucz);
  if (!klucz) {
    return { odpowiedz: bladKlienta(400, [{ kod: "invalid", opis: "Invalid or missing company_id.", wskaznik: undefined }], cors) };
  }
  if (klucz.ograniczOriginy && (!origin || !originDozwolony(origin, klucz))) {
    zanotujSygnal(klucz.id, { rodzaj: "odrzucone", metryka: null, sciezka: null, origin: originBezDanych(origin), powod: "strona spoza listy domen" });
    return { odpowiedz: bladKlienta(403, [{ kod: "permission_denied", opis: "Origin not allowed for this company_id." }], cors) };
  }
  const lk = sprawdzLimit(`client-site:${opcje.trasa}`, klucz.id, LIMIT_KLUCZA);
  if (!lk.ok) return { odpowiedz: bladKlienta(429, [{ kod: "throttled", opis: "Too many requests." }], cors, { "Retry-After": String(lk.poSekundach) }) };
  const typ = (zadanie.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (typ !== "application/json" && typ !== "application/vnd.api+json" && typ !== "text/plain") {
    return { odpowiedz: bladKlienta(415, [{ kod: "unsupported_media_type", opis: "Use application/json." }], cors) };
  }
  const surowe = await przeczytajOgraniczone(zadanie, opcje.maksBajtow);
  if (surowe === null) return { odpowiedz: bladKlienta(413, [{ kod: "request_too_large", opis: `Request body exceeds ${opcje.maksBajtow} bytes.` }], cors) };
  let cialo: unknown;
  try {
    cialo = JSON.parse(surowe);
  } catch {
    return { odpowiedz: bladKlienta(400, [{ kod: "invalid", opis: "JSON parse error.", wskaznik: "/" }], cors) };
  }
  return { klucz, cialo, cors, origin: originBezDanych(origin), bot: czyBot(zadanie.headers.get("user-agent")) };
}

export function obsluzBladWewnetrzny(trasa: string, b: unknown) {
  console.error(`[client/${trasa}] błąd: ${b instanceof Error ? `${b.name}: ${b.message}` : "nieznany"}`);
  return new NextResponse(
    JSON.stringify({ errors: [{ id: randomUUID(), status: 500, code: "error", title: "A server error occurred.", detail: "Retry the request.", source: {} }] }),
    { status: 500, headers: { ...NAGLOWKI, "Access-Control-Allow-Origin": "*" } },
  );
}
