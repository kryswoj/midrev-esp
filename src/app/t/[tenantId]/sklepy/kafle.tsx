import { Badge, Icon, type NazwaIkony } from "../../../ui";

/**
 * Kafle platform w kreatorze „Połącz sklep” (plan integracji F.1). Jedna lista dla wszystkich
 * platform. Shopify prowadzi do własnego kreatora `/sklepy/shopify` (stan połączenia podaje
 * strona; webhooki Shopify idą na jeden adres `/api/webhooks/shopify`, nie per sklep, więc
 * zdrowie liczy jego kreator, nie lista webhooków).
 */
export type StanKafla = "polaczony" | "w_trakcie" | "podstawowa" | null;

export interface Platforma {
  klucz: "woocommerce" | "shopify" | "shoper" | "wlasna";
  nazwa: string;
  opis: string;
  ikona: NazwaIkony;
  /** null = „wkrótce” (kafel bez linku) */
  href: (tenantId: string) => string | null;
}

export const PLATFORMY: Platforma[] = [
  { klucz: "woocommerce", nazwa: "WooCommerce", opis: "Wtyczka MidRev: zamówienia, porzucony koszyk, link do koszyka, zgoda w kasie.", ikona: "sklep", href: (t) => `/t/${t}/sklepy/woocommerce` },
  { klucz: "shopify", nazwa: "Shopify", opis: "Aplikacja MidRev: zamówienia, porzucony checkout, zgody i formularze bez kodu.", ikona: "zamowienie", href: (t) => `/t/${t}/sklepy/shopify` },
  { klucz: "shoper", nazwa: "Shoper", opis: "Zamówienia, koszyk i formularze ze sklepu Shoper.", ikona: "kampania", href: () => null },
  { klucz: "wlasna", nazwa: "Własna strona / inny sklep", opis: "Jeden kod jak w Klaviyo: Magento, PrestaShop, IdoSell, własny sklep, landing.", ikona: "formularz", href: (t) => `/t/${t}/sklepy/wlasna-strona` },
];

const ETYKIETY: Record<Exclude<StanKafla, null>, { tekst: string; ton: "ok" | "uwaga" | "neutral" }> = {
  polaczony: { tekst: "połączony", ton: "ok" },
  w_trakcie: { tekst: "w trakcie", ton: "uwaga" },
  podstawowa: { tekst: "wersja podstawowa", ton: "neutral" },
};

export function KafleSklepow({ tenantId, stany }: { tenantId: string; stany: Partial<Record<Platforma["klucz"], StanKafla>> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {PLATFORMY.map((p) => {
        const href = p.href(tenantId);
        const stan = stany[p.klucz] ?? null;
        const tresc = (
          <>
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-[9px] ${href ? "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "bg-[var(--color-powierzchnia-2)] text-[var(--color-tekst-3)]"}`}>
              <Icon name={p.ikona} size={18} />
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-[var(--color-tekst)]">
                {p.nazwa}
                {href ? (stan ? <Badge ton={ETYKIETY[stan].ton}>{ETYKIETY[stan].tekst}</Badge> : null) : <Badge ton="nieaktywna">wkrótce</Badge>}
              </span>
              <span className="block text-[13px] leading-[19px] text-[var(--color-tekst-2)]">{p.opis}</span>
            </span>
          </>
        );
        return href ? (
          <a key={p.klucz} href={href} className="karta flex items-start gap-3 p-4 transition-colors hover:border-[var(--color-akcent)]">{tresc}</a>
        ) : (
          <div key={p.klucz} className="karta flex items-start gap-3 p-4 opacity-70" aria-disabled="true">{tresc}</div>
        );
      })}
    </div>
  );
}
