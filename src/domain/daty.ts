/**
 * Jeden format daty w całym panelu: "07.08.2026", zawsze z wiodącym zerem.
 * Przy prawym wyrównaniu w monospace "7.08.2026" jest o znak krótsze od "23.07.2026"
 * i kolumna faluje — dlatego day/month zawsze 2-digit.
 */
export function formatujDate(d: Date | string | null | undefined): string {
  const data = naDate(d);
  if (!data) return "—";
  return data.toLocaleDateString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatujDateICzas(d: Date | string | null | undefined): string {
  const data = naDate(d);
  if (!data) return "—";
  return data.toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Zepsuta wartość ze źródła ma dać "—", nie angielskie "Invalid Date" w polskim panelu.
function naDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const data = new Date(d);
  return Number.isNaN(data.getTime()) ? null : data;
}
