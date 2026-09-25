import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { config } from "../src/config";
import { GET as pixelGET } from "../src/app/api/o/[token]/route";
import { GET as redirectGET } from "../src/app/r/[token]/route";
import { adresPixela, tokenOtwarcia, zlozWiadomosc } from "../src/usecases/wysylka/renderuj";
import { metrykiZaangazowania } from "../src/usecases/wysylka/zaangazowanie";

/**
 * Wykonywalna specyfikacja DWÓCH tras publicznych bloku A: redirectu kliknięć i pixela
 * otwarć. Baza jest prawdziwa (AD-20), trasy są wołane tak, jak zawoła je klient pocztowy.
 *
 * Trzy rzeczy, których ten plik pilnuje najmocniej, bo każda z nich kosztowała już
 * kiedyś realny błąd:
 *   1. do `clicks`, czyli do ATRYBUCJI PRZYCHODU, wchodzi wyłącznie ruch ludzki,
 *   2. odbiorca dostaje przekierowanie i obrazek NIEZALEŻNIE od tego, co się stało
 *      z zapisem,
 *   3. weryfikacja czyta ZAPISANY REKORD z bazy, a nie to, co wysłaliśmy do funkcji.
 */

const CEL = "https://sklep.example.test/oferta?wariant=a";
const UA_CZLOWIEK =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const UA_SKANER =
  "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1) SafeLinks/1.0 (Microsoft Defender)";
const UA_PROXY = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

function zadanieKlikniecia(
  token: string,
  opcje: { l?: string; ua?: string; ip?: string; realIp?: string } = {},
) {
  const naglowki = new Headers();
  if (opcje.ua) naglowki.set("user-agent", opcje.ua);
  if (opcje.ip !== undefined) naglowki.set("x-forwarded-for", opcje.ip);
  if (opcje.realIp) naglowki.set("x-real-ip", opcje.realIp);
  const url = `${config().APP_URL}/r/${token}?l=${opcje.l ?? "0"}`;
  return redirectGET(new NextRequest(url, { headers: naglowki }), {
    params: Promise.resolve({ token }),
  });
}

function zadaniePixela(token: string, opcje: { ua?: string; ip?: string } = {}) {
  const naglowki = new Headers();
  if (opcje.ua) naglowki.set("user-agent", opcje.ua);
  if (opcje.ip) naglowki.set("x-forwarded-for", opcje.ip);
  const url = `${config().APP_URL}/api/o/${token}`;
  return pixelGET(new NextRequest(url, { headers: naglowki }), {
    params: Promise.resolve({ token }),
  });
}

interface WierszZdarzenia {
  kind: string;
  source: string;
  automat: boolean | null;
  automat_powod: string | null;
  url: string | null;
  ip: string | null;
  user_agent: string | null;
  occurred_at: Date;
  tenant_id: string;
  source_type: string;
  source_id: string;
}

async function zdarzenia(messageId: string): Promise<WierszZdarzenia[]> {
  const { rows } = await getPool().query(
    `select kind, source, automat, automat_powod, url, host(ip) as ip, user_agent,
            occurred_at, tenant_id, source_type, source_id
       from message_engagement where message_id = $1 order by recorded_at`,
    [messageId],
  );
  return rows;
}

async function ileKlikow(messageId: string): Promise<number> {
  const { rows } = await getPool().query("select count(*)::int as ile from clicks where message_id = $1", [
    messageId,
  ]);
  return rows[0].ile;
}

