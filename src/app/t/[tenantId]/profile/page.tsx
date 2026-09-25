import Link from "next/link";
import { profileTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { zGroszy } from "../../../../domain/kwoty";
import { odmien } from "../../../../domain/liczebniki";
import { zanonimizowaneProfile } from "../../../../usecases/profil";
import { Badge, Button, Card, CardHeader, EmptyState, ResponsiveTable, Table, TBody, Td, Th, THead } from "../../../ui";
import { Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Profile" };

export default async function Profile({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const [profile, zanonimizowane] = await Promise.all([
    profileTenanta(tenantId, 200),
    // osoby po żądaniu usunięcia danych mają zostać rozpoznawalne na liście,
    // inaczej wiersz bez nazwiska wygląda jak niedokończony import
    zanonimizowaneProfile(tenantId),
  ]);

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
            {odmien(profile.length, "profil", "profile", "profili")}
          </span>
        }
      />
      <div className="tresc-strony">
        <Card>
          <CardHeader
            title="Baza odbiorców"
            description={`Najnowsze zakupy są u góry.${profile.length === 200 ? " Pokazujemy pierwsze 200 profili." : ""}`}
          />
          {profile.length === 0 ? (
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
                  <Th>Dane kontaktowe</Th>
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
                      <Td><Badge ton={usuniety ? "uwaga" : p.email ? "ok" : "nieaktywna"}>{usuniety ? "zanonimizowane" : p.email ? "e-mail zapisany" : "brak e-mail"}</Badge></Td>
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
                      <Badge ton={usuniety ? "uwaga" : p.email ? "ok" : "nieaktywna"}>{usuniety ? "zanonimizowane" : p.email ? "e-mail zapisany" : "brak e-mail"}</Badge>
                      <span className="tekst-licznik text-[12px]">{odmien(p.zamowien, "zamówienie", "zamówienia", "zamówień")}{p.ostatnie ? <> · ostatni <span className="liczba">{formatujDate(p.ostatnie)}</span></> : null}</span>
                    </div>
                  </Link>
                );
              })}
            </div>} />
          )}
        </Card>
      </div>
    </>
  );
}
