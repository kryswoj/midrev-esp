import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { getPool } from "../../../../../adapters/db/pool";
import { Alert } from "../../../../ui";
import { stanKampaniiNaEkran } from "../stany";

/**
 * Wspólna rama kreatora kampanii: nagłówek z nazwą i statusem oraz pasek kroków
 * (Odbiorcy → Treść → Temat i nadawca → Przegląd i wysyłka), jak w Klaviyo.
 *
 * Każda strona kroku woła `wymaganyTenant()` SAMA, zanim tu trafi — ta rama nie jest
 * granicą autoryzacji, tylko czyta dane kampanii zawężone do tenanta (AD-2).
 */

export type Krok = "odbiorcy" | "tresc" | "ustawienia" | "przeglad";

export const KROKI: { klucz: Krok; etykieta: string; sciezka: string }[] = [
  { klucz: "odbiorcy", etykieta: "Odbiorcy", sciezka: "/odbiorcy" },
  { klucz: "tresc", etykieta: "Treść", sciezka: "/tresc" },
  { klucz: "ustawienia", etykieta: "Temat i nadawca", sciezka: "/ustawienia" },
  { klucz: "przeglad", etykieta: "Przegląd i wysyłka", sciezka: "" },
];

export const STATUSY_PO_STARCIE = ["sending", "paused", "sent", "cancelled"];

export interface KampaniaKreatora {
  id: string;
  name: string;
  subject: string | null;
  preheader: string | null;
  content: Record<string, unknown>;
  status: string;
  scheduled_at: Date | null;
  paused_at: Date | null;
  cancelled_at: Date | null;
  zrodel: number;
  poWysylce: boolean;
}

export async function kampaniaKreatora(tenantId: string, campaignId: string): Promise<KampaniaKreatora> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(campaignId)) notFound();
  const { rows } = await getPool().query(
    `select c.id, c.name, c.subject, c.preheader, c.content, c.status, c.scheduled_at, c.paused_at, c.cancelled_at,
            (select count(*)::int from campaign_audience a where a.tenant_id = c.tenant_id and a.campaign_id = c.id) as zrodel
       from campaigns c where c.tenant_id = $1 and c.id = $2`,
    [tenantId, campaignId],
  );
  const k = rows[0];
  if (!k) notFound();
  return { ...k, content: (k.content ?? {}) as Record<string, unknown>, poWysylce: STATUSY_PO_STARCIE.includes(k.status) };
}

function zrobione(k: KampaniaKreatora): Record<Krok, boolean> {
  return {
    odbiorcy: k.zrodel > 0,
    tresc: String(k.content?.html ?? "").trim() !== "",
    ustawienia: Boolean(k.subject?.trim()),
    przeglad: k.poWysylce,
  };
}

export function RamaKreatora({
  tenantId,
  kampania,
  aktywny,
  akcja,
}: {
  tenantId: string;
  kampania: KampaniaKreatora;
  aktywny: Krok;
  akcja?: React.ReactNode;
}) {
  const stan = stanKampaniiNaEkran(kampania.status);
  const baza = `/t/${tenantId}/kampanie/${kampania.id}`;
  const gotowe = zrobione(kampania);
  const indeks = KROKI.findIndex((k) => k.klucz === aktywny);
  return (
    <>
      <header className="sticky top-0 z-20 flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/t/${tenantId}/kampanie`}
            className="text-[13px] font-medium text-[var(--color-tekst-2)] hover:text-[var(--color-akcent)]"
          >
            Kampanie
          </Link>
          <span aria-hidden="true" className="text-[var(--color-tekst-3)]">/</span>
          <h1 className="truncate text-[18px] leading-[26px]">{kampania.name}</h1>
          <span className={`plakietka ${stan.klasa}`}>{stan.etykieta}</span>
        </div>
        {akcja ? <div className="flex items-center gap-2">{akcja}</div> : null}
      </header>
      <nav
        aria-label="Kroki kampanii"
        className="border-b border-[var(--color-linia)] bg-[var(--color-app)] px-4"
      >
        <ol className="flex h-[52px] items-center gap-1 overflow-x-auto">
          {KROKI.map((k, i) => {
            const biezacy = k.klucz === aktywny;
            const zrobiony = gotowe[k.klucz] && !biezacy;
            return (
              <li key={k.klucz} className="flex shrink-0 items-center">
                {i > 0 ? (
                  <span
                    aria-hidden="true"
                    className={`mx-2 h-px w-8 ${i <= indeks ? "bg-[var(--color-akcent-ramka)]" : "bg-[var(--color-linia)]"}`}
                  />
                ) : null}
                <Link
                  href={`${baza}${k.sciezka}`}
                  aria-current={biezacy ? "step" : undefined}
                  className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] transition-colors ${
                    biezacy
                      ? "bg-[var(--color-akcent-tlo)] font-semibold text-[var(--color-akcent)]"
                      : "text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)]"
                  }`}
                >
                  <span
                    className={`grid h-[22px] w-[22px] place-items-center rounded-full text-[12px] font-semibold ${
                      biezacy
                        ? "bg-[var(--color-akcent)] text-white"
                        : zrobiony
                          ? "bg-[var(--color-ok)] text-white"
                          : "border-[1.5px] border-[var(--color-linia-mocna)] bg-white text-[var(--color-tekst-3)]"
                    }`}
                  >
                    {zrobiony ? <Check size={13} strokeWidth={3} aria-label="zrobione" /> : i + 1}
                  </span>
                  {k.etykieta}
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}

/** Pasek „dalej / wstecz" na dole kroku formularzowego. */
export function StopkaKroku({ tenantId, campaignId, aktywny, children }: { tenantId: string; campaignId: string; aktywny: Krok; children?: React.ReactNode }) {
  const i = KROKI.findIndex((k) => k.klucz === aktywny);
  const poprzedni = KROKI[i - 1];
  const baza = `/t/${tenantId}/kampanie/${campaignId}`;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-linia)] px-5 py-4">
      {poprzedni ? (
        <Link href={`${baza}${poprzedni.sciezka}`} className="przycisk przycisk-wtorny">
          ← {poprzedni.etykieta}
        </Link>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** Komunikat po akcji (?ok= / ?blad=) — ten sam kontrakt co wcześniej, na komponencie Alert. */
export function Komunikat({ ok, blad }: { ok?: string; blad?: string }) {
  if (!ok && !blad) return null;
  return (
    <div className="px-5 pt-4">
      <Alert tone={blad ? "blad" : "ok"} title={blad ? "Nie udało się" : "Gotowe"}>
        {blad ?? ok}
      </Alert>
    </div>
  );
}
