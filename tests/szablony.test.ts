import { describe, expect, it } from "vitest";
import {
  adresBezpieczny,
  dataDjango,
  zrodloBezpieczne,
  floatformat,
  oczyscTemat,
  przygotujZrodlo,
  renderujHtml,
  renderujTemat,
  sanityzujAdresy,
  sprawdzSzablon,
  zbudujKontekst,
} from "../src/domain/email/szablon";
import { przepiszLinki, zlozWiadomosc } from "../src/usecases/wysylka/renderuj";

// Zmienne w treści maila (story 4.5, AD-43): liquid z autoescape, filtry Klaviyo,
// sanityzacja adresów, temat bez CR/LF.

const ctx = zbudujKontekst({
  zdarzenie: {
    ProductName: "<script>alert(1)</script>",
    url: "javascript:alert(document.cookie)",
    atak: "x onmouseover=alert(1)",
    $value: 199.5,
    kiedy: "2026-09-30T08:05:00Z",
    $extra: { Items: [{ Name: "A" }] },
    produkty: ["Longevity", "Energia"],
  },
  profil: { email: "anna@example.test", first_name: "Anna", last_name: null, phone: null, properties: { quiz_v6_step: 3, Miasto: "Kraków" } },
  organizacja: "MySomi",
});

describe("Szablony: zmienne i filtry Klaviyo", () => {
  it("event, person, organization; skróty Klaviyo; brak zmiennej = pusto", () => {
    const html = renderujHtml(
      "<p>{{ person.first_name }} / {{ first_name }} / {{ person.Miasto }} / {{ person|lookup:'quiz_v6_step' }} / {{ organization.name }} / [{{ event.nieMa }}] / {{ event.extra.Items[0].Name }}</p>",
      ctx,
    );
    expect(html).toBe("<p>Anna / Anna / Kraków / 3 / MySomi / [] / A</p>");
  });

  it("składnia Django z edytora bloków: apostrofy jako &#39;, domyślna wartość, floatformat, date, if/for", () => {
    const zrodlo = "<p>Cześć {{ person.last_name|default:&#39;Przyjacielu&#39; }}! {{ event|lookup:&#39;$value&#39;|floatformat:2 }} zł, {{ event.kiedy|date:&#39;d.m.Y H:i&#39; }}{% if event.produkty contains &quot;Energia&quot; %} E{% endif %}{% for p in event.produkty %} [{{ p }}]{% endfor %}</p>";
    expect(renderujHtml(zrodlo, ctx)).toBe("<p>Cześć Przyjacielu! 199.50 zł, 30.09.2026 10:05 E [Longevity] [Energia]</p>");
    expect(floatformat(34.26)).toBe("34.3");
    expect(floatformat(34, -2)).toBe("34");
    expect(floatformat(34.2, -2)).toBe("34.20");
    expect(dataDjango("2026-01-05T23:30:00Z", "j.n.y G:i", "Europe/Warsaw")).toBe("6.1.26 0:30");
  });

  it("link z edytora (URL-kodowane klamry) dostaje wartość zmiennej", () => {
    const zrodlo = przygotujZrodlo('<a href="https://sklep.pl/p/%7B%7B%20person.first_name%20%7D%7D">x</a>');
    expect(zrodlo).toBe('<a href="https://sklep.pl/p/{{ person.first_name }}">x</a>');
    expect(renderujHtml('<a href="https://sklep.pl/p/%7B%7B%20person.first_name%20%7D%7D">x</a>', ctx)).toBe('<a href="https://sklep.pl/p/Anna">x</a>');
  });
});

describe("Szablony: bezpieczeństwo (AD-43)", () => {
  it("<script> z właściwości zdarzenia jest escapowany; |raw i |safe NIE omijają escapowania", () => {
    const html = renderujHtml("<p>{{ event.ProductName }}{{ event.ProductName | raw }}{{ event.ProductName | safe }}</p>", ctx);
    expect(html).not.toContain("<script>");
    expect(html.match(/&lt;script&gt;/g)).toHaveLength(3);
  });

  it("znaczniki wypisujące bez escapowania (echo, cycle) i czytające pliki są zablokowane", () => {
    for (const t of ["{% echo event.ProductName %}", "{% cycle event.ProductName, 'a' %}", "{% include 'x' %}", "{% render 'x' %}", "{% layout 'x' %}", "{% liquid echo event.ProductName %}"]) {
      expect(sprawdzSzablon("t", t), t).not.toBeNull();
      expect(() => renderujHtml(t, ctx)).toThrow();
    }
  });

  it("zmienna w atrybucie bez cudzysłowu nie dopisuje nowego atrybutu (= i ` escapowane)", () => {
    const html = renderujHtml("<a href=https://x.pl/{{ event.atak }}>x</a>", ctx);
    expect(html).not.toMatch(/onmouseover=/);
  });

  it("javascript: z właściwości zdarzenia w href jest usuwany po renderze", () => {
    expect(renderujHtml('<a href="{{ event.url }}">x</a>', ctx)).toBe("<a >x</a>");
  });

  it("brak dostępu do prototypów i konstruktorów", () => {
    expect(renderujHtml("[{{ event.constructor }}][{{ person.__proto__ }}][{{ event.ProductName.constructor.name }}]", ctx)).toBe("[][][]");
  });

  it("temat: bez escapowania HTML, bez CR/LF i znaków sterujących, maks. 255 znaków", () => {
    const t = renderujTemat("Hej {{ person.first_name }}\r\nBcc: ofiara@example.test {{ event.ProductName }}", ctx);
    expect(t).toBe("Hej Anna Bcc: ofiara@example.test <script>alert(1)</script>");
    expect(t).not.toMatch(/[\r\n]/);
    const zlosliwy = zbudujKontekst({ zdarzenie: { x: "a\r\nX-Header: 1 b" }, profil: {}, organizacja: "" });
    expect(renderujTemat("{{ event.x }}", zlosliwy)).toBe("a X-Header: 1 b");
    expect(Array.from(oczyscTemat("ż".repeat(400)))).toHaveLength(255);
  });

  it("limit czasu renderu: pętla bez końca kończy się błędem, nie wiszącym workerem", () => {
    const duzy = zbudujKontekst({ zdarzenie: { a: Array.from({ length: 2000 }, (_, i) => i) }, profil: {}, organizacja: "" });
    expect(() => renderujHtml("{% for x in event.a %}{% for y in event.a %}{% for z in event.a %}.{% endfor %}{% endfor %}{% endfor %}", duzy)).toThrow();
  });

  it("błąd składni i nieznany filtr są wykrywane przy publikacji", () => {
    expect(sprawdzSzablon("{{ person.first_name", "<p>x</p>")).toMatch(/temat/);
    expect(sprawdzSzablon("x", "{% if a %}")).toMatch(/treść/);
    expect(sprawdzSzablon("x", "{{ a | nieistniejacy }}")).toMatch(/nieistniejacy/);
    expect(sprawdzSzablon("Cześć {{ person.first_name|default:'tam' }}", "<p>{{ event.ProductName }}</p>")).toBeNull();
  });
});

