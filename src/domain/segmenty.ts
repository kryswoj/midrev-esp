/**
 * Zamknięty zestaw reguł segmentacji (FR24). Generyczny builder to faza 3 (FR31).
 *
 * Zamknięty zestaw jest tu decyzją, nie ograniczeniem: operator zna SQL i bazę, a te
 * pięć reguł pokrywa realne kampanie sklepu ecommerce. Otwarty builder kosztuje kilka
 * tygodni i wraca wtedy, kiedy klient poprosi o coś, czego nie da się z tego złożyć.
 */
import { odmien } from "./liczebniki";

export type Regula =
  | { typ: "kupil_w_ostatnich"; dni: number }
  | { typ: "nie_kupil_od"; dni: number }
  | { typ: "wydal_powyzej"; kwotaMinor: number }
  | { typ: "liczba_zamowien_min"; ile: number }
  | { typ: "ma_zgode"; kanal: "email" | "sms" };

export const OPISY_REGUL: Record<Regula["typ"], (r: any) => string> = {
  kupil_w_ostatnich: (r) => `kupił w ostatnich ${r.dni} dniach`,
  nie_kupil_od: (r) => `nie kupił od ${r.dni} dni`,
  wydal_powyzej: (r) => `wydał powyżej ${Math.floor(r.kwotaMinor / 100)} zł`,
  liczba_zamowien_min: (r) => `złożył co najmniej ${odmien(r.ile, "zamówienie", "zamówienia", "zamówień")}`,
  ma_zgode: (r) => `ma zgodę na ${r.kanal === "email" ? "e-mail" : "SMS"}`,
};

export function opiszRegule(regula: Regula): string {
  return OPISY_REGUL[regula.typ](regula);
}
