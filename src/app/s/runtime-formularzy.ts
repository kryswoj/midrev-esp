/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Skrypt formularzy na stronie sklepu (/s/{tenant}), wersja 2. Funkcja jest wstrzykiwana do
 * odpowiedzi trasy przez `uruchomFormularze.toString()`, więc:
 *  - NIE MOŻE odwoływać się do niczego spoza własnego ciała (żadnych importów ani stałych
 *    modułu); wszystko, czego potrzebuje, dostaje w argumentach: konfigurację K, arkusz CSS
 *    i funkcję `czyPokazac` (też wstrzykniętą tekstem, z src/domain/formularze/wyswietlanie.ts),
 *  - nie używa klas, async ani generatorów (żadnych helperów kompilatora).
 *
 * Bezpieczeństwo: KAŻDA treść od operatora trafia do DOM-u przez textContent albo przez
 * atrybut (placeholder, aria-label, alt), nigdy przez innerHTML. Adresy (obraz, link, polityka)
 * przechodzą test http(s). Formularz żyje w Shadow DOM: style sklepu go nie psują, a nasze
 * nie wyciekają na sklep. Konfiguracja przychodzi jako JSON z przeescapowanym „<”.
 *
 * Dostępność: popup to role=dialog z aria-modal, fokus na pierwszym polu, pułapka Tab,
 * Esc zamyka, po zamknięciu fokus wraca tam, gdzie był. Błędy w role=alert.
 */
