/**
 * Normalizacja numeru telefonu do E.164, domyślny kraj PL. Ta sama reguła co funkcja SQL
 * `midrev_telefon_e164` z migracji 0033 (test pilnuje zgodności): dopasowanie profilu po
 * telefonie porównuje wynik tej funkcji z indeksem na wyrażeniu SQL.
 * Null = numeru nie da się jednoznacznie sprowadzić do E.164 (nie bierze udziału w dopasowaniu).
 */
export function telefonE164(surowy: string | null | undefined): string | null {
  if (surowy === null || surowy === undefined) return null;
  // PG btrim zdejmuje tylko spacje; \s w regexp_replace obejmuje też tab i nowe linie
  const n = surowy.replace(/^ +| +$/g, "").replace(/[\s().\-/]/g, "");
  if (/^\+[1-9][0-9]{6,14}$/.test(n)) return n;
  if (/^00[1-9][0-9]{6,14}$/.test(n)) return "+" + n.slice(2);
  if (/^[1-9][0-9]{8}$/.test(n)) return "+48" + n;
  if (/^48[1-9][0-9]{8}$/.test(n)) return "+" + n;
  return null;
}
