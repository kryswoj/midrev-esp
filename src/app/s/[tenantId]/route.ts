import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { adresSledzenia } from "../../../config";
import { CSS_FORMULARZA, zmienneStylu } from "../../../domain/formularze/css";
import { czyPokazac } from "../../../domain/formularze/wyswietlanie";
import { formularzeNaStrone } from "../../../usecases/popupy/formularze";
import { uruchomFormularze } from "../runtime-formularzy";
import { WERSJA_SKRYPTU } from "../wersja-skryptu";

/**
 * Skrypt on-site (Epik F, AD-19; builder formularzy 0043): sklep wkleja jeden tag
 *   <script src=".../s/TENANT_ID"></script>
 * i dostaje samodzielny JS bez zależności, który pokazuje WSZYSTKIE włączone formularze
 * tenanta według ich reguł (popup, wysuwany w rogu, osadzony w `<div data-midrev-form="ID">`).
 *
 * Wersja skryptu jest jawna (komentarz + nagłówek X-Script-Version), bo skrypt żyje
 * w cudzych przeglądarkach: kontrakt danych zmienia się wyłącznie wstecznie zgodnie.
 *
 * Obrona przed XSS: treść formularzy pochodzi od operatora, ale NIGDY nie trafia do
 * innerHTML: runtime (runtime-formularzy.ts) wstawia ją przez textContent, a konfiguracja
 * jest wstrzykiwana jako JSON z przeescapowanym „<” i separatorami U+2028/29, żeby nie dało
 * się domknąć tagu </script> ani złamać literału treścią formularza. Kody rabatowe i lista
 * docelowa nie wychodzą w skrypcie (kod dostaje się dopiero w odpowiedzi na zapis).
 */

const schematId = z.string().uuid();

function naglowki(): Record<string, string> {
  return {
    "Content-Type": "application/javascript; charset=utf-8",
    "X-Script-Version": WERSJA_SKRYPTU,
    // krótki cache: sklepy ładują skrypt przy każdym wejściu, ale wyłączenie
    // formularza w panelu ma być widoczne w minutę, nie po dobie
    "Cache-Control": "public, max-age=60",
  };
}

/** JSON bezpieczny do wklejenia w <script>: bez "<" i separatorów linii U+2028/29. */
function bezpiecznyJson(dane: unknown): string {
  return JSON.stringify(dane)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export async function GET(_zadanie: NextRequest, ctx: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await ctx.params;

  const formularze = schematId.safeParse(tenantId).success ? await formularzeNaStrone(tenantId) : [];
  if (!formularze.length) {
    // 200 z pustym skryptem, nie 404: tag <script> na stronie sklepu ma być
    // bezobjawowy, gdy żaden formularz nie jest włączony
    return new NextResponse(`/* midrev-esp formularze v${WERSJA_SKRYPTU} - brak aktywnego formularza */\n`, { headers: naglowki() });
  }

  const konfig = {
    v: WERSJA_SKRYPTU,
    api: `${adresSledzenia()}/api/popup`,
    // przedrostek kluczy localStorage: osobny na sklep, bez pełnego id tenanta
    t: tenantId.replace(/-/g, "").slice(0, 12),
    f: formularze.map((f) => ({
      id: f.id,
      nazwa: f.nazwa,
      typ: f.definicja.typ,
      zmienne: zmienneStylu(f.definicja.styl),
      obraz: f.definicja.styl.obraz,
      obrazPozycja: f.definicja.styl.obrazPozycja,
      rog: f.definicja.styl.rog,
      kroki: f.definicja.kroki,
      sukces: f.definicja.sukces,
      teaser: f.definicja.typ === "embed" ? null : f.definicja.teaser,
      reguly: f.definicja.wyswietlanie,
      // klauzula: DOKŁADNIE ten tekst trafia do dowodu zgody (serwer bierze go z wersji w bazie)
      zgoda: f.zgoda,
      krokEmail: f.krokEmail,
    })),
  };

  const skrypt = `/* midrev-esp formularze v${WERSJA_SKRYPTU} */
(${uruchomFormularze.toString()})(${bezpiecznyJson(konfig)}, ${bezpiecznyJson(CSS_FORMULARZA)}, (${czyPokazac.toString()}));
`;
  return new NextResponse(skrypt, { headers: naglowki() });
}
