/**
 * „Najprościej: jeden wpis u dostawcy domeny" — rekord NS dla subdomeny wysyłkowej.
 * Wspólny dla kreatora w panelu i publicznej instrukcji dla informatyka (/dns/[token]).
 *
 * Jeden wiersz tabeli: Nazwa (np. news), Typ NS, Wartość = cztery serwery, każdy z
 * „Kopiuj". Kropka na końcu serwera zależy od panelu (Hostido dokleja domenę bez niej,
 * lekcja z 30.09). Większość paneli przyjmuje jeden serwer na wpis: mówimy to wprost.
 * Stan słowem i kształtem plakietki (NFR33), nigdy samym kolorem.
 */
import type { DostawcaDns } from "../../domain/email/dostawcy-dns";
import type { OcenaDelegacji, StanDelegacji } from "../../domain/email/route53";
import { Kopiuj } from "./kopiuj";

const PLAKIETKA: Record<StanDelegacji | "nowy", { klasa: string; slowo: string }> = {
  dziala: { klasa: "plakietka-ok", slowo: "gotowe" },
  czeka: { klasa: "plakietka-uwaga", slowo: "sprawdzamy" },
  brak: { klasa: "plakietka-szkic", slowo: "do dodania" },
  nowy: { klasa: "plakietka-szkic", slowo: "do dodania" },
  czesciowa: { klasa: "plakietka-blad", slowo: "do poprawy" },
  bledna: { klasa: "plakietka-blad", slowo: "do poprawy" },
  konflikt: { klasa: "plakietka-blad", slowo: "do poprawy" },
};

function Stan({ ocena }: { ocena: OcenaDelegacji | null }) {
  const p = PLAKIETKA[ocena?.stan ?? "nowy"];
  return <span className={`plakietka ${p.klasa} whitespace-nowrap`}>{p.slowo}</span>;
}

function Kod({ tekst }: { tekst: string }) {
  return <code className="font-mono text-[12px] leading-[17px] [overflow-wrap:anywhere] text-[var(--color-tekst)] max-md:text-[13px] max-md:leading-[19px]">{tekst}</code>;
}

/** Zdanie o tym, jak ten panel przyjmuje kilka serwerów. */
export function jakWpisacSerwery(dostawca: DostawcaDns, ile: number): string {
  if (dostawca.nsWJednymWpisie) return `${dostawca.nazwa} przyjmuje wszystkie ${ile} serwery w jednym wpisie: dodaj je razem.`;
  const panel = dostawca.klucz === "inny" ? "Większość paneli" : `Panel ${dostawca.nazwa}`;
  return `${panel} przyjmuje jeden serwer na wpis. Dodaj ten rekord ${ile} razy, za każdym razem z tą samą nazwą i kolejnym serwerem z listy.`;
}

export function JedenWpis({
  nazwa,
  serwery,
  dostawca,
  ocena,
}: {
  nazwa: string;
  serwery: string[];
  dostawca: DostawcaDns;
  ocena: OcenaDelegacji | null;
}) {
  const wartosci = serwery.map((s) => (dostawca.kropkaNaKoncu ? `${s}.` : s));
  const brakujace = new Set(ocena?.stan === "czesciowa" ? ocena.brakujace : []);
  const doPoprawy = ocena && ["czesciowa", "bledna", "konflikt"].includes(ocena.stan);
  const komunikat = ocena?.komunikat && ocena.stan !== "dziala" && ocena.stan !== "brak" ? ocena.komunikat : null;
  const lista = (
    <ul className="space-y-1.5">
      {wartosci.map((w, i) => (
        <li key={w} className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <Kod tekst={w} />
            {brakujace.has(serwery[i]) ? <span className="tekst-meta ml-2 !text-[var(--color-blad)]">brakuje</span> : null}
          </span>
          <Kopiuj wartosc={w} etykieta={`serwer ${i + 1} z ${wartosci.length}`} />
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-[10px] border border-[var(--color-linia)]">
        <div className="tabela-responsywna-desktop overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th className="w-[26%]">Nazwa</th>
                <th className="w-[72px]">Typ</th>
                <th>Wartość</th>
                <th className="w-[120px]">Stan</th>
              </tr>
            </thead>
            <tbody>
              <tr className="align-top">
                <td>
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1"><Kod tekst={nazwa} /></span>
                    <Kopiuj wartosc={nazwa} etykieta="nazwę rekordu NS" />
                  </div>
                </td>
                <td className="!font-normal">NS</td>
                <td>
                  {lista}
                  {komunikat ? (
                    <p className={`mt-2 text-[13px] leading-[19px] ${doPoprawy ? "text-[var(--color-blad)]" : "text-[var(--color-tekst-2)]"}`}>{komunikat}</p>
                  ) : null}
                </td>
                <td><Stan ocena={ocena} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="lista-mobilna">
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="zeton-neutralny">NS</span>
              <Stan ocena={ocena} />
            </div>
            <div>
              <div className="tekst-meta mb-1">Nazwa</div>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1"><Kod tekst={nazwa} /></span>
                <Kopiuj wartosc={nazwa} etykieta="nazwę rekordu NS" />
              </div>
            </div>
            <div>
              <div className="tekst-meta mb-1">Wartość ({wartosci.length} serwery)</div>
              {lista}
            </div>
            {komunikat ? (
              <p className={`text-[13px] leading-[19px] ${doPoprawy ? "text-[var(--color-blad)]" : "text-[var(--color-tekst-2)]"}`}>{komunikat}</p>
            ) : null}
          </div>
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
        <li>{jakWpisacSerwery(dostawca, wartosci.length)}</li>
        {dostawca.kropkaNaKoncu ? <li>Kopiuj serwery razem z kropką na końcu. Bez niej panel dopisze nazwę Twojej domeny i wpis nie zadziała.</li> : null}
        {dostawca.nsUwaga ? <li>{dostawca.nsUwaga}</li> : null}
      </ul>
    </div>
  );
}