describe("Pixel otwarć i redirect kliknięć (Blok A w sieci)", () => {
  let tenantId: string;
  let obcyTenantId: string;
  let kampaniaId: string;
  /** osobna kampania na test metryk, żeby liczby nie zależały od kolejności testów */
  let kampaniaMetrykId: string;
  let licznik = 0;

  const pool = () => getPool();

  /** Wiadomość zbudowana PRAWDZIWYM rendererem, żeby test sprawdzał to, co realnie wyjdzie. */
  async function utworzWiadomosc(opcje: {
    tenant?: string;
    profil?: string;
    kampania?: string;
    otwarcia?: boolean;
    klikniecia?: boolean;
  } = {}) {
    const tenant = opcje.tenant ?? tenantId;
    const kampania = opcje.kampania ?? kampaniaId;
    const otwarcia = opcje.otwarcia ?? true;
    const klikniecia = opcje.klikniecia ?? true;
    const clickToken = `zaweb-klik-${++licznik}`;
    // własny profil na wiadomość: messages ma unique (tenant, source_type, source_id,
    // profile_id), więc dwie wiadomości tej samej kampanii to dwoje różnych odbiorców
    const profil =
      opcje.profil ??
      (
        await pool().query(
          "insert into profiles (tenant_id, email) values ($1, $2) returning id",
          [tenant, `zaweb-odbiorca-${licznik}@example.test`],
        )
      ).rows[0].id;
    const { html, linki } = zlozWiadomosc({
      trescHtml: `<p><a href="${CEL}">Oferta</a></p>`,
      clickToken,
      unsubscribeToken: `zaweb-unsub-${licznik}`,
      nazwaSklepu: "ZAWEB sklep",
      sledzKlikniecia: klikniecia,
      sledzOtwarcia: otwarcia,
    });
    const { rows } = await pool().query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                             body_html, click_token, unsubscribe_token, links,
                             open_tracking_allowed, click_tracking_allowed)
       values ($1, $2, 'campaign', $3, $4, 'ZAWEB temat', $5, $6, $7, $8, $9, $10)
       returning id, click_token, open_token`,
      [
        tenant,
        profil,
        kampania,
        `zaweb-${licznik}@example.test`,
        html,
        clickToken,
        `zaweb-unsub-${licznik}`,
        JSON.stringify(linki),
        otwarcia,
        klikniecia,
      ],
    );
    return { ...rows[0], html, linki } as {
      id: string;
      click_token: string;
      open_token: string;
      html: string;
      linki: string[];
    };
  }

  beforeAll(async () => {
    await pool().query("delete from tenants where name like 'ZAWEB %'");
    const t = await pool().query("insert into tenants (name) values ('ZAWEB tenant') returning id");
    tenantId = t.rows[0].id;
    const o = await pool().query("insert into tenants (name) values ('ZAWEB obcy') returning id");
    obcyTenantId = o.rows[0].id;

    const k = await pool().query("select gen_random_uuid() as a, gen_random_uuid() as b");
    kampaniaId = k.rows[0].a;
    kampaniaMetrykId = k.rows[0].b;
  });

  afterAll(async () => {
    await pool().query("delete from tenants where name like 'ZAWEB %'");
    await closePool();
  });

  // --- token pixela ---------------------------------------------------------

  it("token pixela w treści maila zgadza się z kolumną generowaną w BAZIE", async () => {
    const w = await utworzWiadomosc();
    // parytet liczony wobec zapisanego rekordu, nie wobec drugiego wywołania tej
    // samej funkcji w JS — inaczej test przechodziłby przy rozjeździe z bazą
    expect(w.open_token).toBe(tokenOtwarcia(w.click_token));
    expect(w.html).toContain(`${config().APP_URL}/api/o/${w.open_token}.gif`);
    expect(adresPixela(w.click_token)).toContain(w.open_token);
  });

  it("z adresu pixela nie da się złożyć adresu kliknięcia i odwrotnie", async () => {
    const w = await utworzWiadomosc();
    // token kliknięć podstawiony pod pixel: nic nie zapisujemy
    const jakoPixel = await zadaniePixela(w.click_token, { ua: UA_CZLOWIEK });
    expect(jakoPixel.status).toBe(200);
    // token otwarć podstawiony pod redirect: przekierowanie zastępcze, zero zapisów
    const jakoKlik = await zadanieKlikniecia(w.open_token, { ua: UA_CZLOWIEK });
    expect(jakoKlik.headers.get("location")).toContain(config().APP_URL);
    expect(await zdarzenia(w.id)).toHaveLength(0);
    expect(await ileKlikow(w.id)).toBe(0);
  });

  // --- kliknięcia -----------------------------------------------------------

  it("kliknięcie człowieka: przekierowanie na cel ze snapshotu, zdarzenie i wpis do atrybucji", async () => {
    const w = await utworzWiadomosc();
    const przed = Date.now();
    const odp = await zadanieKlikniecia(w.click_token, { ua: UA_CZLOWIEK, ip: "203.0.113.9" });

    expect(odp.status).toBe(302);
    expect(odp.headers.get("location")).toBe(CEL);

    const [zdarzenie] = await zdarzenia(w.id);
    expect(zdarzenie.kind).toBe("click");
    expect(zdarzenie.source).toBe("wlasne");
    expect(zdarzenie.automat).toBe(false);
    expect(zdarzenie.automat_powod).toBe("brak_przeslanek");
    expect(zdarzenie.url).toBe(CEL);
    expect(zdarzenie.ip).toBe("203.0.113.9");
    expect(zdarzenie.source_type).toBe("campaign");
    expect(zdarzenie.source_id).toBe(kampaniaId);
    // data ZE ŹRÓDŁA, czyli z chwili żądania — nie z chwili zapisu w bazie
    const kiedy = new Date(zdarzenie.occurred_at).getTime();
    expect(kiedy).toBeGreaterThanOrEqual(przed - 1000);
    expect(kiedy).toBeLessThanOrEqual(Date.now());

    expect(await ileKlikow(w.id)).toBe(1);
  });

  it("kliknięcie skanera bezpieczeństwa: ten sam redirect, ale POZA atrybucją przychodu", async () => {
    const w = await utworzWiadomosc();
    const odp = await zadanieKlikniecia(w.click_token, { ua: UA_SKANER });

    // odbiorca (a raczej maszyna) dostaje dokładnie to samo co człowiek
    expect(odp.status).toBe(302);
    expect(odp.headers.get("location")).toBe(CEL);

    const [zdarzenie] = await zdarzenia(w.id);
    expect(zdarzenie.automat).toBe(true);
    expect(zdarzenie.automat_powod).toBe("skaner_bezpieczenstwa");
    // TU JEST CAŁA RZECZ: klik bota nie dokłada się do pieniędzy
    expect(await ileKlikow(w.id)).toBe(0);
  });

  it("nieznany token i zły indeks linku: przekierowanie zastępcze bez żadnego zapisu", async () => {
    const nieznany = await zadanieKlikniecia("zaweb-nie-ma-takiego", { ua: UA_CZLOWIEK });
    expect(nieznany.headers.get("location")).toContain(config().APP_URL);

    const w = await utworzWiadomosc();
    const zlyIndeks = await zadanieKlikniecia(w.click_token, { l: "7", ua: UA_CZLOWIEK });
    expect(zlyIndeks.headers.get("location")).toContain(config().APP_URL);
    const nieliczba = await zadanieKlikniecia(w.click_token, { l: "abc", ua: UA_CZLOWIEK });
    expect(nieliczba.headers.get("location")).toContain(config().APP_URL);

    expect(await zdarzenia(w.id)).toHaveLength(0);
    expect(await ileKlikow(w.id)).toBe(0);
  });

  it("wycofana zgoda na śledzenie kliknięć: odbiorca trafia do sklepu, zdarzenie nie powstaje", async () => {
    // linki w takim mailu zostają oryginalne, ale stary link z poprzedniej wysyłki
    // albo przekazany dalej mail nadal potrafi trafić w /r — bramka ma trzymać
    const w = await utworzWiadomosc({ klikniecia: false });
    await pool().query("update messages set links = $2 where id = $1", [
      w.id,
      JSON.stringify([CEL]),
    ]);

    const odp = await zadanieKlikniecia(w.click_token, { ua: UA_CZLOWIEK });
    expect(odp.status).toBe(302);
    expect(odp.headers.get("location")).toBe(CEL);
    expect(await zdarzenia(w.id)).toHaveLength(0);
    expect(await ileKlikow(w.id)).toBe(0);
  });

  it("podrzucony nagłówek x-forwarded-for nie wywraca zapisu, lista adresów daje pierwszy", async () => {
    const smiec = await utworzWiadomosc();
    await zadanieKlikniecia(smiec.click_token, { ua: UA_CZLOWIEK, ip: "to-nie-jest-ip" });
    const [zeSmieciem] = await zdarzenia(smiec.id);
    // zdarzenie ZOSTAJE, tylko bez adresu: kolumna jest typu inet i śmieć wywróciłby
    // całą transakcję, czyli jeden dziwny nagłówek kasowałby prawdziwe kliknięcie
    expect(zeSmieciem.automat).toBe(false);
    expect(zeSmieciem.ip).toBeNull();

    const lista = await utworzWiadomosc();
    await zadanieKlikniecia(lista.click_token, {
      ua: UA_CZLOWIEK,
      ip: "198.51.100.7, 70.41.3.18, 150.172.238.178",
    });
    const [zListy] = await zdarzenia(lista.id);
    expect(zListy.ip).toBe("198.51.100.7");

    // pusty albo popsuty x-forwarded-for: schodzimy na x-real-ip, ale NIGDY na kolejny
    // wpis z listy forwardów — tam stoi już pośrednik, nie odbiorca
    const zapasowy = await utworzWiadomosc();
    await zadanieKlikniecia(zapasowy.click_token, {
      ua: UA_CZLOWIEK,
      ip: "",
      realIp: "192.0.2.44",
    });
    const [zZapasowego] = await zdarzenia(zapasowy.id);
    expect(zZapasowego.ip).toBe("192.0.2.44");
  });

  // --- otwarcia -------------------------------------------------------------

  it("otwarcie człowieka: przezroczysty 1x1, nagłówki bez cache'owania, zdarzenie w bazie", async () => {
    const w = await utworzWiadomosc();
    const przed = Date.now();
    const odp = await zadaniePixela(`${w.open_token}.gif`, { ua: UA_CZLOWIEK, ip: "203.0.113.9" });

    expect(odp.status).toBe(200);
    expect(odp.headers.get("content-type")).toBe("image/gif");
    const cache = odp.headers.get("cache-control") ?? "";
    expect(cache).toContain("no-store");
    expect(cache).toContain("no-cache");
    expect(odp.headers.get("pragma")).toBe("no-cache");
    const bajty = new Uint8Array(await odp.arrayBuffer());
    expect(bajty.byteLength).toBe(42);
    // realny GIF, nie pusta odpowiedź z nagłówkiem obrazka
    expect(String.fromCharCode(...bajty.slice(0, 6))).toBe("GIF89a");

    const [zdarzenie] = await zdarzenia(w.id);
    expect(zdarzenie.kind).toBe("open");
    expect(zdarzenie.source).toBe("wlasne");
    expect(zdarzenie.automat).toBe(false);
    expect(zdarzenie.url).toBeNull();
    const kiedy = new Date(zdarzenie.occurred_at).getTime();
    expect(kiedy).toBeGreaterThanOrEqual(przed - 1000);
    expect(kiedy).toBeLessThanOrEqual(Date.now());
  });

  it("dwa otwarcia tej samej wiadomości to dwa zdarzenia, nie jedno", async () => {
    const w = await utworzWiadomosc();
    await zadaniePixela(w.open_token, { ua: UA_CZLOWIEK });
    await zadaniePixela(w.open_token, { ua: UA_CZLOWIEK });
    // gdyby zaangażowanie trafiało do message_events (unique message_id + event_type),
    // drugie otwarcie zniknęłoby po cichu — o to chodzi w osobnej tabeli z 0014
    expect(await zdarzenia(w.id)).toHaveLength(2);
  });

  it("Apple MPP i proxy obrazków: otwarcie ZAPISANE, ale oznaczone jako maszynowe", async () => {
    const apple = await utworzWiadomosc();
    await zadaniePixela(apple.open_token, { ua: UA_CZLOWIEK, ip: "17.58.63.12" });
    const [zApple] = await zdarzenia(apple.id);
    expect(zApple.automat).toBe(true);
    expect(zApple.automat_powod).toBe("apple_mpp");

    const proxy = await utworzWiadomosc();
    await zadaniePixela(proxy.open_token, { ua: UA_PROXY, ip: "66.249.84.1" });
    const [zProxy] = await zdarzenia(proxy.id);
    expect(zProxy.automat).toBe(true);
    expect(zProxy.automat_powod).toBe("proxy_obrazkow");
  });

  it("brak zgody na śledzenie otwarć: pixela nie ma w mailu, a trasa i tak nic nie zapisze", async () => {
    const w = await utworzWiadomosc({ otwarcia: false });
    expect(w.html).not.toContain("/api/o/");

    // ktoś zna adres mimo wszystko (stara wysyłka, przekazany mail): bramka trzyma
    const odp = await zadaniePixela(w.open_token, { ua: UA_CZLOWIEK });
    expect(odp.status).toBe(200);
    expect(odp.headers.get("content-type")).toBe("image/gif");
    expect(await zdarzenia(w.id)).toHaveLength(0);
  });

  it("nieznany token pixela odpowiada tak samo jak znany — trasa nie jest wyrocznią", async () => {
    const odp = await zadaniePixela("zaweb-nie-ma-takiego-tokena.gif", { ua: UA_CZLOWIEK });
    expect(odp.status).toBe(200);
    expect(odp.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await odp.arrayBuffer()).byteLength).toBe(42);
  });

  // --- izolacja tenantów ----------------------------------------------------

  it("zdarzenie z publicznej trasy ląduje u TENANTA WIADOMOŚCI, nie u kogokolwiek innego", async () => {
    const obca = await utworzWiadomosc({ tenant: obcyTenantId, kampania: kampaniaId });
    await zadaniePixela(obca.open_token, { ua: UA_CZLOWIEK });
    const [zdarzenie] = await zdarzenia(obca.id);
    expect(zdarzenie.tenant_id).toBe(obcyTenantId);

    // ta sama kampania (to samo source_id) u naszego tenanta NIE widzi tamtego otwarcia
    const nasze = await metrykiZaangazowania(tenantId, "campaign", kampaniaId);
    const obce = await metrykiZaangazowania(obcyTenantId, "campaign", kampaniaId);
    expect(obce.otwarcia).toBe(1);
    expect(nasze.otwarcia).toBeGreaterThan(0);
    // liczby są rozłączne: otwarcie obcego tenanta nie doliczyło się do naszych
    const { rows } = await getPool().query(
      `select count(*)::int as ile from message_engagement
        where tenant_id = $1 and message_id = $2`,
      [tenantId, obca.id],
    );
    expect(rows[0].ile).toBe(0);
  });

  // --- to, co zobaczy człowiek w raporcie -----------------------------------

  it("metryki rozdzielają ruch ludzki od maszynowego, a atrybucja widzi tylko ludzki", async () => {
    const czlowiek = await utworzWiadomosc({ kampania: kampaniaMetrykId });
    const maszyna = await utworzWiadomosc({ kampania: kampaniaMetrykId });

    await zadaniePixela(czlowiek.open_token, { ua: UA_CZLOWIEK });
    await zadaniePixela(czlowiek.open_token, { ua: UA_CZLOWIEK }); // ten sam człowiek drugi raz
    await zadaniePixela(maszyna.open_token, { ua: UA_CZLOWIEK, ip: "17.58.63.12" });
    await zadanieKlikniecia(czlowiek.click_token, { ua: UA_CZLOWIEK });
    await zadanieKlikniecia(maszyna.click_token, { ua: UA_SKANER });

    const m = await metrykiZaangazowania(tenantId, "campaign", kampaniaMetrykId);
    expect(m.otwarcia).toBe(3);
    expect(m.otwarciaLudzkie).toBe(2);
    expect(m.otwarciaUnikalne).toBe(1); // dwa pobrania jednego odbiorcy to jeden człowiek
    expect(m.klikniecia).toBe(2);
    expect(m.kliknieciaLudzkie).toBe(1);
    expect(m.kliknieciaUnikalne).toBe(1);

    // liczba w raporcie przychodu bierze się z `clicks`, więc klik skanera jej nie rusza
    expect(await ileKlikow(czlowiek.id)).toBe(1);
    expect(await ileKlikow(maszyna.id)).toBe(0);
  });

  // --- render ---------------------------------------------------------------

  it("render: pixel i przepisywanie linków są NIEZALEŻNE, każde od swojej zgody", async () => {
    const wspolne = {
      trescHtml: `<p><a href="${CEL}">Oferta</a></p>`,
      clickToken: "zaweb-render",
      unsubscribeToken: "zaweb-render-unsub",
      nazwaSklepu: "ZAWEB sklep",
    };
    const obie = zlozWiadomosc({ ...wspolne, sledzKlikniecia: true, sledzOtwarcia: true });
    expect(obie.html).toContain("/api/o/");
    expect(obie.html).toContain("/r/zaweb-render?l=0");

    const tylkoOtwarcia = zlozWiadomosc({ ...wspolne, sledzKlikniecia: false, sledzOtwarcia: true });
    expect(tylkoOtwarcia.html).toContain("/api/o/");
    expect(tylkoOtwarcia.html).toContain(`href="${CEL}"`);
    expect(tylkoOtwarcia.linki).toEqual([]);

    const tylkoKlikniecia = zlozWiadomosc({ ...wspolne, sledzKlikniecia: true, sledzOtwarcia: false });
    expect(tylkoKlikniecia.html).not.toContain("/api/o/");
    expect(tylkoKlikniecia.html).toContain("/r/zaweb-render?l=0");

    const zadne = zlozWiadomosc({ ...wspolne, sledzKlikniecia: false, sledzOtwarcia: false });
    expect(zadne.html).not.toContain("/api/o/");
    expect(zadne.html).not.toContain("/r/zaweb-render");
    // pixel stoi POZA kontenerem treści, na samym końcu ciała
    expect(obie.html).toMatch(/<\/div><img src="[^"]+\/api\/o\/[a-f0-9]{64}\.gif"[^>]*><\/body>/);
  });
});
