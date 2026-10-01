/**
 * Tabela rekordów DNS do skopiowania: Nazwa / Typ / Wartość / Stan, przycisk „Kopiuj"
 * przy każdej komórce do wklejenia. Wspólna dla kreatora w panelu i publicznej strony
 * instrukcji dla informatyka (/dns/[token]). Na telefonie osobna lista (DESIGN.md: tabeli
 * nie ściskamy).
 *
 * Stan zawsze słowem i kształtem plakietki (NFR33), nigdy samym kolorem.
 */
import type { RekordPlatformowy } from "../../domain/email/domena-platformowa";
import type { OcenaRekordu, StanRekordu } from "../../usecases/wysylka-konfiguracja/domena-platformowa";
import { Kopiuj } from "./kopiuj";

const PLAKIETKA: Record<StanRekordu | "nowy", { klasa: string; slowo: string }> = {
  ok: { klasa: "plakietka-ok", slowo: "gotowe" },
  czeka: { klasa: "plakietka-uwaga", slowo: "sprawdzamy" },
  brak: { klasa: "plakietka-szkic", slowo: "do dodania" },
  zle: { klasa: "plakietka-blad", slowo: "do poprawy" },
  nowy: { klasa: "plakietka-szkic", slowo: "do dodania" },
};

function Stan({ ocena }: { ocena: OcenaRekordu | undefined }) {
  const p = PLAKIETKA[ocena?.stan ?? "nowy"];
  return <span className={`plakietka ${p.klasa} whitespace-nowrap`}>{p.slowo}</span>;
}

function Wartosc({ tekst }: { tekst: string }) {
  return <code className="font-mono text-[12px] leading-[17px] break-all text-[var(--color-tekst)]">{tekst}</code>;
}

export function TabelaRekordow({
  rekordy,
  oceny,
}: {
  rekordy: RekordPlatformowy[];
  oceny: Partial<Record<RekordPlatformowy["klucz"], OcenaRekordu>>;
}) {
  return (
    <>
      <div className="tabela-responsywna-desktop overflow-x-auto">
        <table className="tabela">
          <thead>
            <tr>
              <th className="w-[34%]">Nazwa</th>
              <th className="w-[72px]">Typ</th>
              <th>Wartość</th>
              <th className="w-[120px]">Stan</th>
            </tr>
          </thead>
          <tbody>
            {rekordy.map((r) => {
              const o = oceny[r.klucz];
              return (
                <tr key={r.klucz} className="align-top">
                  <td>
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1" title={r.poCo}>
                        <Wartosc tekst={r.nazwa} />
                      </span>
                      <Kopiuj wartosc={r.nazwa} etykieta={`nazwę rekordu ${r.typ}`} />
                    </div>
                  </td>
                  <td className="!font-normal">{r.typ}</td>
                  <td>
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <Wartosc tekst={r.wartosc} />
                        {r.priorytet !== undefined ? <span className="tekst-meta mt-1 block">priorytet {r.priorytet}</span> : null}
                      </span>
                      <Kopiuj wartosc={r.wartosc} etykieta={`wartość rekordu ${r.typ}`} />
                    </div>
                    {o?.komunikat ? (
                      <p className={`mt-2 text-[13px] leading-[19px] ${o.stan === "zle" ? "text-[var(--color-blad)]" : "text-[var(--color-tekst-2)]"}`}>{o.komunikat}</p>
                    ) : null}
                  </td>
                  <td>
                    <Stan ocena={o} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="lista-mobilna">
        {rekordy.map((r) => {
          const o = oceny[r.klucz];
          return (
            <li key={r.klucz} className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="zeton-neutralny">{r.typ}{r.priorytet !== undefined ? ` · priorytet ${r.priorytet}` : ""}</span>
                <Stan ocena={o} />
              </div>
              <div>
                <div className="tekst-meta mb-1">Nazwa</div>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1"><Wartosc tekst={r.nazwa} /></span>
                  <Kopiuj wartosc={r.nazwa} etykieta={`nazwę rekordu ${r.typ}`} />
                </div>
              </div>
              <div>
                <div className="tekst-meta mb-1">Wartość</div>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1"><Wartosc tekst={r.wartosc} /></span>
                  <Kopiuj wartosc={r.wartosc} etykieta={`wartość rekordu ${r.typ}`} />
                </div>
              </div>
              {o?.komunikat ? (
                <p className={`text-[13px] leading-[19px] ${o.stan === "zle" ? "text-[var(--color-blad)]" : "text-[var(--color-tekst-2)]"}`}>{o.komunikat}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
