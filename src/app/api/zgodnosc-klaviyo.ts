import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { uwierzytelnij, type Zakres } from "../../usecases/api/klucze";
import { sprawdzLimit, sprawdzSufitDobowy, type ProfilLimitu } from "../../usecases/api/limity";
import { przeczytajOgraniczone } from "./przeczytaj-ograniczone";

/**
 * Warstwa zgodności z API Klaviyo (E2 / 2.2, plan 2.1, decyzja D1 = L2).
 *
 * n8n przełącza się zmianą adresu i klucza, więc NIC w żądaniu i odpowiedzi nie może się
 * różnić od Klaviyo w tym, co n8n czyta: statusy, `errors[0].code`, `errors[0].source.pointer`.
 *
 *   - nagłówek `Authorization: Klaviyo-API-Key <klucz>` albo `Bearer <klucz>`; klucz nigdy
 *     z query (logi proxy), nigdy w logu aplikacji (logujemy najwyżej prefiks),
 *   - `revision` wymagany (400 bez niego, jak Klaviyo); każda data przyjęta,
 *   - `Content-Type`: application/json albo application/vnd.api+json (inne = 415),
 *   - błędy `{"errors":[{id,status,code,title,detail,source}]}`, 429 z `Retry-After`,
 *   - tenant WYŁĄCZNIE z rekordu klucza (AD-40).
 *
 * Odpowiedzi API nie są cache'owane i nie niosą ciasteczek.
 */

export interface BladJsonApi {
  status: number;
  code: string;
  title: string;
  detail: string;
  source?: { pointer?: string; parameter?: string; header?: string };
}

const TYTULY: Record<string, string> = {
  not_authenticated: "Authentication credentials were not provided.",
  authentication_failed: "Incorrect authentication credentials.",
  permission_denied: "You do not have permission to perform this action.",
  invalid: "Invalid input.",
  throttled: "Request was throttled.",
  request_too_large: "Request body too large.",
  unsupported_media_type: "Unsupported media type.",
  method_not_allowed: "Method not allowed.",
  not_found: "Not found.",
  not_supported: "This endpoint is not supported.",
  error: "A server error occurred.",
};

const NAGLOWKI_API = { "Cache-Control": "no-store", "Content-Type": "application/vnd.api+json" };

export function odpowiedzBledu(bledy: BladJsonApi[], naglowki: Record<string, string> = {}): NextResponse {
  const status = bledy[0]?.status ?? 500;
  return new NextResponse(
    JSON.stringify({
      errors: bledy.map((b) => ({
        id: randomUUID(),
        status: b.status,
        code: b.code,
        title: b.title,
        detail: b.detail,
        source: b.source ?? {},
        links: {},
        meta: {},
      })),
    }),
    { status, headers: { ...NAGLOWKI_API, ...naglowki } },
  );
}

export function blad(status: number, code: string, detail: string, source?: BladJsonApi["source"], naglowki: Record<string, string> = {}) {
  return odpowiedzBledu([{ status, code, title: TYTULY[code] ?? TYTULY.error, detail, source }], naglowki);
}

/** 202 bez treści (POST /api/events w Klaviyo). */
export function przyjeto(): NextResponse {
  return new NextResponse(null, { status: 202, headers: { "Cache-Control": "no-store" } });
}

export interface KontekstApi {
  tenantId: string;
  kluczId: string;
  prefiks: string;
  revision: string;
}

/**
 * Wspólne bramki żądania API w kolejności Klaviyo: uwierzytelnienie (401), zakres (403),
 * revision (400), limity (429), typ treści (415). Zwraca kontekst albo gotową odpowiedź.
 */
export async function bramkaApi(
  zadanie: NextRequest,
  opcje: { zakres: Zakres; trasa: string; limit: ProfilLimitu; zCialem: boolean; sufitDobowy?: boolean },
): Promise<{ kontekst: KontekstApi } | { odpowiedz: NextResponse }> {
  const auth = await uwierzytelnij(zadanie.headers.get("authorization"));
  if (!auth.ok) {
    return auth.powod === "brak"
      ? { odpowiedz: blad(401, "not_authenticated", "Missing or invalid authorization scheme. Use: Authorization: Klaviyo-API-Key <private key>.") }
      : { odpowiedz: blad(401, "authentication_failed", "Incorrect authentication credentials.") };
  }
  if (!auth.zakresy.includes(opcje.zakres)) {
    return { odpowiedz: blad(403, "permission_denied", `API key is missing required scope: ${opcje.zakres}.`) };
  }
  const revision = (zadanie.headers.get("revision") ?? "").trim();
  if (!revision) {
    return { odpowiedz: blad(400, "invalid", "Missing required header: revision.", { header: "revision" }) };
  }
  const limit = sprawdzLimit(opcje.trasa, auth.kluczId, opcje.limit);
  if (!limit.ok) {
    return { odpowiedz: blad(429, "throttled", `Request was throttled. Expected available in ${limit.poSekundach} seconds.`, undefined, { "Retry-After": String(limit.poSekundach) }) };
  }
  if (opcje.sufitDobowy) {
    const sufit = await sprawdzSufitDobowy(auth.tenantId);
    if (!sufit.ok) {
      return { odpowiedz: blad(429, "throttled", "Daily event limit for this account reached.", undefined, { "Retry-After": String(sufit.poSekundach) }) };
    }
  }
  if (opcje.zCialem) {
    const typ = (zadanie.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (typ !== "application/json" && typ !== "application/vnd.api+json") {
      return { odpowiedz: blad(415, "unsupported_media_type", typ ? `Unsupported media type "${typ.slice(0, 60)}" in request.` : "Missing Content-Type header. Use application/json.") };
    }
  }
  return { kontekst: { tenantId: auth.tenantId, kluczId: auth.kluczId, prefiks: auth.prefiks, revision } };
}

/** Ciało z limitem bajtów i parsowaniem JSON; błąd = gotowa odpowiedź 413/400. */
export async function cialoJson(
  zadanie: NextRequest,
  maksBajtow: number,
): Promise<{ surowe: string; cialo: unknown } | { odpowiedz: NextResponse }> {
  const surowe = await przeczytajOgraniczone(zadanie, maksBajtow);
  if (surowe === null) {
    return { odpowiedz: blad(413, "request_too_large", `Request body exceeds ${Math.floor(maksBajtow / 1024 / 1024)} MB.`) };
  }
  try {
    return { surowe, cialo: JSON.parse(surowe) };
  } catch {
    return { odpowiedz: blad(400, "invalid", "JSON parse error.", { pointer: "/" }) };
  }
}
