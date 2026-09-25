import { listyTenanta } from "../../../../adapters/db/repozytoria";
import { odmien } from "../../../../domain/liczebniki";
import { wymaganyTenant } from "../../../autoryzacja";
import { utworzListeAkcja } from "../../../akcje";
import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, Icon, ResponsiveTable, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Listy" };

export default async function Listy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const listy = await listyTenanta(tenantId);

  return (
    <>
      <Naglowek
        tytul="Listy"
        opis="Lista to statyczny zbiór osób, na przykład zapisy z formularza albo import ze sklepu. Różnica wobec segmentu jest istotna przy sporze o zgodę: lista pamięta, kto i kiedy do niej wszedł, a segment tylko opisuje warunek."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <Card>
          <CardHeader
            title="Listy statyczne"
            description="Osoby zostają na liście do czasu świadomego dodania albo usunięcia."
            action={<span className="karta-naglowek-licznik">{odmien(listy.length, "lista", "listy", "list")}</span>}
          />
          {listy.length === 0 ? (
            <EmptyState icon="lista" title="Nie ma jeszcze żadnej listy" description="Utwórz pierwszą listę obok. Potem trafią do niej zapisy z formularza albo ręcznie dobrane osoby." />
          ) : (
            <ResponsiveTable table={<Table className="min-w-[620px]">
              <THead><tr><Th>Nazwa</Th><Th>Typ</Th><Th>Opis</Th><Th num>Profile</Th></tr></THead>
              <TBody>
                  {listy.map((l: any) => (
                    <tr key={l.id} className="wiersz-link">
                      <Td><div className="flex items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"><Icon name="lista" size={17} /></span><Link href={`/t/${tenantId}/listy/${l.id}`} className="wiersz-link-cel font-semibold">{l.name}</Link></div></Td>
                      <Td><Badge>statyczna</Badge></Td>
                      <Td className="max-w-[420px] text-[var(--color-tekst-2)]">{l.description ?? "Brak opisu"}</Td>
                      <Td num>{l.czlonkow}</Td>
                    </tr>
                  ))}
              </TBody>
            </Table>} mobile={<div>
              {listy.map((l: any) => <Link key={l.id} href={`/t/${tenantId}/listy/${l.id}`} className="lista-mobilna-element">
                <div className="lista-mobilna-wiersz"><div className="lista-mobilna-tytul">{l.name}</div><div className="lista-mobilna-wartosc">{odmien(l.czlonkow, "profil", "profile", "profili")}</div></div>
                <div className="lista-mobilna-meta">{l.description ?? "Brak opisu"}</div>
              </Link>)}
            </div>} />
          )}
        </Card>

        <Card className="h-fit">
          <CardHeader title="Nowa lista" description="Utwórz stałą grupę odbiorców dla importów i formularzy zapisu." />
          <form action={utworzListeAkcja} className="formularz-sekcja">
            <input type="hidden" name="tenantId" value={tenantId} />
            <div className="formularz-sekcja-opis"><h3>Dane listy</h3><p>Nazwa widoczna przy formularzach i wyborze odbiorców.</p></div>
            <div className="formularz-sekcja-pola grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="etykieta mb-1.5 block">Nazwa listy</span>
                <input name="nazwa" required placeholder="np. Zapisy z popupu" className="pole" />
              </label>
              <label className="block">
                <span className="etykieta mb-1.5 block">Opis</span>
                <input name="opis" placeholder="skąd pochodzą te osoby" className="pole" />
              </label>
              <button className="przycisk min-w-40 justify-center sm:col-span-2 sm:w-fit" type="submit">Utwórz listę</button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
