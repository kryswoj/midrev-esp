"use client";

/**
 * Interaktywne kawałki kreatora „Podłącz domenę": potwierdzenie propozycji (krok 1),
 * link dla informatyka i ciche odświeżanie widoku, gdy worker sprawdza rekordy.
 */
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { BladFormularza } from "../../../../blad-formularza";
import { Kopiuj } from "../../../../_dns/kopiuj";
import { linkInstrukcjiAkcja, podlaczDomeneAkcja } from "./akcje";

export function FormularzPodlaczenia({
  tenantId,
  wpis,
  strefa,
  prefiks,
  lokalna,
  nazwaNadawcy,
  odpowiedzDo,
  wpisJestSubdomena,
}: {
  tenantId: string;
  wpis: string;
  strefa: string;
  prefiks: string;
  lokalna: string;
  nazwaNadawcy: string;
  odpowiedzDo: string;
  /** klient wpisał już subdomenę (mail.sklep.pl) — prefiksu nie dokładamy */
  wpisJestSubdomena: boolean;
}) {
  const [stan, akcja, trwa] = useActionState(podlaczDomeneAkcja, undefined);
  const w = stan?.wartosci ?? {};
  const [pre, ustawPre] = useState(w.prefiks ?? prefiks);
  const [lok, ustawLok] = useState(w.lokalna ?? lokalna);
  const [nazwa, ustawNazwa] = useState(w.nazwaNadawcy ?? nazwaNadawcy);
  const domenaWysylkowa = wpisJestSubdomena ? wpis.split("@").pop()!.toLowerCase().replace(/^www\./, "") : pre.trim() ? `${pre.trim().toLowerCase()}.${strefa}` : strefa;
  return (
    <form action={akcja} className="space-y-5">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="wpis" value={wpis} />
      <BladFormularza blad={stan?.blad} />

      <div className="rounded-[10px] border border-[var(--color-akcent-ramka)] bg-[var(--color-akcent-tlo)] px-4 py-3.5">
        <div className="tekst-meta !text-[var(--color-tekst-2)]">Odbiorca zobaczy w polu „Od”</div>
        <div className="mt-1 break-all text-[17px] font-[650] leading-[24px] text-[var(--color-tekst)]">
          {nazwa.trim() || "Twój sklep"} <span className="font-normal text-[var(--color-tekst-2)]">&lt;{lok.trim().toLowerCase() || "newsletter"}@{domenaWysylkowa}&gt;</span>
        </div>
        {!wpisJestSubdomena && pre.trim() ? (
          <p className="mt-1.5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
            Osobny adres dla newslettera chroni zwykłą pocztę firmy: nawet gdy ktoś oznaczy newsletter jako spam, Twoje maile do klientów dochodzą jak dotąd.
          </p>
        ) : null}
        {!wpisJestSubdomena && !pre.trim() ? (
          <p className="mt-1.5 text-[13px] leading-[19px] text-[var(--color-czeka)]">
            Wysyłka z głównej domeny dzieli opinię skrzynek z Twoją zwykłą pocztą. Zalecamy zostawić „news”.
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="etykieta mb-1.5 block">Nazwa widoczna jako nadawca</span>
          <input name="nazwaNadawcy" required maxLength={200} value={nazwa} onChange={(e) => ustawNazwa(e.target.value)} className="pole" />
        </label>
        <label className="block">
          <span className="etykieta mb-1.5 block">Adres do odpowiedzi</span>
          <input name="odpowiedzDo" type="email" maxLength={320} defaultValue={w.odpowiedzDo ?? odpowiedzDo} className="pole" />
          <span className="tekst-meta mt-1.5 block">Tu trafi mail, gdy klient kliknie „Odpowiedz”.</span>
        </label>
      </div>

      <details className="rounded-[8px] border border-[var(--color-linia-0)] px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium text-[var(--color-tekst-2)]">Zmień adres w polu „Od”</summary>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="etykieta mb-1.5 block">Przed @</span>
            <input name="lokalna" value={lok} onChange={(e) => ustawLok(e.target.value)} maxLength={64} className="pole w-[160px]" autoComplete="off" />
          </label>
          <span className="pb-2.5 text-[14px] text-[var(--color-tekst-2)]">@</span>
          {wpisJestSubdomena ? (
            <span className="pb-2.5 text-[14px]">{domenaWysylkowa}</span>
          ) : (
            <>
              <label className="block">
                <span className="etykieta mb-1.5 block">Przedrostek</span>
                <input name="prefiks" value={pre} onChange={(e) => ustawPre(e.target.value)} maxLength={40} className="pole w-[120px]" autoComplete="off" />
              </label>
              <span className="pb-2.5 text-[14px] text-[var(--color-tekst-2)]">.{strefa}</span>
            </>
          )}
        </div>
      </details>

      <button className="przycisk" type="submit" disabled={trwa}>
        {trwa ? "Podłączam…" : "Podłącz domenę"}
      </button>
    </form>
  );
}

export function InstrukcjaInformatyka({ tenantId, domena }: { tenantId: string; domena: string }) {
  const [stan, akcja, trwa] = useActionState(linkInstrukcjiAkcja, undefined);
  const temat = `Rekordy DNS dla ${domena}`;
  const tresc = stan?.url
    ? `Cześć,\n\nproszę o dodanie rekordów DNS dla domeny ${domena}. Wszystko jest tutaj (link ważny 14 dni):\n${stan.url}\n\nDzięki!`
    : "";
  return (
    <div className="space-y-3">
      <form action={akcja}>
        <input type="hidden" name="tenantId" value={tenantId} />
        {stan?.url ? null : (
          <button type="submit" className="przycisk przycisk-wtorny" disabled={trwa}>
            {trwa ? "Przygotowuję link…" : "Wyślij instrukcję informatykowi"}
          </button>
        )}
      </form>
      <BladFormularza blad={stan?.blad} />
      {stan?.url ? (
        <div className="karta-plaska space-y-2 p-3">
          <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
            Prześlij ten link osobie, która zajmuje się Twoją domeną. Zobaczy tylko rekordy do wpisania. Ważny do {stan.wygasa ? new Date(stan.wygasa).toLocaleDateString("pl-PL") : "14 dni"}.
          </p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-[17px]">{stan.url}</code>
            <Kopiuj wartosc={stan.url} etykieta="link do instrukcji" />
          </div>
          <a
            className="inline-flex text-[13px] font-medium text-[var(--color-akcent)] hover:underline"
            href={`mailto:?subject=${encodeURIComponent(temat)}&body=${encodeURIComponent(tresc)}`}
          >
            Otwórz w programie pocztowym
          </a>
          <form
            action={akcja}
            onSubmit={(e) => {
              if (!window.confirm("Poprzedni link przestanie działać. Utworzyć nowy?")) e.preventDefault();
            }}
          >
            <input type="hidden" name="tenantId" value={tenantId} />
            <button type="submit" disabled={trwa} className="text-[12px] text-[var(--color-tekst-3)] underline hover:text-[var(--color-blad)]">
              {trwa ? "Tworzę nowy link…" : "Unieważnij i utwórz nowy link"}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

/** Ciche odświeżenie widoku co minutę, dopóki domena nie jest gotowa (sprawdza worker). */
export function Odswiezanie({ aktywne }: { aktywne: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!aktywne) return;
    const t = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(t);
  }, [aktywne, router]);
  return null;
}
