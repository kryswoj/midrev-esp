import { NextResponse, type NextRequest } from "next/server";
import { adresKlienta } from "../../../../adapters/ip-klienta";
import { sprawdzLimit, type ProfilLimitu } from "../../../../usecases/api/limity";
import { uwierzytelnijWtyczke, type WtyczkaUwierzytelniona } from "../../../../usecases/integracja/woo-wtyczka";
import { przeczytajOgraniczone } from "../../przeczytaj-ograniczone";

/**
 * Wspólne bramki tras wtyczki WooCommerce (`/api/integracje/woocommerce/*`):
 * limit per IP PRZED dotknięciem bazy, limit ciała, podpis HMAC wtyczki. Odpowiedzi nigdy
 * nie zdradzają, czy sklep istnieje (401 bez szczegółów) i nie niosą sekretów (wyjątek:
 * odpowiedź parowania niesie sekret wtyczki DLA TEJ wtyczki, raz).
 */
export const LIMIT_PAROWANIA: ProfilLimitu = { naSekunde: 2, naMinute: 10 };
export const LIMIT_WTYCZKI_IP: ProfilLimitu = { naSekunde: 20, naMinute: 600 };

export const NAGLOWKI = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

export function json(status: number, dane: unknown, extra: Record<string, string> = {}) {
  return new NextResponse(JSON.stringify(dane), { status, headers: { ...NAGLOWKI, ...extra } });
}

export function limitIp(zadanie: NextRequest, trasa: string, profil: ProfilLimitu): NextResponse | null {
  const ip = adresKlienta(zadanie.headers) ?? "nieznane";
  const l = sprawdzLimit(`woo-wtyczka:${trasa}`, ip, profil);
  return l.ok ? null : json(429, { blad: "za_duzo_zadan" }, { "retry-after": String(l.poSekundach) });
}

export async function bramkaWtyczki(
  zadanie: NextRequest,
  storeId: string,
  trasa: string,
  maksBajtow: number,
): Promise<{ odpowiedz: NextResponse } | { auth: WtyczkaUwierzytelniona; cialo: unknown }> {
  const limit = limitIp(zadanie, trasa, LIMIT_WTYCZKI_IP);
  if (limit) return { odpowiedz: limit };
  const surowe = await przeczytajOgraniczone(zadanie, maksBajtow);
  if (surowe === null) return { odpowiedz: json(413, { blad: "za_duze_cialo" }) };
  const auth = await uwierzytelnijWtyczke(storeId, zadanie.headers, surowe);
  if (!auth) return { odpowiedz: json(401, { blad: "zly_podpis" }) };
  let cialo: unknown = {};
  if (surowe.trim()) {
    try {
      cialo = JSON.parse(surowe);
    } catch {
      return { odpowiedz: json(400, { blad: "nieczytelne_cialo" }) };
    }
  }
  return { auth, cialo };
}

export function bladWewnetrzny(trasa: string, b: unknown) {
  // bez treści wyjątku w odpowiedzi; w logu tylko nazwa (URL z kluczami bywa w message fetcha)
  console.error(`[woo-wtyczka/${trasa}] błąd: ${b instanceof Error ? b.name : "nieznany"}: ${b instanceof Error ? b.message.replace(/(ck|cs)_[a-z0-9]+/gi, "$1_…") : ""}`);
  return json(500, { blad: "blad_serwera" });
}
