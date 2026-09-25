/** Onboarding liczony ze stanu konta, z postępem i realnymi akcjami kroków. */
import type { StanOnboardingu } from "../../../usecases/onboarding";
import { Badge, Button, Card, CardHeader, Icon } from "../../ui";

export function Onboarding({ tenantId, stan }: { tenantId: string; stan: StanOnboardingu }) {
  if (stan.gotowe) return null;
  const postep = stan.wszystkie > 0 ? (stan.zrobione / stan.wszystkie) * 100 : 0;
  const zrobione = stan.kroki.filter((krok) => krok.zrobiony);
  const otwarte = stan.kroki.filter((krok) => !krok.zrobiony);
  const wiekszoscGotowa = stan.zrobione > stan.wszystkie / 2;

  const wierszKroku = (krok: StanOnboardingu["kroki"][number]) => (
    <li key={krok.klucz} className={`krok ${krok.zrobiony ? "krok-zrobiony" : ""}`}>
      <span className="krok-znacznik" aria-hidden="true">
        {krok.zrobiony ? <Icon name="check" size={15} strokeWidth={2.4} /> : krok.wBudowie ? "—" : ""}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="krok-tytul">{krok.tytul}</span>
          <Badge ton={krok.zrobiony ? "ok" : krok.wBudowie ? "uwaga" : "szkic"}>
            {krok.zrobiony ? "zrobione" : krok.wBudowie ? "w budowie" : "do zrobienia"}
          </Badge>
        </div>
        {!krok.zrobiony ? <><p className="krok-opis">{krok.poCo}</p><p className="tekst-meta mt-1">{krok.szczegol}</p></> : null}
      </div>
      {!krok.zrobiony ? <Button href={`/t/${tenantId}${krok.href}`} variant="secondary" size="sm">{krok.akcja}</Button> : null}
    </li>
  );

  return (
    <Card>
      <CardHeader
        title="Zanim ruszy pierwsza wysyłka"
        description="Kroki aktualizują się automatycznie na podstawie stanu konta."
        actionPosition="title"
        action={<div className="flex items-center gap-3"><div className="h-1.5 w-[120px] shrink-0 overflow-hidden rounded-full bg-[var(--color-powierzchnia-2)]" role="progressbar" aria-label="Postęp konfiguracji" aria-valuemin={0} aria-valuemax={stan.wszystkie} aria-valuenow={stan.zrobione}><div className="h-full rounded-full bg-[var(--color-akcent)]" style={{ width: `${postep}%` }} /></div><span className="tekst-licznik shrink-0 font-semibold">{stan.zrobione} z {stan.wszystkie} gotowe</span></div>}
      />
      <ol>
        {wiekszoscGotowa && zrobione.length > 0 ? (
          <li className="border-b border-[var(--color-linia-0)]">
            <details>
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-6 py-3 text-[13px] font-medium text-[var(--color-tekst-2)] max-md:px-4">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--color-ok)] text-white"><Icon name="check" size={14} strokeWidth={2.4} /></span>
                {zrobione.length} {zrobione.length === 1 ? "krok gotowy" : zrobione.length < 5 ? "kroki gotowe" : "kroków gotowych"}
                <Icon name="chevronDown" size={16} className="ml-auto text-[var(--color-tekst-3)]" />
              </summary>
              <ol className="border-t border-[var(--color-linia-0)]">{zrobione.map(wierszKroku)}</ol>
            </details>
          </li>
        ) : zrobione.map(wierszKroku)}
        {otwarte.map(wierszKroku)}
      </ol>
    </Card>
  );
}
