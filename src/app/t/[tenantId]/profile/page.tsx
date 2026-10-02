import Link from "next/link";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { zGroszy } from "../../../../domain/kwoty";
import { odmien } from "../../../../domain/liczebniki";
import { STANY_ZGODY, stronaProfili, zanonimizowaneSposrod, type StanZgodyFiltr } from "../../../../usecases/lista-profili";
import { Search } from "lucide-react";
import { Badge, Button, Card, CardHeader, EmptyState, ResponsiveTable, Table, TBody, Td, Th, THead } from "../../../ui";
import { Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Profile" };

const ETYKIETY_ZGODY: Record<StanZgodyFiltr, string> = { granted: "Zgoda", withdrawn: "Wycofana", brak: "Bez wpisu" };
const TONY_ZGODY: Record<StanZgodyFiltr, "ok" | "blad" | "nieaktywna"> = { granted: "ok", withdrawn: "blad", brak: "nieaktywna" };

function jedno(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function Profile({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const sp = await searchParams;
  const q = (jedno(sp.q) ?? "").slice(0, 100);
  const zgodaSurowa = jedno(sp.zgoda) ?? "";
  const zgoda = (STANY_ZGODY as readonly string[]).includes(zgodaSurowa) ? (zgodaSurowa as StanZgodyFiltr) : "";
  const strona = await stronaProfili(tenantId, { q, zgoda, po: jedno(sp.po), przed: jedno(sp.przed) });
  const profile = strona.wiersze;
  // osoby po żądaniu usunięcia danych mają zostać rozpoznawalne na liście,
  // inaczej wiersz bez nazwiska wygląda jak niedokończony import (tylko wiersze tej strony)
  const zanonimizowane = await zanonimizowaneSposrod(tenantId, profile.map((p) => p.id));
  const filtrowane = Boolean(q.trim() || zgoda);
  const adres = (zmiany: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const wszystko = { q: q.trim() || undefined, zgoda: zgoda || undefined, ...zmiany };
    for (const [k, v] of Object.entries(wszystko)) if (v) u.set(k, v);
    const t = u.toString();
    return `/t/${tenantId}/profile${t ? `?${t}` : ""}`;
  };
  const chip = (wartosc: StanZgodyFiltr | "", etykieta: string) => (
    <Link
      key={wartosc || "wszystkie"}
      href={adres({ zgoda: wartosc || undefined, po: undefined, przed: undefined })}
      aria-current={zgoda === wartosc ? "true" : undefined}
      className={`inline-flex min-h-9 items-center rounded-full border px-3 text-[13px] font-medium transition-colors ${zgoda === wartosc ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "border-[var(--color-linia)] bg-white text-[var(--color-tekst-2)] hover:border-[var(--color-linia-mocna)] hover:text-[var(--color-tekst)]"}`}
    >
      {etykieta}
    </Link>
  );

  const inicjaly = (imie: string | null, nazwisko: string | null, email: string | null) => {
    const zNazwy = [imie, nazwisko].filter(Boolean).map((czesc) => String(czesc).slice(0, 1)).join("");
    return (zNazwy || email?.slice(0, 1) || "?").toUpperCase();
  };

  return (
    <>
      <Naglowek
        tytul="Profile"
        opis="Tożsamość profilu to znormalizowany adres e-mail: bez wielkości liter i bez spacji na brzegach. Dzięki temu Anna@Sklep.pl i anna@sklep.pl to jedna osoba, a nie dwie kartoteki. Kliknięcie w wiersz otwiera kartotekę osoby: zgody z datą i źródłem, oś czasu, historia wysyłek oraz eksport i usunięcie danych."
        akcja={
          <span className="tekst-licznik !text-[var(--color-tekst-3)]">
            {odmien(strona.razem, "osoba", "osoby", "osób").replace(/^(\d+)/, (n) => Number(n).toLocaleString("pl-PL"))}{filtrowane ? " pasuje" : ""}
          </span>
        }
      />
      <div className="tresc-strony">
        <Card>
          <CardHeader
            title="Baza odbiorców"
            description="Najnowsze profile są u góry. Szukaj po początku adresu, imienia, nazwiska albo numeru telefonu."
          />
          <div className="flex flex-col gap-3 border-b border-[var(--color-linia-0)] px-6 pb-4 max-md:px-4">
            <form role="search" action={`/t/${tenantId}/profile`} className="flex gap-2">
              {zgoda ? <input type="hidden" name="zgoda" value={zgoda} /> : null}
              <label htmlFor="szukaj-profilu" className="sr-only">Szukaj osoby</label>
              <div className="relative min-w-0 flex-1 sm:max-w-[420px]">
                <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-tekst-3)]" />
                <input
                  id="szukaj-profilu"
                  name="q"
                  type="search"
                  defaultValue={q}
                  maxLength={100}
                  autoComplete="off"
                  placeholder="E-mail, imię, nazwisko albo telefon"
                  className="pole !pl-9"
                />
              </div>
              <Button type="submit" variant="secondary">Szukaj</Button>
              {filtrowane ? <Button href={`/t/${tenantId}/profile`} variant="secondary" className="max-sm:hidden">Wyczyść</Button> : null}
            </form>
            <div className="flex flex-wrap items-center gap-2" aria-label="Stan zgody e-mail">
              <span className="etykieta mr-1">Zgoda e-mail</span>
              {chip("", "Wszystkie")}
              {STANY_ZGODY.map((z) => chip(z, ETYKIETY_ZGODY[z]))}
            </div>
          </div>
          {profile.length === 0 && filtrowane ? (
            <EmptyState
              icon="profil"
              title="Nikt nie pasuje"
              description={q.trim() ? `Brak osób, których e-mail, imię, nazwisko albo telefon zaczyna się od „${q.trim()}”${zgoda ? " przy wybranym stanie zgody" : ""}.` : "Brak osób w tym stanie zgody."}
              action={<Button href={`/t/${tenantId}/profile`} variant="secondary">Pokaż wszystkich</Button>}
            />
          ) : profile.length === 0 ? (
            <EmptyState
              icon="profil"
              title="Baza odbiorców jest pusta"
              description="Profile powstaną po zaimportowaniu historii podłączonego sklepu."
              action={<Button href={`/t/${tenantId}/sklepy`} variant="secondary">Przejdź do ustawień sklepu</Button>}
            />
          ) : (
            <ResponsiveTable table={<Table className="min-w-[760px]">
              <THead>
                <tr>
                  <Th>Profil</Th>
                  <Th>Zgoda e-mail</Th>
                  <Th>W bazie od</Th>
                  <Th num>Zamówienia</Th>
                  <Th num>Wartość opłaconych</Th>
                  <Th num>Ostatni zakup</Th>
                </tr>
              </THead>
              <TBody>
                {profile.map((p) => {
                  const usuniety = zanonimizowane.has(p.id);
                  const nazwa = [p.first_name, p.last_name].filter(Boolean).join(" ") || (usuniety ? "Dane usunięte na żądanie" : "Bez nazwiska");
                  return (
                    <tr key={p.id} className="wiersz-link">
                      <Td>
                        <div className="flex items-center gap-3">
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-akcent-tlo)] text-[13px] font-semibold text-[var(--color-akcent)]">
                            {usuniety ? "—" : inicjaly(p.first_name, p.last_name, p.email)}
                          </span>
                          <div className="min-w-0">
                        <Link
                          href={`/t/${tenantId}/profile/${p.id}`}
                          className="wiersz-link-cel"
                          prefetch={false}
                        >
                              {nazwa}
                        </Link>
                            <div className="tekst-pomocniczy mt-0.5 truncate !text-[var(--color-tekst-3)]">
                              {p.email ?? (usuniety ? "adres usunięty" : "brak adresu")}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td>{usuniety ? <Badge ton="uwaga">zanonimizowane</Badge> : !p.email ? <Badge ton="nieaktywna">brak e-mail</Badge> : <Badge ton={TONY_ZGODY[p.zgoda]}>{ETYKIETY_ZGODY[p.zgoda].toLowerCase()}</Badge>}</Td>
                      <Td className="liczba text-[var(--color-tekst-2)]">{formatujDate(p.created_at)}</Td>
                      <Td num>{p.zamowien}</Td>
                      <Td num className="font-medium">
                        {zGroszy(Number(p.wydal_minor ?? 0))}
                      </Td>
                      <Td num className="text-[var(--color-tekst-2)]">
                        {formatujDate(p.ostatnie)}
                      </Td>
                    </tr>
                  );
                })}
              </TBody>
            </Table>} mobile={<div>
              {profile.map((p) => {
                const usuniety = zanonimizowane.has(p.id);
                const nazwa = [p.first_name, p.last_name].filter(Boolean).join(" ") || (usuniety ? "Dane usunięte na żądanie" : "Bez nazwiska");
                return (
                  <Link key={p.id} href={`/t/${tenantId}/profile/${p.id}`} prefetch={false} className="lista-mobilna-element">
                    <div className="lista-mobilna-wiersz">
                      <div className="min-w-0">
                        <div className="lista-mobilna-tytul truncate">{nazwa}</div>
                        <div className="lista-mobilna-meta truncate">{p.email ?? (usuniety ? "adres usunięty" : "brak adresu")}</div>
                        <div className="lista-mobilna-meta">w bazie od <span className="liczba">{formatujDate(p.created_at)}</span></div>
                      </div>
                      <div className="lista-mobilna-wartosc">{zGroszy(Number(p.wydal_minor ?? 0))}</div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      {usuniety ? <Badge ton="uwaga">zanonimizowane</Badge> : !p.email ? <Badge ton="nieaktywna">brak e-mail</Badge> : <Badge ton={TONY_ZGODY[p.zgoda]}>{ETYKIETY_ZGODY[p.zgoda].toLowerCase()}</Badge>}
                      <span className="tekst-licznik text-[12px]">{odmien(p.zamowien, "zamówienie", "zamówienia", "zamówień")}{p.ostatnie ? <> · ostatni <span className="liczba">{formatujDate(p.ostatnie)}</span></> : null}</span>
                    </div>
                  </Link>
                );
              })}
            </div>} />
          )}
          {strona.dalej || strona.wstecz ? (
            <nav aria-label="Strony listy profili" className="flex items-center justify-between gap-3 border-t border-[var(--color-linia-0)] px-6 py-3 max-md:px-4">
              <span className="tekst-meta">{profile.length} z {strona.razem.toLocaleString("pl-PL")} na tej stronie</span>
              <div className="flex gap-2">
                {strona.wstecz ? <Button href={adres({ przed: strona.wstecz })} variant="secondary" size="sm">Nowsze</Button> : null}
                {strona.wstecz ? <Button href={adres({})} variant="secondary" size="sm" className="max-sm:hidden">Na początek</Button> : null}
                {strona.dalej ? <Button href={adres({ po: strona.dalej })} variant="secondary" size="sm">Starsze</Button> : null}
              </div>
            </nav>
          ) : null}
        </Card>
      </div>
    </>
  );
}
