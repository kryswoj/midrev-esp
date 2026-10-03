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

/**
 * Stan JEDNEGO wpisu (serwera), gdy panel przyjmuje serwer na wpis: wpisany poprawnie,
 * z doklejoną domeną, brakujący. Bez tego każdy wiersz dziedziczyłby stan całości i klient
 * nie wiedziałby, który wiersz poprawić.
 */
function StanWpisu({ ocena, serwer, strefa }: { ocena: OcenaDelegacji | null; serwer: string; strefa: string }) {
  if (!ocena || ocena.stan === "dziala" || ocena.stan === "brak") return <Stan ocena={ocena} />;
  const z = new Set(ocena.znalezione);
  const klucz = z.has(`${serwer}.${strefa}`) ? "zle" : z.has(serwer) ? (ocena.stan === "konflikt" ? "zle" : "jest") : ocena.stan === "bledna" || ocena.stan === "konflikt" ? "zle" : "brak";
  const p = { jest: { klasa: "plakietka-uwaga", slowo: "wpisany" }, zle: { klasa: "plakietka-blad", slowo: "do poprawy" }, brak: { klasa: "plakietka-szkic", slowo: "do dodania" } }[klucz];
  return <span className={`plakietka ${p.klasa} whitespace-nowrap`}>{p.slowo}</span>;
}

function Kod({ tekst }: { tekst: string }) {
  return <code className="font-mono text-[12px] leading-[17px] [overflow-wrap:anywhere] text-[var(--color-tekst)] max-md:text-[13px] max-md:leading-[19px]">{tekst}</code>;
}

/** Zdanie o tym, jak ten panel przyjmuje kilka serwerów (nad tabelą: to jest polecenie). */
export function jakWpisacSerwery(dostawca: DostawcaDns, ile: number): string {
  if (dostawca.nsWJednymWpisie) return `${dostawca.nazwa} przyjmuje wszystkie ${ile} serwery w jednym wpisie: dodaj je razem.`;
  const panel = dostawca.klucz === "inny" ? "Większość paneli" : `Panel ${dostawca.nazwa}`;
  return `${panel} przyjmuje jeden serwer na wpis. Dodaj ten rekord ${ile} razy, za każdym razem z tą samą nazwą i kolejnym serwerem z listy.`;
}

/** Wartość z wyróżnioną kropką na końcu (łatwo ją przeoczyć, a bez niej panel dokleja domenę). */
function Wartosc({ tekst }: { tekst: string }) {
  const kropka = tekst.endsWith(".");
  return (
    <code className="font-mono text-[12px] leading-[17px] [overflow-wrap:anywhere] text-[var(--color-tekst)] max-md:text-[13px] max-md:leading-[19px]">
      {kropka ? tekst.slice(0, -1) : tekst}
      {kropka ? <b className="rounded-[3px] bg-[var(--color-akcent-tlo)] px-[2px] text-[var(--color-akcent)]" title="kropka na końcu">.</b> : null}
    </code>
  );
}

