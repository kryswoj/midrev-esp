"use server";

import { wymaganyTenant } from "../../../../autoryzacja";
import { wlasciwosciZdarzenia } from "../../../../../usecases/zdarzenia/odczyt";

/**
 * Leniwe rozwinięcie wpisu osi (6.4): pełne properties jednego zdarzenia dopiero na klik,
 * bo mogą mieć megabajty. tenantId z klienta przechodzi przez wymaganyTenant (AD-21),
 * a use-case sprawdza, że zdarzenie należy do TEGO profilu w TYM tenancie (AD-40).
 * Zwraca tekst JSON (React go wyescapuje; properties mogła wysłać dowolna przeglądarka).
 */
export async function wlasciwosciZdarzeniaAkcja(tenantId: string, profileId: string, id: string, occurredAt: string): Promise<string | null> {
  const { tenantId: t } = await wymaganyTenant(tenantId);
  const p = await wlasciwosciZdarzenia(t, profileId, id, occurredAt);
  return p ? JSON.stringify(p, null, 2).slice(0, 200_000) : null;
}