export function uruchomFormularze(K: any, CSS: string, czyPokazac: (r: any, k: any) => boolean): void {
  "use strict";
  var w: any = window;
  var d: any = document;
  if (w.__midrevFormularze) return; // tag wklejony dwa razy nie daje dwóch formularzy
  w.__midrevFormularze = true;

  var DZIEN = 86400000;
  var P = "mf_" + K.t + "_";
  var otwarty: any = null; // otwarty popup albo wysuwany (jeden naraz)

  function czytaj(k: string): string | null {
    try { return w.localStorage.getItem(k); } catch (e) { return null; }
  }
  function zapisz(k: string, v: string): void {
    try { w.localStorage.setItem(k, v); } catch (e) { /* tryb prywatny: bez pamięci */ }
  }
  function usun(k: string): void {
    try { w.localStorage.removeItem(k); } catch (e) { /* jw. */ }
  }
  function losowe(): string {
    var s = "";
    for (var i = 0; i < 3; i++) s += Math.random().toString(36).slice(2, 10);
    return s.slice(0, 24) || "gosc" + Date.now().toString(36);
  }
  function adresOk(u: any): boolean {
    return typeof u === "string" && /^https?:\/\/[^\s<>"]+$/i.test(u);
  }

  var gosc = czytaj("mf_gosc");
  if (!gosc || !/^[a-z0-9]{8,32}$/.test(gosc)) { gosc = losowe(); zapisz("mf_gosc", gosc); }
  var pierwsza = Number(czytaj(P + "pierwsza")) || 0;
  if (!pierwsza) { pierwsza = Date.now(); zapisz(P + "pierwsza", String(pierwsza)); }
  var telefon = false;
  try { telefon = w.matchMedia("(max-width: 767px)").matches; } catch (e) { /* stara przeglądarka */ }

  function kontekst(f: any): any {
    return {
      adres: String(w.location.href),
      telefon: telefon,
      zapisany: czytaj(P + "zapisany") === "1",
      zapisanyTutaj: czytaj(P + f.id + "_z") === "1",
      nowy: Date.now() - pierwsza < 30 * 60 * 1000,
      zamknietoMs: Number(czytaj(P + f.id + "_c")) || null,
      terazMs: Date.now(),
    };
  }

  // Kontekst „jawnej intencji” (kliknięcie wyzwalacza, formularz osadzony): liczą się tylko
  // adres strony i urządzenie; częstotliwość i „kto już się zapisał” nie blokują.
  function tylkoMiejsce(f: any): boolean {
    var k = kontekst(f);
    k.zapisany = false;
    k.zapisanyTutaj = false;
    k.nowy = true;
    k.zamknietoMs = null;
    var r: any = {};
    for (var x in f.reguly) if (Object.prototype.hasOwnProperty.call(f.reguly, x)) r[x] = f.reguly[x];
    r.komu = "wszyscy";
    return czyPokazac(r, k);
  }

  function el(tag: string, klasa?: string, tekst?: string): any {
    var e = d.createElement(tag);
    if (klasa) e.className = klasa;
    if (tekst) e.textContent = tekst; // textContent, nigdy innerHTML
    return e;
  }

  function wyslij(url: string, dane: any, tekstowo: boolean): any {
    return w.fetch(url, {
      method: "POST",
      // text/plain nie wymaga preflightu (lekkie zdarzenie wyświetlenia), JSON przy zapisie
      headers: { "Content-Type": tekstowo ? "text/plain" : "application/json" },
      body: JSON.stringify(dane),
      keepalive: tekstowo,
      credentials: "omit",
    });
  }

  function host(f: any, klasaRoot: string): any {
    var h = d.createElement("div");
    h.setAttribute("data-midrev-formularz", f.id);
    var cien = h.attachShadow ? h.attachShadow({ mode: "open" }) : h;
    var st = d.createElement("style");
    st.textContent = CSS;
    cien.appendChild(st);
    var root = el("div", "mf-root " + klasaRoot);
    for (var k in f.zmienne) if (Object.prototype.hasOwnProperty.call(f.zmienne, k)) root.style.setProperty(k, f.zmienne[k]);
    cien.appendChild(root);
    return { host: h, cien: cien, root: root };
  }

  // ── Render jednego formularza ────────────────────────────────────────────
  function pokaz(f: any, kontener?: any): void {
    var osadzony = f.typ === "embed";
    if (!osadzony && otwarty) return;
    schowajTeaser(f);
    var H = host(f, "");
    var stan: any = { krok: 0, dane: { pola: {} }, token: null, kody: {}, zgloszenie: losowe() + losowe(), widziane: {}, wyslano: false };
    var poprzedni = d.activeElement;
    var opakowanie: any;
    if (f.typ === "popup") opakowanie = el("div", "mf-nakladka");
    else if (f.typ === "flyout") opakowanie = el("div", "mf-flyout mf-rog-" + (f.rog === "lewo" ? "lewo" : "prawo"));
    else opakowanie = el("div", "mf-embed");
    var karta = el("div", "mf-karta mf-obraz-" + f.obrazPozycja);
    if (!osadzony) {
      karta.setAttribute("role", "dialog");
      karta.setAttribute("aria-modal", f.typ === "popup" ? "true" : "false");
    }
    if (f.obrazPozycja === "tlo" && adresOk(f.obraz)) karta.style.backgroundImage = 'url("' + encodeURI(f.obraz).replace(/"/g, "%22") + '")';
    if ((f.obrazPozycja === "lewo" || f.obrazPozycja === "prawo" || f.obrazPozycja === "gora") && adresOk(f.obraz)) {
      var ob = el("div", "mf-obraz");
      ob.style.backgroundImage = 'url("' + encodeURI(f.obraz).replace(/"/g, "%22") + '")';
      ob.setAttribute("aria-hidden", "true");
      karta.appendChild(ob);
    }
    var tresc = el("div", "mf-tresc");
    karta.appendChild(tresc);
    opakowanie.appendChild(karta);
    H.root.appendChild(opakowanie);

    function zamknij(poZapisie: boolean): void {
      if (osadzony) return;
      if (H.host.parentNode) H.host.parentNode.removeChild(H.host);
      d.removeEventListener("keydown", klawisz, true);
      otwarty = null;
      zapisz(P + f.id + "_c", String(Date.now()));
      if (!poZapisie && !stan.wyslano && f.teaser && f.teaser.wlaczony) {
        zapisz(P + f.id + "_t", "1");
        pokazTeaser(f);
      }
      try { if (poprzedni && poprzedni.focus) poprzedni.focus(); } catch (e) { /* element zniknął */ }
    }

    function fokusowalne(): any[] {
      var l = karta.querySelectorAll("button, input, a[href], [tabindex]:not([tabindex='-1'])");
      var wynik: any[] = [];
      for (var i = 0; i < l.length; i++) if (!l[i].disabled) wynik.push(l[i]);
      return wynik;
    }
    function klawisz(e: any): void {
      if (e.key === "Escape") { e.preventDefault(); zamknij(stan.krok >= f.kroki.length); return; }
      if (e.key === "Tab" && f.typ === "popup") {
        var l = fokusowalne();
        if (!l.length) return;
        var aktywny = H.cien.activeElement;
        var i = l.indexOf(aktywny);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); l[l.length - 1].focus(); }
        else if (!e.shiftKey && (i === -1 || i === l.length - 1)) { e.preventDefault(); l[0].focus(); }
      }
    }

    function zobaczono(i: number): void {
      if (stan.widziane[i]) return;
      stan.widziane[i] = true;
      try { wyslij(K.api + "/" + f.id + "/wyswietlenie", { krok: i, gosc: gosc }, true).catch(function () { /* bez znaczenia */ }); } catch (e) { /* jw. */ }
    }

    function przejdz(i: number): void {
      stan.krok = i;
      rysuj();
    }
    function dalej(): void {
      przejdz(stan.krok + 1);
    }

    function rysuj(): void {
      var sukces = stan.krok >= f.kroki.length;
      var krok = sukces ? f.sukces : f.kroki[stan.krok];
      while (tresc.firstChild) tresc.removeChild(tresc.firstChild);
      zobaczono(stan.krok);
      if (!osadzony) {
        var x = el("button", "mf-zamknij", "×");
        x.type = "button";
        x.setAttribute("aria-label", "Zamknij");
        x.addEventListener("click", function () { zamknij(sukces); });
        karta.appendChild(x);
      }
      var blad = el("p", "mf-blad");
      blad.setAttribute("role", "alert");
      blad.hidden = true;
      var pola: any[] = [];
      var pierwszyNaglowek: any = null;
      for (var j = 0; j < krok.bloki.length; j++) {
        var e = blok(krok.bloki[j], pola, blad, sukces);
        if (!e) continue;
        if (!pierwszyNaglowek && krok.bloki[j].typ === "naglowek") pierwszyNaglowek = e;
        tresc.appendChild(e);
      }
      tresc.appendChild(blad);
      if (!osadzony) {
        if (pierwszyNaglowek) {
          pierwszyNaglowek.id = "mf-tytul-" + stan.krok;
          karta.setAttribute("aria-labelledby", pierwszyNaglowek.id);
        } else {
          karta.removeAttribute("aria-labelledby");
          karta.setAttribute("aria-label", f.nazwa || "Formularz zapisu");
        }
        var cel = pola.length ? pola[0].fokus : fokusowalne()[0];
        w.setTimeout(function () { try { if (cel) cel.focus({ preventScroll: true }); } catch (er) { /* jw. */ } }, 30);
      }
      if (sukces) {
        stan.wyslano = true;
        if (f.teaser) { usun(P + f.id + "_t"); }
      }
      // przycisk zamknięcia ma być ostatni w DOM tylko wizualnie: przenosimy go na koniec karty
      if (!osadzony) {
        var stare = karta.querySelectorAll(".mf-zamknij");
        for (var s = 0; s < stare.length - 1; s++) karta.removeChild(stare[s]);
      }
    }

    function blok(b: any, pola: any[], blad: any, sukces: boolean): any {
      var t = b.typ;
      if (t === "naglowek") {
        var h = el("h2", "mf-blok mf-naglowek", b.tekst);
        h.style.fontSize = Math.min(Math.max(Number(b.rozmiar) || 24, 16), 48) + "px";
        return b.tekst ? h : null;
      }
      if (t === "tekst") return b.tekst ? el("p", "mf-blok mf-tekst", b.tekst) : null;
      if (t === "obraz") {
        if (!adresOk(b.url)) return null;
        var im = el("img", "mf-blok mf-img");
        im.src = b.url;
        im.alt = b.alt || "";
        im.style.width = Math.min(Math.max(Number(b.szerokosc) || 100, 20), 100) + "%";
        return im;
      }
      if (t === "email" || t === "imie" || t === "telefon") {
        var lab = el("label", "mf-blok");
        var sr = el("span", "mf-sr", b.etykieta || b.placeholder);
        var inp = el("input", "mf-pole");
        inp.type = t === "email" ? "email" : t === "telefon" ? "tel" : "text";
        inp.name = t;
        inp.autocomplete = t === "email" ? "email" : t === "telefon" ? "tel" : "given-name";
        if (b.placeholder) inp.placeholder = b.placeholder;
        var wym = t === "email" || b.wymagane;
        if (wym) inp.required = true;
        inp.maxLength = t === "email" ? 320 : 120;
        if (stan.dane[t]) inp.value = stan.dane[t];
        lab.appendChild(sr);
        lab.appendChild(inp);
        pola.push({
          fokus: inp,
          zbierz: function () {
            var v = String(inp.value || "").trim();
            inp.setAttribute("aria-invalid", "false");
            if (!v && !wym) return null;
            if (!v) return { blad: t === "email" ? "Wpisz adres e-mail." : "Uzupełnij pole: " + (b.etykieta || b.placeholder) + "." };
            if (t === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return { blad: "Sprawdź adres e-mail." };
            if (t === "telefon" && !/^\+?[0-9 ()\-]{6,20}$/.test(v)) return { blad: "Sprawdź numer telefonu." };
            stan.dane[t] = v;
            return null;
          },
          oznacz: function () { inp.setAttribute("aria-invalid", "true"); },
        });
        return lab;
      }
      if (t === "pytanie") {
        var fs = el("fieldset", "mf-blok mf-pytanie");
        fs.appendChild(el("legend", "", b.pytanie));
        var op = el("div", "mf-opcje");
        var wejscia: any[] = [];
        var nazwa = "mf-" + b.id + "-" + stan.zgloszenie.slice(0, 6);
        for (var i = 0; i < b.opcje.length; i++) {
          if (!b.opcje[i]) continue;
          var l = el("label", "mf-opcja");
          var x = el("input");
          x.type = b.wielokrotny ? "checkbox" : "radio";
          x.name = nazwa;
          x.value = b.opcje[i];
          wejscia.push(x);
          l.appendChild(x);
          l.appendChild(d.createTextNode(b.opcje[i]));
          op.appendChild(l);
        }
        fs.appendChild(op);
        pola.push({
          fokus: wejscia[0],
          zbierz: function () {
            var wybrane: string[] = [];
            for (var k = 0; k < wejscia.length; k++) if (wejscia[k].checked) wybrane.push(wejscia[k].value);
            if (!wybrane.length) return b.wymagane ? { blad: "Wybierz odpowiedź." } : null;
            stan.dane.pola[b.wlasciwosc] = b.wielokrotny ? wybrane : wybrane[0];
            return null;
          },
          oznacz: function () { /* fieldset bez stanu błędu: komunikat wystarczy */ },
        });
        return fs;
      }
      if (t === "zgoda") {
        var z = el("div", "mf-blok mf-zgoda");
        var cb = el("input");
        cb.type = "checkbox";
        cb.id = "mf-zgoda-" + stan.zgloszenie.slice(0, 8);
        cb.checked = false; // NIEZAZNACZONE: zgoda tylko z aktywnego działania osoby
        var lz = el("label", "", f.zgoda ? f.zgoda.tekst : b.tekst);
        lz.setAttribute("for", cb.id);
        var kol = el("div");
        kol.appendChild(lz);
        var url = f.zgoda ? f.zgoda.url : null;
        if (adresOk(url)) {
          var a = el("a", "", "Polityka prywatności");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          kol.appendChild(d.createTextNode(" "));
          kol.appendChild(a);
        }
        z.appendChild(cb);
        z.appendChild(kol);
        pola.push({
          fokus: null,
          zgoda: true,
          zbierz: function () { return cb.checked ? null : { blad: "Zaznacz zgodę, żeby się zapisać." }; },
          oznacz: function () { cb.focus(); },
        });
        return z;
      }
      if (t === "kod") {
        var kod = stan.kody[b.id];
        if (!kod) return null;
        var opak = el("div", "mf-blok");
        if (b.opis) opak.appendChild(el("p", "mf-kod-opis", b.opis));
        var ramka = el("div", "mf-kod");
        ramka.appendChild(el("span", "mf-kod-wartosc", kod));
        var kop = el("button", "mf-kopiuj", "Kopiuj");
        kop.type = "button";
        kop.addEventListener("click", function () {
          try {
            w.navigator.clipboard.writeText(kod).then(function () { kop.textContent = "Skopiowano"; });
          } catch (e) { /* stara przeglądarka: kod da się zaznaczyć */ }
        });
        ramka.appendChild(kop);
        opak.appendChild(ramka);
        return opak;
      }
      if (t === "nie_dziekuje") {
        var n = el("button", "mf-blok mf-nie", b.tekst);
        n.type = "button";
        n.addEventListener("click", function () { zamknij(sukces); });
        return osadzony ? null : n;
      }
      if (t === "przycisk") {
        var p = el("button", "mf-blok mf-przycisk" + (b.akcja === "dalej" || b.akcja === "zamknij" ? " mf-drugi" : ""), b.tekst);
        p.type = "button";
        if (b.akcja === "zamknij" && osadzony) return null;
        p.addEventListener("click", function () { akcja(b, pola, blad, p, sukces); });
        return p;
      }
      return null;
    }

    function pokazBlad(blad: any, tekst: string): void {
      blad.textContent = tekst;
      blad.hidden = false;
    }

    function akcja(b: any, pola: any[], blad: any, przycisk: any, sukces: boolean): void {
      blad.hidden = true;
      if (b.akcja === "zamknij") { zamknij(sukces); return; }
      if (b.akcja === "url") {
        if (adresOk(b.url)) w.location.href = b.url;
        return;
      }
      if (b.akcja === "dalej" || sukces) {
        if (sukces) { zamknij(true); return; }
        dalej();
        return;
      }
      // „Wyślij i przejdź dalej”: walidacja wszystkich pól kroku
      for (var i = 0; i < pola.length; i++) {
        var wynik = pola[i].zbierz();
        if (wynik) { pola[i].oznacz(); pokazBlad(blad, wynik.blad); if (pola[i].fokus) pola[i].fokus.focus(); return; }
      }
      var krok = f.kroki[stan.krok];
      var zEmailem = stan.krok === f.krokEmail;
      var poEmailu = f.krokEmail >= 0 && stan.krok > f.krokEmail;
      if (!zEmailem && !poEmailu) { dalej(); return; } // przed e-mailem: odpowiedzi czekają w przeglądarce
      if (poEmailu && !stan.token) { dalej(); return; }
      przycisk.disabled = true;
      var cialo: any = zEmailem
        ? { email: stan.dane.email, zgoda: true, wersjaKlauzuli: f.zgoda.wersja, imie: stan.dane.imie, telefon: stan.dane.telefon, pola: stan.dane.pola, zgloszenie: stan.zgloszenie, krok: krok.id }
        : { token: stan.token, krok: krok.id, imie: stan.dane.imie, telefon: stan.dane.telefon, pola: stan.dane.pola };
      wyslij(K.api + "/" + f.id + (zEmailem ? "" : "/krok"), cialo, false)
        .then(function (o: any) { return o.json().then(function (j: any) { return { ok: o.ok, j: j }; }); })
        .then(function (r: any) {
          if (!r.ok || !r.j || !r.j.ok) throw new Error(r.j && r.j.blad === "formularz_zmieniony" ? "zmieniony" : "odmowa");
          if (zEmailem) {
            stan.token = r.j.token || null;
            stan.kody = r.j.kody || {};
            stan.wyslano = true;
            zapisz(P + "zapisany", "1");
            zapisz(P + f.id + "_z", "1");
            usun(P + f.id + "_t");
          }
          // właściwości wysłane: kolejny krok wysyła już tylko swoje
          stan.dane.pola = {};
          dalej();
        })
        .catch(function (er: any) {
          przycisk.disabled = false;
          pokazBlad(blad, er && er.message === "zmieniony"
            ? "Treść formularza się zmieniła. Odśwież stronę i spróbuj ponownie."
            : "Nie udało się zapisać. Spróbuj ponownie.");
        });
    }

    if (!osadzony) {
      d.addEventListener("keydown", klawisz, true);
      if (f.typ === "popup") opakowanie.addEventListener("click", function (e: any) { if (e.target === opakowanie) zamknij(stan.krok >= f.kroki.length); });
      otwarty = f.id;
      d.body.appendChild(H.host);
    } else {
      kontener.appendChild(H.host);
    }
    rysuj();
  }

  // ── Teaser: mała zakładka po zamknięciu ─────────────────────────────────
  var teasery: any = {};
  function schowajTeaser(f: any): void {
    if (teasery[f.id] && teasery[f.id].parentNode) teasery[f.id].parentNode.removeChild(teasery[f.id]);
    teasery[f.id] = null;
  }
  function pokazTeaser(f: any): void {
    if (teasery[f.id] || !f.teaser || !f.teaser.wlaczony || !f.teaser.tekst) return;
    var H = host(f, "");
    var t = el("div", "mf-teaser mf-rog-" + (f.rog === "lewo" ? "lewo" : "prawo"));
    var otworz = el("button", "", f.teaser.tekst);
    otworz.type = "button";
    otworz.setAttribute("aria-haspopup", "dialog");
    otworz.addEventListener("click", function () { if (!otwarty) pokaz(f); });
    var x = el("button", "mf-teaser-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Ukryj");
    x.addEventListener("click", function () { usun(P + f.id + "_t"); schowajTeaser(f); });
    t.appendChild(otworz);
    t.appendChild(x);
    H.root.appendChild(t);
    d.body.appendChild(H.host);
    teasery[f.id] = H.host;
  }

  // ── Wyzwalacze ──────────────────────────────────────────────────────────
  function uzbroj(f: any): void {
    var r = f.reguly;
    if (r.poKliknieciu) {
      d.addEventListener("click", function (e: any) {
        var cel: any = null;
        try { cel = e.target && e.target.closest ? e.target.closest(r.poKliknieciu) : null; } catch (er) { cel = null; }
        if (cel && tylkoMiejsce(f)) { e.preventDefault(); if (!otwarty) pokaz(f); }
      }, true);
    }
    if (!czyPokazac(r, kontekst(f))) {
      if (czytaj(P + f.id + "_t") === "1" && czytaj(P + f.id + "_z") !== "1") pokazTeaser(f);
      return;
    }
    var odpalony = false;
    function odpal(): void {
      if (odpalony || otwarty) return;
      odpalony = true;
      if (czyPokazac(r, kontekst(f))) pokaz(f);
    }
    if (r.poSekundach !== null && r.poSekundach !== undefined) w.setTimeout(odpal, Math.max(0, Number(r.poSekundach) || 0) * 1000);
    if (r.poPrzewinieciu) {
      var naPrzewiniecie = function () {
        var wys = Math.max(d.documentElement.scrollHeight - w.innerHeight, 1);
        if ((w.scrollY || d.documentElement.scrollTop) / wys * 100 >= r.poPrzewinieciu) { w.removeEventListener("scroll", naPrzewiniecie); odpal(); }
      };
      w.addEventListener("scroll", naPrzewiniecie, { passive: true });
    }
    if (r.przyWyjsciu && !telefon) {
      d.addEventListener("mouseout", function (e: any) { if (!e.relatedTarget && e.clientY <= 0) odpal(); });
    }
  }

  function start(): void {
    for (var i = 0; i < K.f.length; i++) {
      var f = K.f[i];
      try {
        if (f.typ === "embed") {
          if (!tylkoMiejsce(f)) continue;
          var miejsca = d.querySelectorAll('[data-midrev-form="' + f.id + '"]');
          for (var j = 0; j < miejsca.length; j++) if (!miejsca[j].getAttribute("data-mf-gotowe")) { miejsca[j].setAttribute("data-mf-gotowe", "1"); pokaz(f, miejsca[j]); }
        } else {
          uzbroj(f);
        }
      } catch (e) { /* jeden zepsuty formularz nie może zatrzymać pozostałych */ }
    }
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", start);
  else start();
}
