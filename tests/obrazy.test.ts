import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { config } from "../src/config";
import { rozpoznajObraz } from "../src/usecases/obrazy/format";
import {
  MAKS_ROZMIAR_OBRAZU,
  brakujaceObrazy,
  obrazyTenanta,
  plikPoTokenie,
  tokenyObrazowWHtml,
  usunObraz,
  wgrajObraz,
} from "../src/usecases/obrazy/biblioteka";
import { katalogObrazow, sciezkaObrazu } from "../src/usecases/obrazy/pliki";
import { GET as serwujObraz } from "../src/app/o/[plik]/route";

/**
 * Biblioteka obrazów (audyt #14): plik od użytkownika jest niezaufany. Rozpoznanie po
 * magicznych bajtach, limit 5 MB, brak SVG, ścieżka na dysku wyłącznie z UUID, izolacja
 * tenantów i blokada usunięcia obrazu, który już jest w mailu poza szkicem.
 */

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF_1x1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
// JPEG: SOI, APP0 (JFIF), SOF0 z wysokością 2 i szerokością 3
const JPEG_3x2 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);
// WebP bezstratny (VP8L) 3x2
const WEBP_3x2 = Buffer.concat([
  Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8L"), Buffer.from([0x0d, 0, 0, 0]),
  Buffer.from([0x2f, 0x02, 0x40, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script></svg>');

describe("obrazy: rozpoznanie po magicznych bajtach", () => {
  it("PNG, JPEG, GIF i WebP z wymiarami z nagłówka", () => {
    expect(rozpoznajObraz(PNG_1x1)).toEqual({ format: "png", mime: "image/png", szerokosc: 1, wysokosc: 1 });
    expect(rozpoznajObraz(JPEG_3x2)).toEqual({ format: "jpg", mime: "image/jpeg", szerokosc: 3, wysokosc: 2 });
    expect(rozpoznajObraz(GIF_1x1)).toEqual({ format: "gif", mime: "image/gif", szerokosc: 1, wysokosc: 1 });
    expect(rozpoznajObraz(WEBP_3x2)).toEqual({ format: "webp", mime: "image/webp", szerokosc: 3, wysokosc: 2 });
  });

  it("SVG, HTML i sama sygnatura bez nagłówka odpadają", () => {
    expect(rozpoznajObraz(SVG)).toBeNull();
    expect(rozpoznajObraz(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(rozpoznajObraz(PNG_1x1.subarray(0, 12))).toBeNull();
    expect(rozpoznajObraz(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("<script>")]))).toBeNull();
    expect(rozpoznajObraz(Buffer.alloc(0))).toBeNull();
  });
});

describe("obrazy: biblioteka tenanta (baza + dysk)", () => {
  const pool = getPool();
  let tenantId: string;
  let obcyTenantId: string;

  beforeAll(async () => {
    await pool.query("delete from tenants where name like 'OBRAZY %'");
    tenantId = (await pool.query("insert into tenants (name) values ('OBRAZY tenant') returning id")).rows[0].id;
    obcyTenantId = (await pool.query("insert into tenants (name) values ('OBRAZY obcy') returning id")).rows[0].id;
  });

  afterAll(async () => {
    for (const t of [tenantId, obcyTenantId]) if (t) await rm(join(katalogObrazow(), t), { recursive: true, force: true });
    await pool.query("delete from tenants where name like 'OBRAZY %'");
    await closePool();
  });

  const teraz = new Date("2026-09-25T10:00:00Z");

  it("wgranie: plik pod var/obrazy/{tenant}/{uuid}.{ext}, wiersz z jawną datą, adres z APP_URL", async () => {
    const w = await wgrajObraz(tenantId, { bajty: PNG_1x1, nazwa: "../../../.env baner.png", autor: "test@midrev.pl", kiedy: teraz });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.obraz.url).toMatch(new RegExp(`^${config().APP_URL.replace(/[.]/g, "\\.")}/o/[A-Za-z0-9_-]{43}\\.png$`));
    expect(w.obraz.sciezka).toMatch(/^\/o\/[A-Za-z0-9_-]{43}\.png$/);
    // nazwa od użytkownika odkażona, i tylko do wyświetlenia
    expect(w.obraz.nazwa).not.toContain("/");
    const { rows } = await pool.query("select * from images where id = $1", [w.obraz.id]);
    expect(rows[0].tenant_id).toBe(tenantId);
    expect(rows[0].mime).toBe("image/png");
    expect(rows[0].size_bytes).toBe(PNG_1x1.byteLength);
    expect(new Date(rows[0].uploaded_at).toISOString()).toBe(teraz.toISOString());
    const sciezka = sciezkaObrazu(tenantId, w.obraz.id, "png");
    expect(sciezka).toBe(join(katalogObrazow(), tenantId, `${w.obraz.id}.png`));
    expect(existsSync(sciezka)).toBe(true);
  });

  it("SVG i za duży plik: odmowa, bez wiersza i bez pliku", async () => {
    const przed = (await pool.query("select count(*)::int as n from images where tenant_id = $1", [tenantId])).rows[0].n;
    const svg = await wgrajObraz(tenantId, { bajty: SVG, nazwa: "logo.svg", autor: null, kiedy: teraz });
    expect(svg).toMatchObject({ ok: false, status: 415 });
    // PNG przebrany rozszerzeniem: bajty rozstrzygają, nie nazwa
    const html = await wgrajObraz(tenantId, { bajty: Buffer.from("<html></html>"), nazwa: "zdjecie.png", autor: null, kiedy: teraz });
    expect(html).toMatchObject({ ok: false, status: 415 });
    const duzy = Buffer.concat([PNG_1x1, Buffer.alloc(MAKS_ROZMIAR_OBRAZU)]);
    expect(await wgrajObraz(tenantId, { bajty: duzy, nazwa: "duzy.png", autor: null, kiedy: teraz })).toMatchObject({ ok: false, status: 413 });
    const po = (await pool.query("select count(*)::int as n from images where tenant_id = $1", [tenantId])).rows[0].n;
    expect(po).toBe(przed);
  });

  it("ścieżka na dysku odmawia wszystkiego, co nie jest UUID i rozszerzeniem z listy", () => {
    expect(() => sciezkaObrazu("../../etc", "00000000-0000-0000-0000-000000000000", "png")).toThrow();
    expect(() => sciezkaObrazu(tenantId, "../x", "png")).toThrow();
    expect(() => sciezkaObrazu(tenantId, "00000000-0000-0000-0000-000000000000", "svg")).toThrow();
  });

  it("trasa publiczna: Content-Type z metadanych, nosniff, cache; zły token i złe rozszerzenie = 404", async () => {
    const w = await wgrajObraz(tenantId, { bajty: GIF_1x1, nazwa: "a.gif", autor: null, kiedy: teraz });
    if (!w.ok) throw new Error(w.blad);
    const plik = w.obraz.sciezka.slice(3);
    const odp = await serwujObraz(new Request(`http://x${w.obraz.sciezka}`) as any, { params: Promise.resolve({ plik }) });
    expect(odp.status).toBe(200);
    expect(odp.headers.get("content-type")).toBe("image/gif");
    expect(odp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(odp.headers.get("cache-control")).toContain("max-age=31536000");
    expect(odp.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await odp.arrayBuffer()).equals(GIF_1x1)).toBe(true);

    const zleRozszerzenie = plik.replace(/\.gif$/, ".png");
    expect((await serwujObraz(new Request("http://x") as any, { params: Promise.resolve({ plik: zleRozszerzenie }) })).status).toBe(404);
    expect((await serwujObraz(new Request("http://x") as any, { params: Promise.resolve({ plik: "..%2F..%2F.env" }) })).status).toBe(404);
    expect((await serwujObraz(new Request("http://x") as any, { params: Promise.resolve({ plik: `${"A".repeat(43)}.gif` }) })).status).toBe(404);
  });

  it("izolacja: obcy tenant nie widzi obrazu w bibliotece i nie może go usunąć", async () => {
    const w = await wgrajObraz(tenantId, { bajty: PNG_1x1, nazwa: "moj.png", autor: null, kiedy: teraz });
    if (!w.ok) throw new Error(w.blad);
    expect((await obrazyTenanta(obcyTenantId)).map((o) => o.id)).not.toContain(w.obraz.id);
    expect(await usunObraz(obcyTenantId, w.obraz.id)).toMatchObject({ ok: false, status: 404 });
    expect((await pool.query("select 1 from images where id = $1", [w.obraz.id])).rowCount).toBe(1);
    // obraz obcego sklepu wklejony w treść liczy się jako brakujący w tym sklepie
    expect(await brakujaceObrazy(obcyTenantId, `<img src="${w.obraz.url}">`)).toBe(1);
    expect(await brakujaceObrazy(tenantId, `<img src="${w.obraz.url}">`)).toBe(0);
  });

  it("usunięcie: zablokowane, gdy obraz jest w kampanii poza szkicem albo w automatyzacji; plik zostaje", async () => {
    const w = await wgrajObraz(tenantId, { bajty: PNG_1x1, nazwa: "wyslany.png", autor: null, kiedy: teraz });
    if (!w.ok) throw new Error(w.blad);
    const tresc = JSON.stringify({ html: `<img src="${w.obraz.url}">` });
    for (const status of ["awaiting_approval", "approved", "sending", "paused", "sent", "cancelled"]) {
      const { rows } = await pool.query(
        "insert into campaigns (tenant_id, name, content, status) values ($1, $2, $3, $4) returning id",
        [tenantId, `OBRAZY kampania ${status}`, tresc, status],
      );
      const lista = (await obrazyTenanta(tenantId)).find((o) => o.id === w.obraz.id)!;
      expect(lista.blokadaUsuniecia).toContain("Nie można usunąć");
      const wynik = await usunObraz(tenantId, w.obraz.id);
      expect(wynik).toMatchObject({ ok: false, status: 409 });
      expect(existsSync(sciezkaObrazu(tenantId, w.obraz.id, "png"))).toBe(true);
      await pool.query("delete from campaigns where id = $1", [rows[0].id]);
    }
    const { rows: j } = await pool.query(
      "insert into journeys (tenant_id, name, subject, content) values ($1, 'OBRAZY powitanie', 'Temat', $2) returning id",
      [tenantId, tresc],
    );
    expect(await usunObraz(tenantId, w.obraz.id)).toMatchObject({ ok: false, status: 409 });
    await pool.query("delete from journeys where id = $1", [j[0].id]);
    expect((await pool.query("select 1 from images where id = $1", [w.obraz.id])).rowCount).toBe(1);
  });

  it("usunięcie obrazu tylko ze szkicu: wolno, plik znika, trasa daje 404, lista kontrolna widzi brak", async () => {
    const w = await wgrajObraz(tenantId, { bajty: PNG_1x1, nazwa: "szkic.png", autor: null, kiedy: teraz });
    if (!w.ok) throw new Error(w.blad);
    const html = `<p>x</p><img src="${w.obraz.url}">`;
    await pool.query(
      "insert into campaigns (tenant_id, name, content, status) values ($1, 'OBRAZY szkic', $2, 'draft')",
      [tenantId, JSON.stringify({ html })],
    );
    expect(tokenyObrazowWHtml(html)).toHaveLength(1);
    const wynik = await usunObraz(tenantId, w.obraz.id);
    expect(wynik).toEqual({ ok: true, szkice: 1 });
    expect((await pool.query("select 1 from images where id = $1", [w.obraz.id])).rowCount).toBe(0);
    expect(existsSync(sciezkaObrazu(tenantId, w.obraz.id, "png"))).toBe(false);
    expect(await plikPoTokenie(w.obraz.sciezka.slice(3, 46), "png")).toBeNull();
    expect(await brakujaceObrazy(tenantId, html)).toBe(1);
  });
});
