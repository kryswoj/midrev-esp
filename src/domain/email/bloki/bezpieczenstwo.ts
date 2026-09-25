/**
 * Bezpieczeństwo treści z edytora bloków. Czysta domena: bez DOM-u i bez Node'a, bo te
 * same funkcje chodzą w przeglądarce (edycja na płótnie) i na serwerze (zapis, render).
 *
 * Treść od użytkownika trafia w trzy miejsca: do maila, do podglądu w panelu i na
 * stronę akceptacji klienta. Dlatego:
 *   - tekst zwykły ZAWSZE przez `escapuj`,
 *   - tekst sformatowany (edycja na płótnie) przez `sanityzujTekst`: biała lista znaczników,
 *     jedyny atrybut to `href`, a ten tylko http(s) i mailto,
 *   - każdy URL przez `bezpiecznyUrl`, kolor przez `bezpiecznyKolor`.
 *
 * Sanityzacja działa na zapisie I na renderze. Zapis chroni bazę przed śmieciem
 * z przeglądarki, render chroni maila przed dokumentem, który ktoś wpisał do bazy
 * z pominięciem edytora.
 */

export function escapuj(tekst: string): string {
  return String(tekst)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ENCJE: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Dekodowanie encji w wartości atrybutu — przeglądarka oddaje `href` z `&amp;`. */
export function odkodujEncje(tekst: string): string {
  return tekst.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (calosc, nazwa: string) => {
    if (nazwa[0] === "#") {
      const kod = nazwa[1] === "x" || nazwa[1] === "X" ? parseInt(nazwa.slice(2), 16) : parseInt(nazwa.slice(1), 10);
      return Number.isFinite(kod) && kod > 0 && kod < 0x110000 ? String.fromCodePoint(kod) : "";
    }
    return ENCJE[nazwa.toLowerCase()] ?? calosc;
  });
}

export type RodzajUrl = "www" | "www-lub-mail";

/**
 * Adres bezpieczny do wstawienia w `href` albo `src`: http(s) (i mailto, gdy wolno),
 * znormalizowany przez URL, z cudzysłowem i nawiasami ostrymi zakodowanymi procentowo.
 *
 * Ampersand ZOSTAJE surowy. Silnik wysyłki (`przepiszLinki`) zapisuje cel linku
 * dosłownie tak, jak stoi w atrybucie, i przekierowuje na niego bez dekodowania —
 * `&amp;` w atrybucie oznaczałoby zepsuty adres u odbiorcy. Surowy `&` w atrybucie
 * jest poprawny dla parsera HTML (encja bez średnika przed `=` nie jest dekodowana).
 *
 * Zwraca `null`, gdy adres nie przechodzi — wołający decyduje, czy to błąd, czy brak.
 */
export function bezpiecznyUrl(surowy: string, rodzaj: RodzajUrl = "www"): string | null {
  const wejscie = String(surowy ?? "").trim();
  if (!wejscie || wejscie.length > 2000) return null;
  // znaki sterujące i białe w środku adresu to klasyczna droga do `java\tscript:`
  if (/[\u0000-\u001f\u007f\s]/.test(wejscie)) return null;
  let url: URL;
  try {
    url = new URL(wejscie);
  } catch {
    return null;
  }
  const dozwolone = rodzaj === "www-lub-mail" ? ["http:", "https:", "mailto:"] : ["http:", "https:"];
  if (!dozwolone.includes(url.protocol)) return null;
  if (url.protocol !== "mailto:" && !url.hostname) return null;
  return url.href.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/'/g, "%27");
}

/** Kolor tylko jako #rgb albo #rrggbb. Wszystko inne (w tym `expression()`, `url()`) odpada. */
export function bezpiecznyKolor(surowy: string | null | undefined, zapasowy: string): string {
  const k = String(surowy ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(k)) return k.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(k)) {
    const [r, g, b] = k.slice(1).toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return zapasowy;
}

