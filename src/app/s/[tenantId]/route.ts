import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { adresSledzenia } from "../../../config";
import { aktywnyPopup } from "../../../usecases/popupy/zarzadzaj";
import { WERSJA_SKRYPTU } from "../wersja-skryptu";

/**
 * Skrypt on-site (Epik F, AD-19): sklep wkleja jeden tag
 *   <script src=".../s/TENANT_ID"></script>
 * i dostaje samodzielny JS bez zaleznosci, ktory po zadanym opoznieniu pokazuje
 * popup zapisu na newsletter i wysyla zgloszenie na publiczny endpoint.
 *
 * Wersja skryptu jest jawna (komentarz + naglowek X-Script-Version), bo skrypt
 * zyje w cudzych przegladarkach: kontrakt danych zmienia sie wylacznie wstecznie
 * zgodnie, a wersja pozwala w ogole zauwazyc, co kto ma zaladowane.
 *
 * Obrona przed XSS: tresc popupu (headline, body) pochodzi z bazy, czyli od
 * operatora, ale i tak NIGDY nie trafia do innerHTML - wszystko wchodzi przez
 * textContent, a konfiguracja jest wstrzykiwana jako JSON z przeescapowanym "<",
 * zeby nie dalo sie domknac tagu </script> trescia popupu.
 */


const schematId = z.string().uuid();

function naglowki(): Record<string, string> {
  return {
    "Content-Type": "application/javascript; charset=utf-8",
    "X-Script-Version": WERSJA_SKRYPTU,
    // krotki cache: sklepy laduja skrypt przy kazdym wejsciu, ale wylaczenie
    // popupu w panelu ma byc widoczne w minute, nie po dobie
    "Cache-Control": "public, max-age=60",
  };
}