export function JedenWpis({
  nazwa,
  serwery,
  dostawca,
  ocena,
  strefa,
}: {
  nazwa: string;
  serwery: string[];
  dostawca: DostawcaDns;
  ocena: OcenaDelegacji | null;
  /** domena główna (do wykrycia serwera z doklejoną domeną) */
  strefa: string;
}) {
  const wartosci = serwery.map((s) => (dostawca.kropkaNaKoncu ? `${s}.` : s));
  const brakujace = new Set(ocena?.stan === "czesciowa" ? ocena.brakujace : []);
  const znalezione = new Set(ocena?.znalezione ?? []);
  const doPoprawy = ocena && ["czesciowa", "bledna", "konflikt"].includes(ocena.stan);
  const komunikat = ocena?.komunikat && ocena.stan !== "dziala" && ocena.stan !== "brak" ? ocena.komunikat : null;
  // Panel z jednym serwerem na wpis: tyle wierszy, ile wpisów klient zrobi (nazwa w każdym).
  // Panel przyjmujący zestaw: jeden wiersz z czterema wartościami.
  const wiersze = dostawca.nsWJednymWpisie ? [wartosci] : wartosci.map((w) => [w]);
  const ile = wiersze.length;
  const uwagaWiersza = (w: string) => {
    const s = w.replace(/\.$/, "");
    if (znalezione.has(`${s}.${strefa}`)) {
      return (
        <p className="mt-1.5 text-[13px] leading-[19px] text-[var(--color-blad)]">
          W panelu jest: <code className="font-mono text-[12px] [overflow-wrap:anywhere]">{`${s}.${strefa}`}</code>. Edytuj ten wpis i wklej wartość obok, z kropką na końcu.
        </p>
      );
    }
    if (brakujace.has(s)) return <p className="mt-1.5 text-[13px] leading-[19px] text-[var(--color-blad)]">Tego serwera brakuje. Dodaj go.</p>;
    return null;
  };
  return (
    <div className="space-y-3">
      <p className="text-[14px] leading-[21px] text-[var(--color-tekst)]">
        {dostawca.nsWJednymWpisie
          ? `W ${dostawca.nazwa} dodaj jeden rekord: nazwa ${nazwa}, typ NS i wszystkie ${wartosci.length} serwery naraz.`
          : `${dostawca.klucz === "inny" ? "W większości paneli" : `W panelu ${dostawca.nazwa}`} ten rekord dodaje się jako ${ile} wpisy: w każdym nazwa ${nazwa}, typ NS i jeden serwer z listy.`}
      </p>
      {komunikat ? (
        <p role="status" className={`rounded-md border px-3 py-2 text-[13px] leading-[19px] ${doPoprawy ? "border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] text-[var(--color-blad)]" : "border-[var(--color-linia)] text-[var(--color-tekst-2)]"}`}>
          {komunikat}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-[10px] border border-[var(--color-linia)]">
        <div className="tabela-responsywna-desktop overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                {ile > 1 ? <th className="w-[72px] whitespace-nowrap">Wpis</th> : null}
                <th className="w-[24%]">Nazwa</th>
                <th className="w-[64px]">Typ</th>
                <th>Wartość</th>
                <th className="w-[120px]">Stan</th>
              </tr>
            </thead>
            <tbody>
              {wiersze.map((ws, i) => (
                <tr key={ws.join(",")} className="[&>td]:align-top">
                  {ile > 1 ? <td className="whitespace-nowrap !font-normal text-[var(--color-tekst-2)]">{i + 1} z {ile}</td> : null}
                  <td>
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1"><Kod tekst={nazwa} /></span>
                      <Kopiuj wartosc={nazwa} etykieta={`nazwę rekordu NS, wpis ${i + 1}`} />
                    </div>
                  </td>
                  <td className="!font-normal">NS</td>
                  <td>
                    <ul className="space-y-1.5">
                      {ws.map((w, j) => (
                        <li key={w}>
                          <div className="flex items-start gap-2">
                            <span className="min-w-0 flex-1"><Wartosc tekst={w} /></span>
                            <Kopiuj wartosc={w} etykieta={`serwer ${ile > 1 ? i + 1 : j + 1} z ${wartosci.length}`} />
                          </div>
                          {uwagaWiersza(w)}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>{ile > 1 ? <StanWpisu ocena={ocena} serwer={serwery[i]} strefa={strefa} /> : <Stan ocena={ocena} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="lista-mobilna">
          {wiersze.map((ws, i) => (
            <li key={ws.join(",")} className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="zeton-neutralny">{ile > 1 ? `Wpis ${i + 1} z ${ile} · NS` : "NS"}</span>
                {ile > 1 ? <StanWpisu ocena={ocena} serwer={serwery[i]} strefa={strefa} /> : <Stan ocena={ocena} />}
              </div>
              <div>
                <div className="tekst-meta mb-1">Nazwa</div>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1"><Kod tekst={nazwa} /></span>
                  <Kopiuj wartosc={nazwa} etykieta={`nazwę rekordu NS, wpis ${i + 1}`} />
                </div>
              </div>
              <div>
                <div className="tekst-meta mb-1">Wartość</div>
                <ul className="space-y-1.5">
                  {ws.map((w, j) => (
                    <li key={w}>
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1"><Wartosc tekst={w} /></span>
                        <Kopiuj wartosc={w} etykieta={`serwer ${ile > 1 ? i + 1 : j + 1} z ${wartosci.length}`} />
                      </div>
                      {uwagaWiersza(w)}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
        {dostawca.kropkaNaKoncu ? (
          <li>
            <span className="font-semibold text-[var(--color-tekst)]">Każdy serwer kończy się kropką.</span> Kopiuj go razem z nią: bez niej panel dopisze nazwę Twojej domeny i wpis nie zadziała.
          </li>
        ) : null}
        {dostawca.nsUwaga ? <li>{dostawca.nsUwaga}</li> : null}
        <li>Jeśli pod nazwą {nazwa} jest już inny wpis (np. CNAME), usuń go. Pozostałych wpisów nie ruszaj.</li>
      </ul>
    </div>
  );
}
