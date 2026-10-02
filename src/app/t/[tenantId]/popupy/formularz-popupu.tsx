"use client";

import { useActionState, useState } from "react";
import { utworzPopupAkcja, zmienKlauzuleAkcja } from "./akcje";
import { Alert, Field, Input, PrzyciskFormularza, Select, Textarea } from "../../../ui";

export interface ListaDoWyboru {
  id: string;
  name: string;
}

/**
 * Podglad klauzuli dokladnie tak, jak zobaczy ja osoba w popupie: pole wyboru (niezaznaczone),
 * tekst bez zmian i link do polityki. Ten sam tekst trafi do rejestru zgod jako dowod.
 */
function PodgladKlauzuli({ tekst, adres }: { tekst: string; adres: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-[var(--color-linia-mocna)] bg-[var(--color-powierzchnia-2)] px-4 py-3" aria-label="Podgląd klauzuli w formularzu">
      <div className="etykieta mb-2">Tak to zobaczy osoba w sklepie</div>
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-[2px] h-4 w-4 shrink-0 rounded-[4px] border border-[var(--color-linia-mocna)] bg-white" />
        <p className="whitespace-pre-line text-[12px] leading-[17px] text-[var(--color-tekst-2)]">{tekst.trim() || "Wpisz treść klauzuli."}</p>
      </div>
      {adres.trim() ? <p className="mt-1 pl-6 text-[12px] text-[var(--color-tekst-2)] underline">Polityka prywatności</p> : null}
    </div>
  );
}