describe("Adresy w treści: javascript: nie przejdzie także bez zmiennych (przepiszLinki, zlozWiadomosc)", () => {
  it("wszystkie warianty zapisu schematu są odrzucane, http(s)/mailto/tel i względne zostają", () => {
    for (const zly of ["javascript:alert(1)", "JaVaScRiPt:x", " javascript:x", "java\tscript:x", "java&#115;cript:x", "&#106avascript:x", "javascript&colon;x", "vbscript:x", "data:text/html,x", "java&shy;script:x", "/sciezka", "//evil.test/x", "?a=b:c", ""]) {
      expect(adresBezpieczny(zly), zly).toBe(false);
    }
    for (const dobry of ["https://sklep.pl/a?b=c:d", "http://x.pl", "mailto:a@b.pl", "tel:+48123", "#kotwica", " HTTPS://x.pl"]) {
      expect(adresBezpieczny(dobry), dobry).toBe(true);
    }
    expect(sanityzujAdresy(`<a href="javascript:x">1</a><a/href=javascript:x>2</a><img src='data:text/html,x'><a href="https://ok.pl">3</a><a href="//evil.test">4</a>`))
      .toBe(`<a >1</a><a/ >2</a><img ><a href="https://ok.pl">3</a><a >4</a>`);
  });

  it("źródła obrazów: http(s), cid, rastrowe data:image; srcset sprawdzany kandydat po kandydacie; background i poster też", () => {
    expect(zrodloBezpieczne("https://cdn.pl/a.png")).toBe(true);
    expect(zrodloBezpieczne("cid:logo")).toBe(true);
    expect(zrodloBezpieczne("data:image/png;base64,AAAA")).toBe(true);
    expect(zrodloBezpieczne("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(zrodloBezpieczne("javascript:x")).toBe(false);
    expect(sanityzujAdresy(`<img srcset="https://a.pl/1.png 1x, data:image/svg+xml,<svg/> 2x"><img srcset="https://a.pl/1.png 1x, https://a.pl/2.png 2x">`))
      .toBe(`<img ><img srcset="https://a.pl/1.png 1x, https://a.pl/2.png 2x">`);
    expect(sanityzujAdresy(`<img srcset="data:image/png;base64,AAAA 1x, https://a.pl/2.png 2x">`)).toContain("srcset=");
    expect(sanityzujAdresy(`<img srcset="https://a.pl/1.png 1x,javascript:x 2x">`)).toBe(`<img >`);
    expect(sanityzujAdresy(`<td background="javascript:x">a</td><video poster='vbscript:x'></video><form action="javascript:x"><button formaction=javascript:x>`))
      .toBe(`<td >a</td><video ></video><form ><button >`);
  });

  it("tryb łagodny (każda treść): jawne złe schematy odpadają, względne i kotwice zostają jak dotąd", () => {
    expect(adresBezpieczny("/lokalny", false)).toBe(true);
    expect(adresBezpieczny("//cdn.pl/x", false)).toBe(true);
    expect(adresBezpieczny("javascript:x", false)).toBe(false);
    expect(adresBezpieczny("java&#115;cript:x", false)).toBe(false);
    expect(adresBezpieczny("java&shy;script:x", false)).toBe(false);
    expect(zrodloBezpieczne("/logo.png", false)).toBe(true);
    expect(sanityzujAdresy(`<a href="/lokalny">1</a><a href="javascript:x">2</a>`, { scisle: false })).toBe(`<a href="/lokalny">1</a><a >2</a>`);
  });

  it("kampania i automatyzacja: link javascript: znika niezależnie od śledzenia kliknięć", () => {
    const tresc = `<p><a href="javascript:alert(1)">zły</a> <a href="https://sklep.pl">dobry</a></p>`;
    expect(przepiszLinki(tresc, "tok").html).not.toMatch(/javascript/i);
    for (const sledzKlikniecia of [true, false]) {
      const { html } = zlozWiadomosc({ trescHtml: tresc, clickToken: "tok", unsubscribeToken: "u", nazwaSklepu: "S", sledzKlikniecia, sledzOtwarcia: false });
      expect(html).not.toMatch(/javascript/i);
    }
  });
});