const DOZWOLONE = new Set(["b", "strong", "i", "em", "u", "a", "br"]);
const BLOKOWE = new Set(["div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr"]);
/** Te znaczniki wycinamy RAZEM z zawartością — ich treść nie jest tekstem dla ludzi. */
const Z_ZAWARTOSCIA = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript", "svg", "math", "title", "head", "textarea", "select"]);

function hrefZAtrybutow(atrybuty: string): string | null {
  const m = atrybuty.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  if (!m) return null;
  return bezpiecznyUrl(odkodujEncje(m[1] ?? m[2] ?? m[3] ?? ""), "www-lub-mail");
}

/** Tekst między znacznikami: istniejące encje zostają, goły `&` i nawiasy są escapowane. */
function tekstBezpieczny(tekst: string): string {
  return tekst
    .replace(/&(?!(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Sanityzacja tekstu sformatowanego (edycja na płótnie). Wynik zawiera WYŁĄCZNIE:
 * tekst, `<b> <strong> <i> <em> <u> <br>` i `<a href="…">` z bezpiecznym adresem.
 * Znaczniki są domknięte i poprawnie zagnieżdżone — niedomknięte `<b>` nie może
 * pogrubić reszty maila, a niedomknięte `<a>` nie może zrobić z niego jednego linku.
 * Bloki (div/p z contenteditable) zamieniają się w `<br>`.
 */
export function sanityzujTekst(wejscie: string): string {
  // BEZ obcinania: limit długości pilnuje schemat przed i po sanityzacji — ciche obcięcie
  // gubiłoby treść i mogło przeciąć znacznik (review Codeksa, runda 2)
  const zrodlo = String(wejscie ?? "");
  let wynik = "";
  const stos: string[] = [];
  let pomijajDo: string | null = null;
  let i = 0;

  const dodajPrzejscie = () => {
    if (wynik && !/<br>$/.test(wynik)) wynik += "<br>";
  };

  while (i < zrodlo.length) {
    const lt = zrodlo.indexOf("<", i);
    const koniecTekstu = lt === -1 ? zrodlo.length : lt;
    if (koniecTekstu > i) {
      if (!pomijajDo) wynik += tekstBezpieczny(zrodlo.slice(i, koniecTekstu));
      i = koniecTekstu;
      continue;
    }
    // jesteśmy na "<"
    if (zrodlo.startsWith("<!--", i)) {
      const k = zrodlo.indexOf("-->", i + 4);
      i = k === -1 ? zrodlo.length : k + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(zrodlo.slice(i));
    if (!m) {
      if (!pomijajDo) wynik += "&lt;";
      i += 1;
      continue;
    }
    i += m[0].length;
    const zamykajacy = m[1] === "/";
    const nazwa = m[2].toLowerCase();
    const atrybuty = m[3] ?? "";

    if (pomijajDo) {
      if (zamykajacy && nazwa === pomijajDo) pomijajDo = null;
      continue;
    }
    if (Z_ZAWARTOSCIA.has(nazwa)) {
      if (!zamykajacy && !/\/\s*$/.test(atrybuty)) pomijajDo = nazwa;
      continue;
    }
    if (BLOKOWE.has(nazwa)) {
      if (!zamykajacy) dodajPrzejscie();
      continue;
    }
    if (!DOZWOLONE.has(nazwa)) continue;

    if (nazwa === "br") {
      if (!zamykajacy) wynik += "<br>";
      continue;
    }
    if (zamykajacy) {
      const gdzie = stos.lastIndexOf(nazwa);
      if (gdzie === -1) continue;
      // domknięcie wszystkiego, co stoi wyżej na stosie — zagnieżdżenie zostaje poprawne
      while (stos.length > gdzie) wynik += `</${stos.pop()}>`;
      continue;
    }
    if (nazwa === "a") {
      // link w linku to nie jest poprawny HTML i każdy klient pocztowy rozumie go inaczej
      if (stos.includes("a")) continue;
      const href = hrefZAtrybutow(atrybuty);
      if (!href) continue;
      wynik += `<a href="${href}">`;
      stos.push("a");
      continue;
    }
    wynik += `<${nazwa}>`;
    stos.push(nazwa);
  }
  while (stos.length) wynik += `</${stos.pop()}>`;
  // końcowe przejścia do nowej linii z contenteditable to szum, nie treść
  return wynik.replace(/(<br>)+$/, "");
}

/** Czy tekst po sanityzacji ma cokolwiek widocznego. */
export function tekstPusty(html: string): boolean {
  return odkodujEncje(html.replace(/<[^>]*>/g, "")).replace(/ /g, " ").trim() === "";
}

// ── Surowy HTML (blok „Własny HTML") ─────────────────────────────────────────────

/** Elementy, których otwarcie bez zamknięcia chowa resztę dokumentu (treść nieoglądana). */
const CHOWAJACE = ["template", "select", "datalist", "details", "dialog"];
const ZAMYKAJA_P = new Set(["address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "ul"]);
const POWTORZENIE_ZAMYKA = new Set(["li", "option", "dt", "dd", "tr", "td", "th"]);
/** Elementy puste — nie mają znacznika zamykającego, więc nie trafiają na stos otwartych. */
const PUSTE = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen", "basefont", "bgsound", "frame"]);

interface StanSkanu {
  /** adresy z prawdziwych <a href> w widocznej części dokumentu */
  linki: string[];
  /** linki, które silnik przepisze na śledzone: widoczne <a> z href="http(s)://…" w PODWÓJNYM cudzysłowie */
  sledzone: string[];
  /** elementy otwarte na końcu (bez pustych), od najbardziej zewnętrznego */
  stos: string[];
  /** co zostało otwarte na końcu tekstu, od najbardziej wewnętrznego */
  otwarte: { rodzaj: "komentarz" | "znacznik" | "cudzyslow" | "surowy" | "chowajacy"; wartosc?: string; od?: number }[];
}

const bialy = (c: string | undefined) => c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
const litera = (c: string | undefined) => c !== undefined && /[a-zA-Z]/.test(c);

/** Elementy o treści tekstowej: RAWTEXT (bez encji) i RCDATA (z encjami) — kończy je tylko własny znacznik. */
const TEKSTOWE = new Set(["style", "xmp", "iframe", "noembed", "noframes", "noscript", "title", "textarea", "script"]);

interface AtrybutZrodlowy {
  nazwa: string;
  wartosc: string;
  /** dokładny zapis atrybutu w źródle (od nazwy do końca wartości) */
  zrodlo: string;
}

/**
 * Tokenizer HTML w zakresie potrzebnym do dwóch pytań: które linki odbiorca naprawdę zobaczy
 * i co zostaje otwarte na końcu fragmentu (czyli co połknęłoby doklejoną za nim stopkę).
 *
 * Maszyna stanów odwzorowuje tokenizację ze specyfikacji HTML (WHATWG 13.2.5) dla danych,
 * znaczników z atrybutami (cudzysłowy, wartości niecytowane, samozamknięcie), komentarzy
 * (łącznie z `<!-->`, `<!--->`, `--!>`), komentarzy „bogus” (`<!x>`, `<?x>`, `</1>`) oraz
 * elementów tekstowych (style, textarea, title…) kończonych wyłącznie przez „właściwy”
 * znacznik zamykający. Nie buduje drzewa — elementy chowające (template, select, datalist)
 * liczy stosem. Każda rozbieżność z przeglądarką po stronie „widzę link” przepuszczałaby
 * maila bez wypisu, więc przypadki graniczne są w testach (review Codeksa, rundy 2–5).
 */
interface ZnacznikZrodlowy {
  od: number;
  do: number;
  nazwa: string;
  zamykajacy: boolean;
  atrybuty: AtrybutZrodlowy[];
}

function skanuj(html: string, znaczniki?: ZnacznikZrodlowy[]): StanSkanu {
  const linki: string[] = [];
  const sledzone: string[] = [];
  const chowajace: string[] = [];
  const stos: string[] = [];
  const n = html.length;
  let i = 0;
  const otwarteChowajace = () => [...chowajace].reverse().map((c) => ({ rodzaj: "chowajacy" as const, wartosc: c }));

  /** Parsuje znacznik od pozycji „<”. Zwraca pozycję za „>” albo null (EOF w środku znacznika). */
  const znacznik = (
    lt: number,
    zamykajacy: boolean,
  ): { koniec: number; nazwa: string; atrybuty: AtrybutZrodlowy[] } | { eof: true; cudzyslow: string | null } => {
    let j = lt + (zamykajacy ? 2 : 1);
    const startNazwy = j;
    while (j < n && !bialy(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
    const nazwa = html.slice(startNazwy, j).toLowerCase();
    const atrybuty: AtrybutZrodlowy[] = [];
    // stan: przed nazwą atrybutu
    while (j < n) {
      const c = html[j];
      if (bialy(c) || c === "/") {
        j++;
        continue;
      }
      if (c === ">") return { koniec: j + 1, nazwa, atrybuty };
      // nazwa atrybutu (pierwszy znak może być „=”)
      const startAtr = j;
      j++;
      while (j < n && !bialy(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
      const nazwaAtr = html.slice(startAtr, j).toLowerCase();
      // po nazwie atrybutu
      while (j < n && bialy(html[j])) j++;
      if (j < n && html[j] === "=") {
        j++;
        while (j < n && bialy(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const k = html.indexOf(q, j + 1);
          if (k === -1) return { eof: true, cudzyslow: q };
          atrybuty.push({ nazwa: nazwaAtr, wartosc: html.slice(j + 1, k), zrodlo: html.slice(startAtr, k + 1) });
          j = k + 1;
        } else if (q === ">") {
          atrybuty.push({ nazwa: nazwaAtr, wartosc: "", zrodlo: html.slice(startAtr, j) });
        } else {
          const startW = j;
          while (j < n && !bialy(html[j]) && html[j] !== ">") j++;
          atrybuty.push({ nazwa: nazwaAtr, wartosc: html.slice(startW, j), zrodlo: html.slice(startAtr, j) });
        }
      } else {
        atrybuty.push({ nazwa: nazwaAtr, wartosc: "", zrodlo: html.slice(startAtr, j) });
      }
    }
    return { eof: true, cudzyslow: null };
  };

  /** Koniec komentarza zaczętego „<!--” na pozycji `lt`; -1 = komentarz do końca tekstu. */
  const koniecKomentarza = (lt: number): number => {
    let j = lt + 4;
    // stany „comment start” i „comment start dash”: `<!-->` i `<!--->` kończą komentarz od razu
    if (html[j] === ">") return j + 1;
    if (html[j] === "-" && html[j + 1] === ">") return j + 2;
    while (j < n) {
      if (html[j] === "-" && html[j + 1] === "-") {
        let k = j + 2;
        while (html[k] === "-") k++; // „---” zostaje w stanie „comment end”
        if (html[k] === ">") return k + 1;
        if (html[k] === "!" && html[k + 1] === ">") return k + 2; // `--!>`
        j = k;
        continue;
      }
      j++;
    }
    return -1;
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const c1 = html[lt + 1];
    if (c1 === "!") {
      if (html.startsWith("--", lt + 2)) {
        const k = koniecKomentarza(lt);
        if (k === -1) return { linki, sledzone, stos, otwarte: [{ rodzaj: "komentarz" }, ...otwarteChowajace()] };
        i = k;
        continue;
      }
      if (html.startsWith("[CDATA[", lt + 2)) {
        // w obcej treści (svg/math) CDATA trwa do „]]>” — liczymy ostrożnie tak, jakby zawsze
        const k = html.indexOf("]]>", lt);
        if (k === -1) return { linki, sledzone, stos, otwarte: [{ rodzaj: "komentarz" }, ...otwarteChowajace()] };
        i = k + 3;
        continue;
      }
      // DOCTYPE i inne `<!…>` — komentarz „bogus” do pierwszego „>”
      const k = html.indexOf(">", lt);
      if (k === -1) return { linki, sledzone, stos, otwarte: [{ rodzaj: "znacznik", od: lt }, ...otwarteChowajace()] };
      i = k + 1;
      continue;
    }
    if (c1 === "?") {
      const k = html.indexOf(">", lt);
      if (k === -1) return { linki, sledzone, stos, otwarte: [{ rodzaj: "znacznik", od: lt }, ...otwarteChowajace()] };
      i = k + 1;
      continue;
    }
    if (c1 === "/") {
      const c2 = html[lt + 2];
      if (c2 === ">") {
        i = lt + 3; // `</>` jest ignorowane
        continue;
      }
      if (c2 === undefined) return { linki, sledzone, stos, otwarte: [{ rodzaj: "znacznik", od: lt }, ...otwarteChowajace()] };
      if (!litera(c2)) {
        const k = html.indexOf(">", lt);
        if (k === -1) return { linki, sledzone, stos, otwarte: [{ rodzaj: "znacznik", od: lt }, ...otwarteChowajace()] };
        i = k + 1;
        continue;
      }
      const z = znacznik(lt, true);
      if ("eof" in z) {
        const otwarte: StanSkanu["otwarte"] = z.cudzyslow ? [{ rodzaj: "cudzyslow", wartosc: z.cudzyslow, od: lt }] : [];
        return { linki, sledzone, stos, otwarte: [...otwarte, { rodzaj: "znacznik", od: lt }, ...otwarteChowajace()] };
      }
      znaczniki?.push({ od: lt, do: z.koniec, nazwa: z.nazwa, zamykajacy: true, atrybuty: z.atrybuty });
      const gdzie = chowajace.lastIndexOf(z.nazwa);
      if (gdzie !== -1) chowajace.splice(gdzie, 1);
      const naStosie = stos.lastIndexOf(z.nazwa);
      if (naStosie !== -1) stos.length = naStosie;
      i = z.koniec;
      continue;
    }
    if (!litera(c1)) {
      i = lt + 1;
      continue;
    }
    const z = znacznik(lt, false);
    if ("eof" in z) {
      const otwarte: StanSkanu["otwarte"] = z.cudzyslow ? [{ rodzaj: "cudzyslow", wartosc: z.cudzyslow, od: lt }] : [];
      return { linki, sledzone, stos, otwarte: [...otwarte, { rodzaj: "znacznik", od: lt }, ...otwarteChowajace()] };
    }
    znaczniki?.push({ od: lt, do: z.koniec, nazwa: z.nazwa, zamykajacy: false, atrybuty: z.atrybuty });
    i = z.koniec;
    if (z.nazwa === "a" && chowajace.length === 0) {
      // pierwszy href wygrywa (duplikaty parser pomija)
      const href = z.atrybuty.find((a) => a.nazwa === "href");
      if (href) {
        linki.push(href.wartosc);
        // silnik przepisuje dokładnie zapis `href="http(s)://…"` — inne formy (HREF, spacje
        // wokół „=”, pojedynczy cudzysłów) zostają nieprzepisane
        if (/^href="https?:\/\/[^"]+"$/.test(href.zrodlo)) sledzone.push(href.wartosc);
      }
    }
    // samozamknięcie (<template/>) parser ignoruje dla elementów niepustych; details i dialog
    // chowają treść tylko bez atrybutu `open`
    const otwartyAtrybut = z.atrybuty.some((a) => a.nazwa === "open");
    if (CHOWAJACE.includes(z.nazwa) && !((z.nazwa === "details" || z.nazwa === "dialog") && otwartyAtrybut)) chowajace.push(z.nazwa);
    if (!PUSTE.has(z.nazwa)) {
      // najczęstsze niejawne domknięcia parsera — bez nich domykanie na końcu dopisywałoby
      // puste akapity (`</p>` bez otwartego <p> tworzy nowy, pusty)
      const szczyt = stos[stos.length - 1];
      if (szczyt === "p" && ZAMYKAJA_P.has(z.nazwa)) stos.pop();
      else if (szczyt === z.nazwa && POWTORZENIE_ZAMYKA.has(z.nazwa)) stos.pop();
      stos.push(z.nazwa);
    }
    if (z.nazwa === "plaintext") {
      return { linki, sledzone, stos, otwarte: [{ rodzaj: "surowy", wartosc: "plaintext" }, ...otwarteChowajace()] };
    }
    if (TEKSTOWE.has(z.nazwa)) {
      // koniec tylko na „właściwym” znaczniku zamykającym: `</nazwa` + biały znak HTML, „/” albo „>”
      const dl = z.nazwa.length;
      let k = i;
      let znaleziony = -1;
      while (k < n) {
        const lt2 = html.indexOf("</", k);
        if (lt2 === -1) break;
        const za = html[lt2 + 2 + dl];
        if (html.slice(lt2 + 2, lt2 + 2 + dl).toLowerCase() === z.nazwa && (bialy(za) || za === "/" || za === ">")) {
          znaleziony = lt2;
          break;
        }
        k = lt2 + 2;
      }
      if (znaleziony === -1) {
        return { linki, sledzone, stos, otwarte: [{ rodzaj: "surowy", wartosc: z.nazwa }, ...otwarteChowajace()] };
      }
      i = znaleziony;
    }
  }
  return { linki, sledzone, stos, otwarte: otwarteChowajace() };
}

/**
 * Domknięcie surowego HTML-u operatora, zanim trafi do maila. Silnik dokleja stopkę
 * z wypisem ZA treścią — niedomknięty `<style>`, `<template>`, komentarz albo atrybut
 * połknąłby ją i mail wyszedłby bez działającego wypisu (review Codeksa, rundy 2–3).
 * Skrypty wycinamy (klient pocztowy ich nie uruchamia), `<plaintext>` zamieniamy na tekst,
 * a potem domykamy dokładnie to, co skaner widzi jako otwarte na końcu.
 */
/**
 * Znaczniki wycinane z surowego HTML-u (treść zostaje): html/head/body przenoszą atrybuty na
 * ciało CAŁEJ wiadomości, a elementy chowające i multimedialne pokazują zawartość tylko
 * warunkowo — niedomknięte (albo „domknięte” w złym zakresie) schowałyby stopkę z wypisem.
 * W poczcie żaden z nich i tak nie działa.
 */
const WYCINANE = new Set([
  "html", "head", "body", "template", "details", "dialog", "select", "datalist", "audio", "video", "object", "canvas", "frameset", "frame",
  // noscript (przy wyłączonych skryptach to zwykły HTML) i obca treść svg/math (inne reguły
  // parsowania, np. <style> nie jest tam tekstem) — po wycięciu parser i skaner widzą to samo
  "noscript", "svg", "math",
]);

export function domknijSurowyHtml(html: string): string {
  // neutralizacja powtarzana w każdym przebiegu: wycięcie znacznika może SKLEIĆ nowe
  // `<plaintext>` albo `<script>` z kawałków (`<pl<body>aintext>`) — review Codeksa, runda 9
  const neutralizuj = (h: string) =>
    h
      .replace(/<script\b[\s\S]*?(<\/script(?=[\t\n\f\r />])[^>]*>|$)/gi, "")
      .replace(/<plaintext\b/gi, "&lt;plaintext")
      .replace(/<!\[CDATA\[/gi, "&lt;![CDATA[");
  let wynik = neutralizuj(String(html ?? ""));

  // 1. Konstrukcje urwane na końcu: znacznik bez „>” (w tym „</” i `<body hidden`) staje się
  //    tekstem, zamiast zostać „dokończony” — dokończony mógłby zadziałać (np. hidden na body).
  //    Komentarze i elementy tekstowe domykamy.
  const domknijKoniec = () => {
    for (let proba = 0; proba < 40; proba++) {
      const { otwarte } = skanuj(wynik);
      const [pierwsze] = otwarte;
      if (!pierwsze || pierwsze.rodzaj === "chowajacy") return;
      if ((pierwsze.rodzaj === "znacznik" || pierwsze.rodzaj === "cudzyslow") && pierwsze.od !== undefined) {
        wynik = `${wynik.slice(0, pierwsze.od)}&lt;${wynik.slice(pierwsze.od + 1)}`;
      } else if (pierwsze.rodzaj === "komentarz") wynik += " -->";
      else if (pierwsze.rodzaj === "surowy") wynik += `</${pierwsze.wartosc}>`;
      else return;
    }
  };
  domknijKoniec();

  // 2. Przepisanie znaczników tokenizerem (nie regexem — „>” w wartości atrybutu, powtórzone
  //    atrybuty i `<b/hidden>` łamały wersję regexową): wycinamy WYCINANE, usuwamy każdy
  //    atrybut hidden. Elementy formatujące parser potrafi odtworzyć WOKÓŁ doklejonej stopki
  //    (lista aktywnych elementów formatujących), więc hidden nie może zostać nigdzie.
  // do punktu stałego: wycięcie znacznika potrafi skleić sąsiedni tekst w NOWY znacznik
  // (`<<body>body hidden>`), a zawartość wyciętego noscript/svg dopiero teraz jest HTML-em
  for (let przebieg = 0; przebieg < 10; przebieg++) {
    const przed = wynik;
    const znaczniki: ZnacznikZrodlowy[] = [];
    skanuj(wynik, znaczniki);
    for (let k = znaczniki.length - 1; k >= 0; k--) {
      const z = znaczniki[k];
      if (WYCINANE.has(z.nazwa)) {
        wynik = wynik.slice(0, z.od) + wynik.slice(z.do);
        continue;
      }
      if (!z.zamykajacy && z.atrybuty.some((a) => a.nazwa === "hidden")) {
        const zrodlo = wynik.slice(z.od, z.do);
        const nazwaZrodlowa = /^<([^\t\n\f\r />]+)/.exec(zrodlo)?.[1] ?? z.nazwa;
        const samozamkniety = /\/>$/.test(zrodlo);
        const atrybuty = z.atrybuty.filter((a) => a.nazwa !== "hidden").map((a) => a.zrodlo);
        wynik = `${wynik.slice(0, z.od)}<${nazwaZrodlowa}${atrybuty.length ? ` ${atrybuty.join(" ")}` : ""}${samozamkniety ? " /" : ""}>${wynik.slice(z.do)}`;
      }
    }
    wynik = neutralizuj(wynik);
    domknijKoniec();
    if (wynik === przed) break;
  }
  domknijKoniec();

  // 3. Domykamy WSZYSTKIE elementy otwarte przez operatora: stopka silnika ląduje poza jego
  //    HTML-em, więc np. niedomknięty <div style="display:none"> jej nie schowa.
  const { stos } = skanuj(wynik);
  for (let k = stos.length - 1; k >= 0; k--) wynik += `</${stos[k]}>`;
  // Pas bezpieczeństwa niezależny od skanera: żaden początek <html>/<head>/<body> nie może
  // zostać nigdzie, także w kontekście, który skaner uznał za tekst (w tekście to nieszkodliwe).
  return wynik.replace(/<(?=(?:html|head|body)[\t\n\f\r />])/gi, "&lt;");
}

/**
 * Adresy z PRAWDZIWYCH, widocznych linków `<a href>` — takich, które parser uzna za znacznik,
 * a nie za tekst w komentarzu, `<style>`, atrybucie czy w chowającym `<template>`.
 * Obecność napisu „/u/…” w źródle nie oznacza, że odbiorca zobaczy działający link.
 */
export function prawdziweLinki(html: string): string[] {
  return skanuj(html).linki;
}

/**
 * Widoczne linki, które `przepiszLinki` silnika na pewno przepisze: prawdziwe `<a>` z atrybutem
 * `href="http(s)://…"` w podwójnym cudzysłowie (silnik łapie dokładnie ten zapis).
 */
export function linkiSledzone(html: string): string[] {
  return skanuj(html).sledzone;
}
