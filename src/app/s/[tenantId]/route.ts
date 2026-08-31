import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { config } from "../../../config";
import { aktywnyPopup } from "../../../usecases/popupy/zarzadzaj";

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

export const WERSJA_SKRYPTU = "1.0.0";

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
    endpoint: `${config().APP_URL}/api/popup/${popup.id}`,
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
    form.appendChild(pole);
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
      przycisk.disabled = true;
      przycisk.style.opacity = "0.6";
      blad.style.display = "none";
      fetch(K.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pole.value }),
      })
        .then(function (odp) { return odp.json().then(function (d) { return { s: odp.ok, d: d }; }); })
        .then(function (w) {
          if (!w.s || !w.d.ok) throw new Error("odmowa");
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
        .catch(function () {
          przycisk.disabled = false;
          przycisk.style.opacity = "1";
          blad.textContent = "Nie uda\\u0142o si\\u0119 zapisa\\u0107. Spr\\u00f3buj ponownie.";
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
