/** Dane firmy w stopce: nazwa, adres, NIP. Wspólne dla ekranu wysyłki i onboardingu. */
import type { DaneNadawcy } from "../../../../../usecases/wysylka-konfiguracja/dane-nadawcy";
import { zapiszDaneNadawcyAkcja } from "./akcje";
import { PrzyciskAkcji } from "./przycisk";

export function FormularzDanychFirmy({ tenantId, dane, powrot }: { tenantId: string; dane: DaneNadawcy; powrot?: "przeglad" }) {
  return (
    <form action={zapiszDaneNadawcyAkcja} className="space-y-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      {powrot ? <input type="hidden" name="powrot" value={powrot} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="etykieta mb-1.5 block">Nazwa firmy</span>
          <input name="firma" required defaultValue={dane.firma ?? ""} placeholder="np. Sklep Kowalski sp. z o.o." className="pole" maxLength={200} />
        </label>
        <label className="block">
          <span className="etykieta mb-1.5 block">NIP (opcjonalnie)</span>
          <input name="nip" defaultValue={dane.nip ?? ""} placeholder="np. 1234567890" className="pole liczba" maxLength={30} />
        </label>
      </div>
      <label className="block">
        <span className="etykieta mb-1.5 block">Adres firmy</span>
        <textarea name="adres" required defaultValue={dane.adres ?? ""} placeholder={"ul. Przykładowa 1\n00-001 Warszawa"} rows={2} className="pole" maxLength={500} />
      </label>
      <PrzyciskAkcji trwa="Zapisuję…" wariant="" maly={false}>
        Zapisz dane firmy
      </PrzyciskAkcji>
    </form>
  );
}

export function SekcjaDanychFirmy({ tenantId, dane }: { tenantId: string; dane: DaneNadawcy }) {
  return (
    <section id="dane-firmy" className="karta overflow-hidden scroll-mt-24">
      <div className="karta-naglowek">
        <div className="min-w-0">
          <h2>Dane firmy w stopce</h2>
          <p className="karta-opis">Każdy newsletter ma w stopce nazwę i adres firmy. Bez adresu żaden mail nie wyjdzie.</p>
        </div>
      </div>
      <div className="p-6 max-md:p-4">
        <FormularzDanychFirmy tenantId={tenantId} dane={dane} />
      </div>
    </section>
  );
}
