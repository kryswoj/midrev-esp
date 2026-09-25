import { describe, expect, it } from "vitest";
import {
  bezpiecznyKolor,
  bezpiecznyUrl,
  cofnij,
  duplikujBlok,
  LIMIT_HISTORII,
  nowaHistoria,
  nowyBlok,
  ponow,
  przeniesBlok,
  przesunBlok,
  pustyDokument,
  sanityzujTekst,
  schematDokumentu,
  SZABLONY,
  tekstPusty,
  usunBlok,
  wstawBlok,
  zapiszWHistorii,
  zmienBlok,
  type DokumentMaila,
} from "../src/domain/email/bloki";

function trzyBloki(): DokumentMaila {
  const d = pustyDokument();
  return { ...d, bloki: [nowyBlok("naglowek"), nowyBlok("tekst"), nowyBlok("stopka")] };
}

describe("edytor: operacje na dokumencie", () => {
  it("wstaw, usuń, duplikuj — bez mutacji dokumentu wejściowego", () => {
    const d = trzyBloki();
    const kopiaWejscia = JSON.stringify(d);
    const z = wstawBlok(d, nowyBlok("obraz"), 1);
    expect(z.bloki.map((b) => b.typ)).toEqual(["naglowek", "obraz", "tekst", "stopka"]);
    expect(usunBlok(z, z.bloki[1].id).bloki).toHaveLength(3);
    const dup = duplikujBlok(d, d.bloki[1].id);
    expect(dup.dokument.bloki.map((b) => b.typ)).toEqual(["naglowek", "tekst", "tekst", "stopka"]);
    expect(dup.noweId).not.toBe(d.bloki[1].id);
    expect(JSON.stringify(d)).toBe(kopiaWejscia);
  });

  it("przenoszenie: indeksy sprzed zmiany, granice tablicy", () => {
    const d = trzyBloki();
    const [a, b, c] = d.bloki.map((x) => x.id);
    expect(przeniesBlok(d, 0, 2).bloki.map((x) => x.id)).toEqual([b, c, a]);
    expect(przesunBlok(d, a, -1)).toEqual(d);
    expect(przesunBlok(d, c, 1).bloki.map((x) => x.id)).toEqual([a, b, c]);
    expect(przesunBlok(d, b, 1).bloki.map((x) => x.id)).toEqual([a, c, b]);
  });

  it("zmienBlok nie pozwala podmienić id ani typu", () => {
    const d = trzyBloki();
    const z = zmienBlok(d, d.bloki[1].id, { typ: "html", id: "obcy", html: "x" } as never);
    expect(z.bloki[1].typ).toBe("tekst");
    expect(z.bloki[1].id).toBe(d.bloki[1].id);
  });

  it("nowe bloki i szablony przechodzą schemat zapisu", () => {
    for (const t of ["naglowek", "tekst", "obraz", "przycisk", "separator", "odstep", "kolumny", "produkt", "kod", "social", "stopka", "html"] as const) {
      expect(schematDokumentu.safeParse({ ...pustyDokument(), bloki: [nowyBlok(t)] }).success).toBe(true);
    }
    for (const s of SZABLONY) expect(schematDokumentu.safeParse(s.zbuduj()).success).toBe(true);
  });
});

describe("edytor: historia cofania", () => {
  it("cofnij/ponów, nowa zmiana czyści przyszłość", () => {
    const d0 = trzyBloki();
    let h = nowaHistoria(d0);
    const d1 = usunBlok(d0, d0.bloki[0].id);
    h = zapiszWHistorii(h, d1);
    h = cofnij(h);
    expect(h.biezacy).toBe(d0);
    h = ponow(h);
    expect(h.biezacy).toBe(d1);
    h = cofnij(h);
    h = zapiszWHistorii(h, wstawBlok(d0, nowyBlok("obraz"), 0));
    expect(h.przyszlosc).toHaveLength(0);
    expect(cofnij(nowaHistoria(d0)).biezacy).toBe(d0);
  });

  it("pisanie w jednym polu w krótkim oknie to jeden krok cofania; inne pole albo przerwa — osobny", () => {
    const d0 = trzyBloki();
    const id = d0.bloki[1].id;
    let h = nowaHistoria(d0);
    let d = d0;
    for (const [i, t] of ["A", "Al", "Ala"].entries()) {
      d = zmienBlok(d, id, { html: t } as never);
      h = zapiszWHistorii(h, d, `${id}:html`, 1000 + i * 100);
    }
    expect(h.przeszlosc).toHaveLength(1);
    expect(cofnij(h).biezacy).toBe(d0);
    h = zapiszWHistorii(h, zmienBlok(d, id, { html: "Ala ma" } as never), `${id}:html`, 5000);
    expect(h.przeszlosc).toHaveLength(2);
  });

  it("historia ma limit", () => {
    let h = nowaHistoria(trzyBloki());
    for (let i = 0; i < LIMIT_HISTORII + 20; i++) h = zapiszWHistorii(h, wstawBlok(h.biezacy, nowyBlok("odstep"), 0));
    expect(h.przeszlosc).toHaveLength(LIMIT_HISTORII);
  });
});

