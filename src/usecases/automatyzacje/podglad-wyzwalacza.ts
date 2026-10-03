import { getPool } from "../../adapters/db/pool";
import { schematGrafu, wyzwalaczGrafu } from "../../domain/automatyzacje/graf";
import { regulaCzasu, type PowodOdrzucenia } from "../../domain/automatyzacje/wyzwalanie";
import { BladKontekstuFiltra, filtrPusty, ocenFiltr } from "../../domain/filtry";
import { profilSpelnia } from "./bramka-filtrow";

/**
 * Podglad wyzwalacza (E4b 4.10, plan 3.5): ostatnie zdarzenia metryki wyzwalacza z 30 dni
 * i werdykt dla kazdego, liczony na SZKICU z kanwy (operator widzi skutek filtrow, zanim je
 * wlaczy). Te same reguly co silnik: regula czasu AD-39 (bez "sprzed wlaczenia", bo to
 * podglad hipotetyczny), filtr wyzwalacza (TS, jak w silniku), filtr profilu (SQL, z "od
 * startu flow" = czas tego zdarzenia), ponowne wejscie w trybie "raz".
 * Tylko odczyt. Tenant z sesji (akcja), flow i zdarzenia wylacznie w jego granicach.
 */

export const LIMIT_PODGLADU = 200;
export const DNI_PODGLADU = 30;

export type PowodPodgladu = PowodOdrzucenia | "filtr_profilu" | "brak_adresu" | "juz_w_automatyzacji" | "ponowne_wejscie" | "blad_filtra";

export const OPISY_PODGLADU: Record<PowodPodgladu, string> = {
  backfill: "zdarzenie z uzupełnienia historii",
  import: "zdarzenie z importu historii",
  spoznione: "dotarło ponad 4 godziny po fakcie",
  z_przyszlosci: "data zdarzenia z przyszłości",
  sprzed_wlaczenia: "sprzed włączenia automatyzacji",
  filtr_wyzwalacza: "nie pasuje do filtra wyzwalacza",
  filtr_profilu: "nie pasuje do filtra profilu",
  brak_adresu: "brak adresu e-mail",
  juz_w_automatyzacji: "już była w tej automatyzacji",
  ponowne_wejscie: "weszła już wcześniejszym zdarzeniem",
  blad_filtra: "filtra nie da się policzyć",
};

export interface WierszPodgladu {
  eventId: string;
  profileId: string | null;
  email: string | null;
  kiedy: string;
  wszedlby: boolean;
  powod: PowodPodgladu | null;
  opis: string;
}

export type WynikPodgladu =
  | { ok: true; wiersze: WierszPodgladu[]; weszloby: number; przeanalizowane: number; dni: number }
  | { ok: false; blad: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function podgladWyzwalacza(tenantId: string, flowId: string, grafSurowy: unknown): Promise<WynikPodgladu> {
  if (!UUID.test(flowId)) return { ok: false, blad: "Automatyzacja nie istnieje." };
  const parsed = schematGrafu.safeParse(typeof grafSurowy === "string" ? safeJson(grafSurowy) : grafSurowy);
  if (!parsed.success) return { ok: false, blad: "Szkic ma niedokończone kroki. Uzupełnij je, żeby zobaczyć podgląd." };
  const g = parsed.data;
  const w = wyzwalaczGrafu(g);
  if (!w || w.zrodlo.rodzaj !== "metryka") return { ok: false, blad: "Podgląd działa dla wyzwalaczy opartych na metryce (zdarzeniu)." };
  const zrodlo = w.zrodlo;
  const pool = getPool();
  const { rows: flow } = await pool.query("select 1 from flows where tenant_id = $1 and id = $2", [tenantId, flowId]);
  if (!flow[0]) return { ok: false, blad: "Automatyzacja nie istnieje." };

  const { rows } = await pool.query(
    `select e.id, e.profile_id, p.email, e.occurred_at::text as occurred_at, e.properties, e.source, e.backfill,
            extract(epoch from e.occurred_at) * 1000 as occurred_ms,
            extract(epoch from e.recorded_at) * 1000 as recorded_ms,
            extract(epoch from e.ingested_at) * 1000 as ingested_ms,
            exists (select 1 from flow_participants fp where fp.tenant_id = e.tenant_id and fp.flow_id = $4 and fp.profile_id = e.profile_id) as byl
       from metric_events e
       join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
       left join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
      where e.tenant_id = $1 and m.integration_key = $2 and m.name = $3
        and e.occurred_at >= now() - make_interval(days => $5::int)
      order by e.occurred_at desc, e.id desc
      limit $6`,
    [tenantId, zrodlo.metryka.integracja, zrodlo.metryka.nazwa, flowId, DNI_PODGLADU, LIMIT_PODGLADU],
  );
  const teraz = new Date();
  const raz = g.ustawienia.ponowneWejscie.tryb === "raz";
  const weszli = new Set<string>();
  const wynik: WierszPodgladu[] = [];
  // rosnaco po czasie: przy "raz" pierwsze pasujace zdarzenie osoby decyduje (jak silnik)
  for (const r of [...rows].reverse()) {
    let powod: PowodPodgladu | null = null;
    if (!r.profile_id || !r.email) powod = "brak_adresu";
    else {
      powod = regulaCzasu({
        occurredAtMs: Number(r.occurred_ms), recordedAtMs: Number(r.recorded_ms), ingestedAtMs: Number(r.ingested_ms),
        backfill: r.backfill === true, source: r.source,
      }, 0);
      if (!powod && !ocenFiltr(zrodlo.filtr, { zdarzenie: r.properties ?? {}, teraz })) powod = "filtr_wyzwalacza";
      if (!powod && raz && r.byl) powod = "juz_w_automatyzacji";
      if (!powod && raz && weszli.has(r.profile_id)) powod = "ponowne_wejscie";
      if (!powod && !filtrPusty(g.ustawienia.filtrProfilu)) {
        try {
          const ok = await profilSpelnia(pool, tenantId, r.profile_id, g.ustawienia.filtrProfilu, { flowId, start: r.occurred_at, zdarzenieWyzwalajaceId: r.id, uczestnikId: null }, teraz);
          if (!ok) powod = "filtr_profilu";
        } catch (b) {
          if (!(b instanceof BladKontekstuFiltra)) throw b;
          powod = "blad_filtra";
        }
      }
    }
    if (!powod && r.profile_id) weszli.add(r.profile_id);
    wynik.push({ eventId: r.id, profileId: r.profile_id, email: r.email, kiedy: r.occurred_at, wszedlby: !powod, powod, opis: powod ? OPISY_PODGLADU[powod] : "wejdzie" });
  }
  wynik.reverse();
  return { ok: true, wiersze: wynik, weszloby: weszli.size, przeanalizowane: rows.length, dni: DNI_PODGLADU };
}

function safeJson(s: string): unknown {
  if (s.length > 500_000) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
