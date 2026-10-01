import { Resolver } from "node:dns/promises";

/**
 * Zapytania DNS do weryfikacji domeny nadawcy (SPF, DKIM, DMARC, MX).
 *
 * Interfejs zamiast bezpośredniego `node:dns`, bo testy NIE MOGĄ odpytywać internetu:
 * wynik zależałby od cudzej strefy DNS i od sieci na maszynie CI. Testy wstrzykują
 * resolver z tabelą rekordów, produkcja używa `resolverSystemowy()`.
 *
 * Kontrakt błędów: brak rekordu to wyjątek z `code` ENODATA albo ENOTFOUND (tak robi
 * node:dns). Każdy inny kod (ETIMEOUT, ESERVFAIL, EREFUSED...) znaczy „nie udało się
 * zapytać", a to NIE jest to samo co „rekordu nie ma" i warstwa wyżej tak to pokazuje.
 */
export interface ResolverDns {
  /** rekordy TXT z posklejanymi fragmentami (TXT dłuższy niż 255 znaków przychodzi w kawałkach) */
  txt(nazwa: string): Promise<string[]>;
  mx(nazwa: string): Promise<{ exchange: string; priority: number }[]>;
  cname(nazwa: string): Promise<string[]>;
  a(nazwa: string): Promise<string[]>;
  aaaa(nazwa: string): Promise<string[]>;
  /** serwery NS strefy (wysyłka platformowa: strefa i dostawca DNS). Opcjonalne: starsze atrapy go nie mają. */
  ns?(nazwa: string): Promise<string[]>;
}

export const KODY_BRAKU_REKORDU = new Set(["ENODATA", "ENOTFOUND"]);

export function czyBrakRekordu(blad: unknown): boolean {
  return KODY_BRAKU_REKORDU.has(String((blad as { code?: unknown })?.code ?? ""));
}

/** Twardy sufit na jedno zapytanie, niezależny od ustawień resolvera. */
const LIMIT_ZAPYTANIA_MS = 8_000;

function zLimitem<T>(obietnica: Promise<T>, nazwa: string): Promise<T> {
  let zegar: NodeJS.Timeout | undefined;
  return Promise.race([
    obietnica,
    new Promise<never>((_, odrzuc) => {
      zegar = setTimeout(() => {
        const e = new Error(`DNS: brak odpowiedzi dla ${nazwa}`) as Error & { code?: string };
        e.code = "ETIMEOUT";
        odrzuc(e);
      }, LIMIT_ZAPYTANIA_MS);
    }),
  ]).finally(() => clearTimeout(zegar));
}

export function resolverSystemowy(): ResolverDns {
  // 3 s na próbę, dwie próby: odpowiedź albo jasny timeout w kilka sekund, nie w minutę
  const r = new Resolver({ timeout: 3_000, tries: 2 });
  return {
    txt: async (n) => (await zLimitem(r.resolveTxt(n), n)).map((fragmenty) => fragmenty.join("")),
    mx: (n) => zLimitem(r.resolveMx(n), n),
    cname: (n) => zLimitem(r.resolveCname(n), n),
    a: (n) => zLimitem(r.resolve4(n), n),
    aaaa: (n) => zLimitem(r.resolve6(n), n),
    ns: (n) => zLimitem(r.resolveNs(n), n),
  };
}