/** JSON bezpieczny do wklejenia w <script>: bez "<" i separatorow linii U+2028/29. */
function bezpiecznyJson(dane: unknown): string {
  return JSON.stringify(dane)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export async function GET(_zadanie: NextRequest, ctx: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await ctx.params;

  const popup = schematId.safeParse(tenantId).success ? await aktywnyPopup(tenantId) : null;
  if (!popup) {
    // 200 z pustym skryptem, nie 404: tag <script> na stronie sklepu ma byc
    // bezobjawowy, gdy zaden popup nie jest wlaczony
    return new NextResponse(
      `/* midrev-esp popup v${WERSJA_SKRYPTU} - brak aktywnego popupu */\n`,
      { headers: naglowki() },
    );
  }

  const konfig = {
    headline: popup.headline,
    bodyText: popup.body_text,
    buttonText: popup.button_text,
    delaySeconds: popup.rules?.delay_seconds ?? 0,
    // klauzula: DOKLADNIE ten tekst trafia do dowodu zgody (serwer bierze go z wersji z bazy)
    consentText: popup.consent_wording,
    consentVersion: popup.consent_version,
    privacyUrl: popup.consent_privacy_url,
    endpoint: `${adresSledzenia()}/api/popup/${popup.id}`,
    klucz: `midrev_popup_zamkniety_${popup.id}`,
  };

  const skrypt = `/* midrev-esp popup v${WERSJA_SKRYPTU} */
(function () {
  "use strict";
  var K = ${bezpiecznyJson(konfig)};
  var TYDZIEN_MS = 7 * 24 * 60 * 60 * 1000;

  // zamkniecie pamietane 7 dni; localStorage w try, bo w trybie prywatnym
  // niektorych przegladarek sam odczyt potrafi rzucic
  function zamknietoNiedawno() {
    try {
      var t = window.localStorage.getItem(K.klucz);
      return t !== null && Date.now() - Number(t) < TYDZIEN_MS;
    } catch (e) { return false; }
  }
  function zapamietajZamkniecie() {
    try { window.localStorage.setItem(K.klucz, String(Date.now())); } catch (e) {}
  }

  if (zamknietoNiedawno()) return;
  if (window.__midrevPopup) return; // tag wklejony dwa razy nie ma dawac dwoch popupow
  window.__midrevPopup = true;

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    // textContent, nigdy innerHTML: tresc z konfiguracji nie ma prawa stac sie HTML-em
    if (text) e.textContent = text;
    return e;
  }

  function pokaz() {
    if (zamknietoNiedawno()) return;

    var tlo = el("div",
      "position:fixed;inset:0;z-index:2147483000;background:rgba(8,9,12,0.66);" +
      "display:flex;align-items:center;justify-content:center;padding:16px;");
    var karta = el("div",
      "position:relative;max-width:380px;width:100%;background:#101218;color:#e7e9f0;" +
      "border:1px solid #2a2f3d;border-radius:12px;padding:28px 24px 24px;" +
      "box-shadow:0 24px 64px rgba(0,0,0,0.5);" +
      "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:left;" +
      "box-sizing:border-box;");
    tlo.appendChild(karta);

    var zamknij = el("button", null, "\\u00d7");
    zamknij.setAttribute("type", "button");
    zamknij.setAttribute("aria-label", "Zamknij");
    zamknij.setAttribute("style",
      "position:absolute;top:8px;right:10px;background:none;border:0;color:#8b90a0;" +
      "font-size:22px;line-height:1;cursor:pointer;padding:4px;");
    karta.appendChild(zamknij);

    karta.appendChild(el("div",
      "font-size:20px;font-weight:600;letter-spacing:-0.01em;margin:0 16px 8px 0;",
      K.headline));
    karta.appendChild(el("div",
      "font-size:14px;line-height:20px;color:#a4a9ba;margin-bottom:16px;",
      K.bodyText));

    var form = el("form", "display:flex;flex-direction:column;gap:10px;");
    var pole = el("input",
      "height:38px;padding:0 12px;border-radius:8px;border:1px solid #2a2f3d;" +
      "background:#0a0b0f;color:#e7e9f0;font-size:14px;outline:none;box-sizing:border-box;width:100%;");
    pole.setAttribute("type", "email");
    pole.setAttribute("required", "required");
    pole.setAttribute("name", "email");
    pole.setAttribute("placeholder", "Tw\\u00f3j adres e-mail");
    pole.setAttribute("autocomplete", "email");
    var przycisk = el("button", null, K.buttonText);
    przycisk.setAttribute("type", "submit");
    przycisk.setAttribute("style",
      "height:38px;border-radius:8px;border:0;background:#3d55a8;color:#fff;" +
      "font-size:14px;font-weight:500;cursor:pointer;");
    var blad = el("div", "display:none;font-size:12px;color:#e0655f;", "");
    blad.setAttribute("role", "alert");

    // Klauzula zgody: pole wyboru NIEZAZNACZONE, tekst przez textContent (to samo brzmienie,
    // ktore serwer zapisze jako dowod), link do polityki tylko http(s).
    var zgodaId = "midrev-zgoda-" + Math.random().toString(36).slice(2);
    var zgodaWiersz = el("div", "display:flex;gap:8px;align-items:flex-start;");
    var zgoda = el("input", "margin:2px 0 0;width:16px;height:16px;flex:none;accent-color:#3d55a8;cursor:pointer;");
    zgoda.setAttribute("type", "checkbox");
    zgoda.setAttribute("id", zgodaId);
    zgoda.setAttribute("name", "zgoda");
    zgoda.checked = false;
    var zgodaTekst = el("label", "font-size:12px;line-height:17px;color:#a4a9ba;cursor:pointer;white-space:pre-line;", K.consentText);
    zgodaTekst.setAttribute("for", zgodaId);
    zgodaWiersz.appendChild(zgoda);
    zgodaWiersz.appendChild(zgodaTekst);
    var polityka = null;
    if (K.privacyUrl && /^https?:\\/\\//i.test(K.privacyUrl)) {
      polityka = el("a", "font-size:12px;color:#a4a9ba;text-decoration:underline;margin-left:24px;", "Polityka prywatno\\u015bci");
      polityka.setAttribute("href", K.privacyUrl);
      polityka.setAttribute("target", "_blank");
      polityka.setAttribute("rel", "noopener noreferrer");
    }

    form.appendChild(pole);
    form.appendChild(zgodaWiersz);
    if (polityka) form.appendChild(polityka);
    form.appendChild(przycisk);
    form.appendChild(blad);
    karta.appendChild(form);

    function schowaj() {
      zapamietajZamkniecie();
      if (tlo.parentNode) tlo.parentNode.removeChild(tlo);
      document.removeEventListener("keydown", naEscape);
    }
    function naEscape(zd) { if (zd.key === "Escape") schowaj(); }
    zamknij.addEventListener("click", schowaj);
    tlo.addEventListener("click", function (zd) { if (zd.target === tlo) schowaj(); });
    document.addEventListener("keydown", naEscape);

    form.addEventListener("submit", function (zd) {
      zd.preventDefault();
      if (!zgoda.checked) {
        blad.textContent = "Zaznacz zgod\\u0119, \\u017ceby si\\u0119 zapisa\\u0107.";
        blad.style.display = "block";
        zgoda.focus();
        return;
      }
      przycisk.disabled = true;
      przycisk.style.opacity = "0.6";
      blad.style.display = "none";
      fetch(K.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pole.value, zgoda: zgoda.checked === true, wersjaKlauzuli: K.consentVersion }),
      })
        .then(function (odp) { return odp.json().then(function (d) { return { s: odp.ok, d: d }; }); })
        .then(function (w) {
          if (!w.s || !w.d.ok) throw new Error(w.d && w.d.blad === "formularz_zmieniony" ? "zmieniony" : "odmowa");
          // podziekowanie w miejscu formularza; kod rabatowy tez przez textContent
          while (karta.childNodes.length > 1) karta.removeChild(karta.lastChild);
          karta.appendChild(el("div",
            "font-size:20px;font-weight:600;margin:0 16px 8px 0;", "Dzi\\u0119kujemy!"));
          karta.appendChild(el("div",
            "font-size:14px;line-height:20px;color:#a4a9ba;",
            w.d.discountCode ? "Tw\\u00f3j kod rabatowy:" : "Zapisano Tw\\u00f3j adres."));
          if (w.d.discountCode) {
            karta.appendChild(el("div",
              "margin-top:10px;padding:10px 12px;border:1px dashed #3d55a8;border-radius:8px;" +
              "font-size:16px;font-weight:600;letter-spacing:0.06em;text-align:center;" +
              "user-select:all;", w.d.discountCode));
          }
          zapamietajZamkniecie();
        })
        .catch(function (e) {
          przycisk.disabled = false;
          przycisk.style.opacity = "1";
          blad.textContent = e && e.message === "zmieniony"
            ? "Tre\\u015b\\u0107 formularza si\\u0119 zmieni\\u0142a. Od\\u015bwie\\u017c stron\\u0119 i spr\\u00f3buj ponownie."
            : "Nie uda\\u0142o si\\u0119 zapisa\\u0107. Spr\\u00f3buj ponownie.";
          blad.style.display = "block";
        });
    });

    document.body.appendChild(tlo);
  }

  function start() {
    window.setTimeout(pokaz, Math.max(0, Number(K.delaySeconds) || 0) * 1000);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
`;

  return new NextResponse(skrypt, { headers: naglowki() });
}