describe("edytor: sanityzacja tekstu z płótna", () => {
  it("domyka i poprawnie zagnieżdża znaczniki", () => {
    expect(sanityzujTekst("<b>pogrubione")).toBe("<b>pogrubione</b>");
    expect(sanityzujTekst("<b><i>x</b>y</i>")).toBe("<b><i>x</i></b>y");
    expect(sanityzujTekst("</b>x")).toBe("x");
  });

  it("bloki z contenteditable zamieniają się w <br>, końcowe przejścia znikają", () => {
    expect(sanityzujTekst("<div>a</div><div>b</div><div><br></div>")).toBe("a<br>b");
    expect(sanityzujTekst("a<p>b</p>")).toBe("a<br>b");
  });

  it("styl, klasy i nieznane znaczniki znikają, tekst zostaje", () => {
    expect(sanityzujTekst('<span style="color:red" class="x">a</span><font>b</font>')).toBe("ab");
    expect(sanityzujTekst("<!-- k --><style>x</style>c")).toBe("c");
  });

  it("goły & i nawiasy są escapowane, istniejące encje zostają", () => {
    expect(sanityzujTekst("A & B &amp; C < D > E")).toBe("A &amp; B &amp; C &lt; D &gt; E");
  });

  it("link: tylko http(s)/mailto, bez innych atrybutów, bez linku w linku", () => {
    expect(sanityzujTekst('<a href="https://s.pl/?a=1&amp;b=2" target="_blank" onclick="x">L</a>')).toBe('<a href="https://s.pl/?a=1&b=2">L</a>');
    expect(sanityzujTekst('<a href="mailto:biuro@s.pl">M</a>')).toBe('<a href="mailto:biuro@s.pl">M</a>');
    expect(sanityzujTekst('<a href="javascript:alert(1)">J</a>')).toBe("J");
    expect(sanityzujTekst('<a href="&#106;avascript:alert(1)">J</a>')).toBe("J");
    expect(sanityzujTekst('<a href="https://a.pl"><a href="https://b.pl">x</a></a>')).toBe('<a href="https://a.pl/">x</a>');
  });

  it("tekstPusty rozpoznaje pusty tekst po sanityzacji", () => {
    expect(tekstPusty("<br>&nbsp; ")).toBe(true);
    expect(tekstPusty("<b>x</b>")).toBe(false);
  });
});

describe("edytor: adresy i kolory", () => {
  it("bezpiecznyUrl", () => {
    expect(bezpiecznyUrl("https://sklep.pl/a b")).toBeNull();
    expect(bezpiecznyUrl("  https://sklep.pl/x?q=\"y\" ")).toBe("https://sklep.pl/x?q=%22y%22");
    expect(bezpiecznyUrl("mailto:a@b.pl")).toBeNull();
    expect(bezpiecznyUrl("mailto:a@b.pl", "www-lub-mail")).toBe("mailto:a@b.pl");
    expect(bezpiecznyUrl("JAVASCRIPT:alert(1)")).toBeNull();
    expect(bezpiecznyUrl("//sklep.pl")).toBeNull();
    expect(bezpiecznyUrl("ftp://sklep.pl")).toBeNull();
  });

  it("bezpiecznyKolor", () => {
    expect(bezpiecznyKolor("#ABC", "#000000")).toBe("#aabbcc");
    expect(bezpiecznyKolor("red", "#000000")).toBe("#000000");
    expect(bezpiecznyKolor("#fff;background:url(x)", "#000000")).toBe("#000000");
  });
});
