import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "../../../config";
import { stanZdrowia } from "../../../usecases/zdrowie";

/**
 * Healthcheck dla zewnętrznego monitora (UptimeRobot, systemd, Caddy): 200 gdy baza
 * odpowiada i żyje worker, 503 w przeciwnym razie. Trasa PUBLICZNA (src/trasy-publiczne.ts),
 * więc bez szczegółów zwraca wyłącznie `status`. Liczby (kolejka, held) tylko z
 * `?szczegoly=1` i nagłówkiem `Authorization: Bearer <ZDROWIE_TOKEN>`; bez ustawionego
 * tokenu szczegółów nie ma wcale. Żadnych identyfikatorów tenantów ani adresów.
 */
export const dynamic = "force-dynamic";

function tokenPoprawny(zadanie: NextRequest): boolean {
  const oczekiwany = config().ZDROWIE_TOKEN;
  if (!oczekiwany) return false;
  const naglowek = zadanie.headers.get("authorization") ?? "";
  const podany = naglowek.startsWith("Bearer ") ? naglowek.slice(7).trim() : "";
  const a = Buffer.from(podany);
  const b = Buffer.from(oczekiwany);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(zadanie: NextRequest) {
  const szczegoly = zadanie.nextUrl.searchParams.get("szczegoly") === "1" && tokenPoprawny(zadanie);
  const stan = await stanZdrowia({ szczegoly });
  // Bez tokenu WYŁĄCZNIE status (review Codeksa r1): który komponent leży (baza czy
  // worker), to już informacja o infrastrukturze, więc tylko w trybie szczegółów.
  return NextResponse.json(
    stan.szczegoly
      ? { status: stan.ok ? "ok" : "blad", baza: stan.baza, worker: stan.worker, szczegoly: stan.szczegoly }
      : { status: stan.ok ? "ok" : "blad" },
    {
      status: stan.ok ? 200 : 503,
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
    },
  );
}
