/**
 * Konwersja kwoty z tekstu na grosze (AD-11).
 *
 * Celowo bez liczb zmiennoprzecinkowych: `parseFloat("187.10") * 100` daje 18709.999...
 * i po zaokrągleniu potrafi zgubić grosz. Przy raporcie przychodu, na podstawie którego
 * klient ocenia kanał, to jest różnica między zaufaniem a tłumaczeniem się.
 */
export function naGrosze(kwota: string | number): number {
  const tekst = typeof kwota === "number" ? kwota.toFixed(2) : kwota.trim();
  if (!/^-?\d+([.,]\d+)?$/.test(tekst)) {
    throw new Error(`Nie umiem odczytać kwoty: ${JSON.stringify(kwota)}`);
  }
  const [calosc, ulamek = ""] = tekst.replace(",", ".").split(".");
  const grosze = (ulamek + "00").slice(0, 2);
  const znak = calosc.startsWith("-") ? -1 : 1;
  return znak * (Math.abs(Number(calosc)) * 100 + Number(grosze));
}

export function zGroszy(minor: number, waluta = "PLN"): string {
  // Separator tysiecy jest obowiazkowy: "6061,00" czyta sie gorzej niz "6 061,00",
  // a przy szescioifrowych kwotach roznica robi sie bolesna.
  const znak = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const calosc = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const symbol = waluta === "PLN" ? "zł" : waluta;
  return `${znak}${calosc},${String(abs % 100).padStart(2, "0")}\u00a0${symbol}`;
}
