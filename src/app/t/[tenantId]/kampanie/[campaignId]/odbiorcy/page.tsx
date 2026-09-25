import Link from "next/link";
import { ListChecks, Users } from "lucide-react";
import { wymaganyTenant } from "../../../../../autoryzacja";
import { getPool } from "../../../../../../adapters/db/pool";
import { policzOdbiorcow } from "../../../../../../usecases/policz-odbiorcow";
import { odmien } from "../../../../../../domain/liczebniki";
import { TabelaOdbiorcow } from "./tabela-odbiorcow";
import { Komunikat, kampaniaKreatora, RamaKreatora, StopkaKroku } from "../kreator";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kampania · odbiorcy" };

/**
 * Krok 1 kreatora: do kogo idzie kampania. Układ jak „Send to / Don't send to" w Klaviyo:
 * listy i segmenty dodają odbiorców, zaznaczone po prawej ich odejmują. Liczby po prawej
 * to ta sama bramka zgód i wykluczeń, którą silnik przejdzie tuż przed wysyłką.
 */
export default async function KrokOdbiorcy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; campaignId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId: surowy, campaignId } = await params;
  const { tenantId } = await wymaganyTenant(surowy);
  const { ok, blad } = await searchParams;
  const kampania = await kampaniaKreatora(tenantId, campaignId);
  const pool = getPool();
  const [listy, segmenty, wybrane, odbiorcy] = await Promise.all([
    pool.query(
      `select l.id::text, l.name, count(m.profile_id)::int as ile
         from lists l left join list_members m on m.tenant_id = l.tenant_id and m.list_id = l.id
        where l.tenant_id = $1 group by l.id, l.name order by l.name`,
      [tenantId],
    ),
    pool.query("select id::text, name from segments where tenant_id = $1 order by name", [tenantId]),
    pool.query(
      "select mode, source_type, source_id::text from campaign_audience where tenant_id = $1 and campaign_id = $2",
      [tenantId, campaignId],
    ),
    policzOdbiorcow(tenantId, campaignId),
  ]);
  const zaznaczone = new Set(wybrane.rows.map((r) => `${r.mode}|${r.source_type}:${r.source_id}`));
  const zrodla = [
    ...listy.rows.map((l) => ({ klucz: `list:${l.id}`, nazwa: l.name as string, typ: "Lista", opis: odmien(l.ile, "profil", "profile", "profili") })),
    ...segmenty.rows.map((s) => ({ klucz: `segment:${s.id}`, nazwa: s.name as string, typ: "Segment", opis: "dynamiczny" })),
  ];
  const zablokowane = kampania.poWysylce;

  const nazwaZrodla = (typ: string, id: string) =>
    (typ === "list" ? listy.rows : segmenty.rows).find((r) => r.id === id)?.name ?? "?";
  const wlaczone = wybrane.rows.filter((r) => r.mode === "include").map((r) => nazwaZrodla(r.source_type, r.source_id));
  const wykluczone = wybrane.rows.filter((r) => r.mode === "exclude").map((r) => nazwaZrodla(r.source_type, r.source_id));
  const sumaZrodel = odbiorcy.zrodla.filter((z) => z.mode === "include").reduce((a, z) => a + z.ile, 0);
  const trybZrodla = (klucz: string) =>
    zaznaczone.has(`include|${klucz}`) ? "wlacz" : zaznaczone.has(`exclude|${klucz}`) ? "wylacz" : "";

  return (
    <>
      <RamaKreatora tenantId={tenantId} kampania={kampania} aktywny="odbiorcy" />
      <Komunikat ok={ok} blad={blad} />
      <div>
        <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          {zrodla.length === 0 ? (
            <div className="karta pusty-stan">
              <h2>Na tym koncie nie ma jeszcze list ani segmentów.</h2>
              <p>Kampania idzie do list i segmentów. Załóż pierwszą listę albo segment i wróć tutaj.</p>
              <Link href={`/t/${tenantId}/segmenty`} className="przycisk">
                Załóż segment
              </Link>
            </div>
          ) : (
            <TabelaOdbiorcow
              tenantId={tenantId}
              campaignId={campaignId}
              zrodla={zrodla.map((z) => ({ klucz: z.klucz, nazwa: z.nazwa, typ: z.typ, opis: z.opis }))}
              poczatkowe={Object.fromEntries(zrodla.map((z) => [z.klucz, trybZrodla(z.klucz)]))}
              zablokowane={zablokowane}
            />
          )}

          <aside className="karta h-fit">
            <div className="karta-naglowek">
              <h2 className="flex items-center gap-2">
                <Users size={16} className="text-[var(--color-tekst-3)]" aria-hidden="true" />
                Kto dostanie maila
              </h2>
            </div>
            <div className="p-4">
              <div className="etykieta">Do wysyłki po sprawdzeniu zgód i wykluczeń</div>
              <div className="wielkosc-hero mt-1">{odbiorcy.docelowo}</div>
              <p className="karta-opis mt-1">stan zapisanego wyboru, liczony na teraz</p>
              <dl className="mt-4 space-y-2 text-[13px]">
                <div className="flex items-center justify-between text-[var(--color-tekst-2)]">
                  <dt>Suma profili w źródłach „Wyślij”</dt>
                  <dd className="liczba">{sumaZrodel}</dd>
                </div>
                <div className="flex items-center justify-between font-medium" title="Profil obecny w kilku źródłach liczymy raz; profile ze źródeł „Wyklucz” odpadają">
                  <dt>Po scaleniu duplikatów i „Wyklucz”</dt>
                  <dd className="liczba">{odbiorcy.kandydaci}</dd>
                </div>
                {[
                  ["Bez zgody na e-mail", odbiorcy.bezZgody],
                  ["Wykluczeni na tym koncie", odbiorcy.wykluczeniLokalnie],
                  ["Wykluczeni globalnie", odbiorcy.wykluczeniGlobalnie],
                  ["Bez adresu e-mail", odbiorcy.bezAdresu],
                ].map(([etykieta, ile]) => (
                  <div key={String(etykieta)} className="flex items-center justify-between">
                    <dt className="text-[var(--color-tekst-2)]">− {String(etykieta).toLowerCase()}</dt>
                    <dd className="liczba text-[var(--color-tekst-2)]">{ile}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t border-[var(--color-linia)] pt-2 font-semibold">
                  <dt>= do wysyłki</dt>
                  <dd className="liczba">{odbiorcy.docelowo}</dd>
                </div>
              </dl>
              {odbiorcy.probka.length ? (
                <div className="mt-4 border-t border-[var(--color-linia)] pt-3">
                  <div className="etykieta mb-2">Przykładowi odbiorcy</div>
                  <ul className="space-y-1 text-[13px] text-[var(--color-tekst-2)]">
                    {odbiorcy.probka.slice(0, 5).map((p, i) => (
                      <li key={i} className="truncate">
                        {[p.imie, p.nazwisko].filter(Boolean).join(" ") || p.email}
                        {p.imie || p.nazwisko ? <span className="text-[var(--color-tekst-3)]"> · {p.email}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="karta-stopka">
              <ListChecks size={14} aria-hidden="true" />
              Liczby opisują zapisany wybór. Wiążące sprawdzenie zgód silnik robi tuż przed wysyłką.
            </div>
          </aside>
        </div>
        <StopkaKroku tenantId={tenantId} campaignId={campaignId} aktywny="odbiorcy">
          {zablokowane ? (
            <span className="text-[13px] text-[var(--color-tekst-2)]">wysyłka już ruszyła — odbiorcy są zamrożeni</span>
          ) : null}
          <Link href={`/t/${tenantId}/kampanie/${campaignId}/tresc`} className="przycisk">
            Dalej: treść →
          </Link>
        </StopkaKroku>
      </div>
    </>
  );
}
