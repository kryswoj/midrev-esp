/**
 * Zamknięty zestaw reguł segmentacji (FR24). Generyczny builder to faza 3 (FR31).
 *
 * Zamknięty zestaw jest tu decyzją, nie ograniczeniem: operator zna SQL i bazę, a te
 * reguły pokrywają realne kampanie sklepu ecommerce. Otwarty builder kosztuje kilka
 * tygodni i wraca wtedy, kiedy klient poprosi o coś, czego nie da się z tego złożyć.
 *
 * Reguły PRZECHODZĄ PRZEZ SCHEMAT (zod) przy zapisie i przy kompilacji. Nieznany typ
 * rzuca błędem, bo kompilator, który go ignorował, tworzył segment bez warunków,
 * czyli całą bazę tenanta (audyt #12, S2 z 31.08). Literówka w typie nie ma prawa
 * wysłać kampanii do wszystkich.
 */
import { z } from "zod";
import { odmien } from "./liczebniki";

const dni = z.number().int().min(1).max(3650);

export const schematReguly = z.discriminatedUnion("typ", [
  z.object({ typ: z.literal("kupil_w_ostatnich"), dni }),
  z.object({ typ: z.literal("nie_kupil_od"), dni }),
  z.object({ typ: z.literal("wydal_powyzej"), kwotaMinor: z.number().int().min(0) }),
  z.object({ typ: z.literal("liczba_zamowien_min"), ile: z.number().int().min(1) }),
  z.object({ typ: z.literal("ma_zgode"), kanal: z.enum(["email", "sms"]) }),
  // zachowanie mailowe: `clicks` trzyma wyłącznie kliknięcia uznane za LUDZKIE
  // (skanery zostają w message_engagement), więc "kliknął" znaczy kliknął człowiek
  z.object({ typ: z.literal("kliknal_w_ostatnich"), dni }),
  z.object({ typ: z.literal("nie_kliknal_od"), dni }),
]);

export type Regula = z.infer<typeof schematReguly>;
export type TypReguly = Regula["typ"];

export const TYPY_REGUL: readonly TypReguly[] = schematReguly.options.map(
  (o) => o.shape.typ.value,
) as TypReguly[];

/**
 * Walidacja listy reguł. Rzuca z nazwą typu, którego nie zna, i z opisem pola,
 * które nie przeszło. Pusta lista też jest błędem: segment bez warunków to cała
 * baza, a to nigdy nie jest tym, co ktoś chciał zapisać przez formularz.
 */
export function parsujReguly(surowe: unknown): Regula[] {
  if (!Array.isArray(surowe) || surowe.length === 0) {
    throw new Error("Segment musi mieć co najmniej jedną regułę - bez reguł objąłby całą bazę");
  }
  const wynik = z.array(schematReguly).safeParse(surowe);
  if (wynik.success) return wynik.data;
  const pierwszy = wynik.error.issues[0];
  const indeks = typeof pierwszy?.path[0] === "number" ? pierwszy.path[0] : 0;
  const typ = (surowe[indeks] as { typ?: unknown } | undefined)?.typ;
  if (typeof typ !== "string" || !(TYPY_REGUL as string[]).includes(typ)) {
    throw new Error(`Nieznany typ reguły segmentu: ${JSON.stringify(typ)}. Dozwolone: ${TYPY_REGUL.join(", ")}`);
  }
  const pole = pierwszy?.path.slice(1).join(".") || "reguła";
  throw new Error(`Reguła "${typ}": ${pole} - ${pierwszy?.message ?? "niepoprawna wartość"}`);
}

export const OPISY_REGUL: { [T in TypReguly]: (r: Extract<Regula, { typ: T }>) => string } = {
  kupil_w_ostatnich: (r) => `kupił w ostatnich ${r.dni} dniach`,
  nie_kupil_od: (r) => `nie kupił od ${r.dni} dni`,
  wydal_powyzej: (r) => `wydał powyżej ${Math.floor(r.kwotaMinor / 100)} zł`,
  liczba_zamowien_min: (r) => `złożył co najmniej ${odmien(r.ile, "zamówienie", "zamówienia", "zamówień")}`,
  ma_zgode: (r) => `ma zgodę na ${r.kanal === "email" ? "e-mail" : "SMS"}`,
  kliknal_w_ostatnich: (r) => `kliknął w mailu w ostatnich ${r.dni} dniach`,
  nie_kliknal_od: (r) => `dostał od nas maila co najmniej ${r.dni} dni temu i od tego czasu nie kliknął`,
};

export function opiszRegule(regula: Regula): string {
  const opis = OPISY_REGUL[regula.typ] as (r: Regula) => string;
  return opis(regula);
}