function PolaKlauzuli({
  listy,
  domyslne,
}: {
  listy: ListaDoWyboru[];
  domyslne: { consentWording: string; privacyUrl: string; listId: string };
}) {
  const [tekst, setTekst] = useState(domyslne.consentWording);
  const [adres, setAdres] = useState(domyslne.privacyUrl);
  return (
    <div className="space-y-4">
      <Field label="Zapisz na listę" htmlFor="listId" hint="Osoba trafia na tę listę po zapisie. To uruchamia automatyzacje z wyzwalaczem „dołączenie do listy”.">
        <Select id="listId" name="listId" defaultValue={domyslne.listId}>
          <option value="">Nie zapisuj na żadną listę</option>
          {listy.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      </Field>
      <Field label="Klauzula zgody" htmlFor="consentWording" hint="Wyświetla się przy niezaznaczonym polu wyboru. Bez zaznaczenia zapis nie przejdzie. Zmiana tekstu tworzy nową wersję klauzuli.">
        <Textarea id="consentWording" name="consentWording" required minLength={20} maxLength={2000} rows={4} value={tekst} onChange={(e) => setTekst(e.target.value)} />
      </Field>
      <Field label="Adres polityki prywatności" htmlFor="privacyUrl" hint="Pod klauzulą pojawi się link „Polityka prywatności”.">
        <Input id="privacyUrl" name="privacyUrl" type="url" inputMode="url" placeholder="https://twojsklep.pl/polityka-prywatnosci" maxLength={500} value={adres} onChange={(e) => setAdres(e.target.value)} />
      </Field>
      <PodgladKlauzuli tekst={tekst} adres={adres} />
    </div>
  );
}

// Formularz nowego popupu przez useActionState (audyt B4): "Treść jest za długa"
// nie kasuje już nagłówka, treści, przycisku i kodu naraz - wszystko wraca do pól.
export function FormularzPopupu({ tenantId, listy, domyslnaKlauzula }: { tenantId: string; listy: ListaDoWyboru[]; domyslnaKlauzula: string }) {
  const [stan, akcja, trwa] = useActionState(utworzPopupAkcja, undefined);

  return (
    <form action={akcja}>
      <input type="hidden" name="tenantId" value={tenantId} />
      {stan?.blad ? <div className="p-6 max-md:p-4"><Alert tone="blad" title="Nie udało się zapisać formularza">{stan.blad}</Alert></div> : null}

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis"><h3>Podstawy</h3><p>Nazwa porządkuje formularze w panelu; nagłówek zobaczy klient sklepu.</p></div>
        <div className="formularz-sekcja-pola grid gap-4 sm:grid-cols-2">
          <Field label="Nazwa robocza" htmlFor="name">
            <Input id="name" name="name" required placeholder="np. Rabat powitalny" defaultValue={stan?.wartosci?.name ?? ""} />
          </Field>
          <Field label="Nagłówek" htmlFor="headline">
            <Input id="headline" name="headline" required placeholder="np. -10% na pierwsze zakupy" defaultValue={stan?.wartosci?.headline ?? ""} />
          </Field>
        </div>
      </section>

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis"><h3>Treść</h3><p>Krótki komunikat, wezwanie do działania i opcjonalny kod rabatowy.</p></div>
        <div className="formularz-sekcja-pola space-y-4">
          <Field label="Treść" htmlFor="bodyText">
            <Textarea id="bodyText" name="bodyText" required rows={3} placeholder="Zostaw adres e-mail, a wyślemy Ci kod rabatowy." defaultValue={stan?.wartosci?.bodyText ?? ""} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tekst przycisku" htmlFor="buttonText">
              <Input id="buttonText" name="buttonText" required placeholder="np. Odbieram rabat" defaultValue={stan?.wartosci?.buttonText ?? ""} />
            </Field>
            <Field label="Kod rabatowy (opcjonalny)" htmlFor="discountCode">
              <Input id="discountCode" name="discountCode" placeholder="np. WITAJ10" defaultValue={stan?.wartosci?.discountCode ?? ""} />
            </Field>
          </div>
        </div>
      </section>

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis"><h3>Zgoda i lista</h3><p>Tekst zgody, który zobaczy osoba, i lista, na którą trafi. W rejestrze zgód zapisujemy dokładnie ten tekst.</p></div>
        <div className="formularz-sekcja-pola">
          <PolaKlauzuli
            listy={listy}
            domyslne={{
              consentWording: stan?.wartosci?.consentWording ?? domyslnaKlauzula,
              privacyUrl: stan?.wartosci?.privacyUrl ?? "",
              // domyślnie bez listy: zapis na listę odpala wyzwalacz list.joined, więc ma być świadomym wyborem
              listId: stan?.wartosci?.listId ?? "",
            }}
          />
        </div>
      </section>

      <section className="formularz-sekcja">
        <div className="formularz-sekcja-opis"><h3>Wyświetlanie</h3><p>Opóźnienie liczone od wejścia klienta na stronę sklepu.</p></div>
        <div className="formularz-sekcja-pola space-y-4">
          <Field label="Pokaż po (sekundy)" htmlFor="delaySeconds" className="max-w-[220px]">
            <Input id="delaySeconds" name="delaySeconds" type="number" min={0} max={600} defaultValue={stan?.wartosci?.delaySeconds ?? "5"} />
          </Field>
          <PrzyciskFormularza trwa="Zapisuję…" trwaZewnetrznie={trwa}>Zapisz formularz</PrzyciskFormularza>
        </div>
      </section>
    </form>
  );
}

/** Zmiana klauzuli i listy istniejacego formularza (nowa wersja klauzuli przy zmianie tekstu). */
export function FormularzKlauzuli({
  tenantId,
  popupId,
  listy,
  biezace,
}: {
  tenantId: string;
  popupId: string;
  listy: ListaDoWyboru[];
  biezace: { consentWording: string; privacyUrl: string; listId: string };
}) {
  const [stan, akcja, trwa] = useActionState(zmienKlauzuleAkcja, undefined);
  return (
    <form action={akcja} className="space-y-4">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="popupId" value={popupId} />
      {stan?.blad ? <Alert tone="blad" title="Nie zapisano">{stan.blad}</Alert> : null}
      <PolaKlauzuli
        listy={listy}
        domyslne={{
          consentWording: stan?.wartosci?.consentWording ?? biezace.consentWording,
          privacyUrl: stan?.wartosci?.privacyUrl ?? biezace.privacyUrl,
          listId: stan?.wartosci?.listId ?? biezace.listId,
        }}
      />
      <PrzyciskFormularza trwa="Zapisuję…" trwaZewnetrznie={trwa}>Zapisz zgodę i listę</PrzyciskFormularza>
    </form>
  );
}
