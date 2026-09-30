/**
 * Wersja `text/plain` maila wyprowadzona z HTML (audyt 28.09, P1-2).
 *
 * Mail wyłącznie z HTML dostaje w SpamAssassinie regułę MIME_HTML_ONLY i gorszą ocenę
 * u części filtrów; przy nowej subdomenie i ścisłym DMARC liczy się każdy punkt. Część
 * czytników (zegarki, tryb tekstowy, czytniki ekranu w części klientów) pokazuje wyłącznie
 * tę wersję, więc ma być czytelna: akapity, listy, linki jako „tekst (adres)", stopka
 * z adresem wypisu — ten sam, śledzony adres co w HTML.
 *
 * Czysta funkcja bez zależności. To NIE jest pełny parser HTML: maile z edytora bloków
 * mają przewidywalną strukturę (tabele, akapity, linki), a na wejściu obcym wynik ma być
 * czytelny, nie idealny. Zawsze zwraca tekst (co najmniej pusty napis), nigdy nie rzuca.
 */

const ENCJE: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  rdquo: "”",
  ldquo: "“",
  rsquo: "’",
  lsquo: "‘",
  copy: "©",
  reg: "®",
  euro: "€",
  zwnj: "",
  zwj: "",
  shy: "",
};

function dekodujEncje(tekst: string): string {
  return tekst.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (calosc, kod: string) => {
    if (kod[0] === "#") {
      const n = kod[1] === "x" || kod[1] === "X" ? parseInt(kod.slice(2), 16) : parseInt(kod.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return "";
      // znaki niewidoczne (zero-width, preheader-padding) nic nie wnoszą do tekstu
      if (n === 0x200b || n === 0x200c || n === 0x200d || n === 0x2060 || n === 0xfeff || n === 0xad || n === 0x34f) return "";
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    const z = ENCJE[kod.toLowerCase()];
    return z ?? calosc;
  });
}

function atrybut(tag: string, nazwa: string): string | null {
  const m = new RegExp(`\\s${nazwa}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!m) return null;
  return dekodujEncje(m[1] ?? m[2] ?? m[3] ?? "").trim();
}

export function htmlNaTekst(html: string): string {
  let s = String(html ?? "");
  // treść, której czytelnik nie widzi: head, style, script, komentarze, ukryty preheader
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(head|style|script|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<([a-z0-9]+)\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, "");

  // linki: „tekst (adres)"; gdy tekst JEST adresem albo pusty — sam adres
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_c, atrybuty: string, wnetrze: string) => {
    const href = atrybut(` ${atrybuty}`, "href");
    const tekst = dekodujEncje(wnetrze.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (!href || /^(#|javascript:|mailto:$)/i.test(href)) return tekst;
    const adres = href.replace(/^mailto:/i, "");
    if (!tekst || tekst === href || tekst === adres) return ` ${adres} `;
    return ` ${tekst} (${adres}) `;
  });
  // obrazek z opisem alternatywnym: opis w nawiasach kwadratowych; piksel i ozdobniki znikają
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = atrybut(tag, "alt");
    return alt ? ` [${alt}] ` : " ";
  });
  // struktura blokowa na podziały linii
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<hr\b[^>]*>/gi, "\n----------\n");
  s = s.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, "\n\n");
  s = s.replace(/<(p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/t[dh]\s*>/gi, " ");
  // reszta znaczników
  s = s.replace(/<[^>]*>/g, "");
  s = dekodujEncje(s);

  // porządek w białych znakach: spacje w linii, najwyżej jedna pusta linia z rzędu
  const linie = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim());
  const wynik: string[] = [];
  for (const l of linie) {
    if (!l && (!wynik.length || !wynik[wynik.length - 1])) continue;
    wynik.push(l);
  }
  while (wynik.length && !wynik[wynik.length - 1]) wynik.pop();
  return wynik.join("\n");
}
