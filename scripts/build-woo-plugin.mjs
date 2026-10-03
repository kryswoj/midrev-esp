#!/usr/bin/env node
// Paczka wtyczki „MidRev ESP for WooCommerce” (plan integracji B.4, decyzja D2: zip od nas).
//
//   npm run build:woo-plugin
//
// Wynik:
//   dist/woo/midrev-esp-<wersja>.zip            (wersjonowana kopia do archiwum / wydania)
//   public/integracja/midrev-esp-woocommerce.zip (to, co pobiera operator z kreatora w panelu)
//
// Zero zależności: zip (deflate) i .mo (gettext) składane tutaj. Zip deterministyczny (stała data
// plików, posortowane ścieżki), więc ta sama wersja daje bajt w bajt ten sam plik. Katalog w zipie
// = `midrev-esp/` (WordPress instaluje wtyczkę do wp-content/plugins/midrev-esp).
import { deflateRawSync, crc32 } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const ZRODLO = join(ROOT, "integrations", "woocommerce", "midrev-esp");
const KATALOG_W_ZIPIE = "midrev-esp";

const plikGlowny = readFileSync(join(ZRODLO, "midrev-esp.php"), "utf8");
const wersja = /^\s*\*\s*Version:\s*([0-9][0-9A-Za-z.+-]*)\s*$/m.exec(plikGlowny)?.[1];
const stala = /define\(\s*'MIDREV_ESP_VERSION',\s*'([^']+)'\s*\)/.exec(plikGlowny)?.[1];
if (!wersja || wersja !== stala) {
  console.error(`Wersja w nagłówku (${wersja}) i w MIDREV_ESP_VERSION (${stala}) muszą być równe.`);
  process.exit(1);
}
const readme = readFileSync(join(ZRODLO, "readme.txt"), "utf8");
const stabilna = /^Stable tag:\s*(\S+)/m.exec(readme)?.[1];
if (stabilna !== wersja) {
  console.error(`Stable tag w readme.txt (${stabilna}) różni się od wersji wtyczki (${wersja}).`);
  process.exit(1);
}

// ── .po → .mo (format GNU gettext, little endian) ───────────────────────────────
function parsujPo(tekst) {
  const wpisy = new Map();
  let id = null;
  let str = null;
  let pole = null;
  const odkoduj = (s) => JSON.parse(s);
  const zapisz = () => {
    if (id !== null && str !== null) wpisy.set(id, str);
    id = null;
    str = null;
  };
  for (const linia of tekst.split(/\r?\n/)) {
    if (linia.startsWith("msgid ")) {
      zapisz();
      id = odkoduj(linia.slice(6));
      pole = "id";
    } else if (linia.startsWith("msgstr ")) {
      str = odkoduj(linia.slice(7));
      pole = "str";
    } else if (linia.startsWith('"')) {
      if (pole === "id") id += odkoduj(linia);
      else if (pole === "str") str += odkoduj(linia);
    } else if (!linia.trim()) {
      zapisz();
      pole = null;
    }
  }
  zapisz();
  return wpisy;
}

function zbudujMo(wpisy) {
  const klucze = [...wpisy.keys()].sort();
  const id = klucze.map((k) => Buffer.from(k, "utf8"));
  const tr = klucze.map((k) => Buffer.from(wpisy.get(k), "utf8"));
  const n = klucze.length;
  const naglowek = 28;
  const tabId = naglowek;
  const tabTr = tabId + n * 8;
  let offset = tabTr + n * 8;
  const opisId = [];
  const opisTr = [];
  for (const b of id) {
    opisId.push([b.length, offset]);
    offset += b.length + 1;
  }
  for (const b of tr) {
    opisTr.push([b.length, offset]);
    offset += b.length + 1;
  }
  const out = Buffer.alloc(offset);
  out.writeUInt32LE(0x950412de, 0);
  out.writeUInt32LE(0, 4);
  out.writeUInt32LE(n, 8);
  out.writeUInt32LE(tabId, 12);
  out.writeUInt32LE(tabTr, 16);
  out.writeUInt32LE(0, 20);
  out.writeUInt32LE(0, 24);
  opisId.forEach(([dl, off], i) => {
    out.writeUInt32LE(dl, tabId + i * 8);
    out.writeUInt32LE(off, tabId + i * 8 + 4);
    id[i].copy(out, off);
  });
  opisTr.forEach(([dl, off], i) => {
    out.writeUInt32LE(dl, tabTr + i * 8);
    out.writeUInt32LE(off, tabTr + i * 8 + 4);
    tr[i].copy(out, off);
  });
  return out;
}

// ── Zip (deflate, bez zależności) ───────────────────────────────────────────────
const DOS_CZAS = 0; // 00:00:00
const DOS_DATA = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01, stała: zip deterministyczny

function zbudujZip(pliki) {
  const lokalne = [];
  const centralne = [];
  let offset = 0;
  for (const { nazwa, dane } of pliki) {
    const n = Buffer.from(nazwa, "utf8");
    const skompresowane = deflateRawSync(dane, { level: 9 });
    const crc = crc32(dane) >>> 0;
    const lok = Buffer.alloc(30);
    lok.writeUInt32LE(0x04034b50, 0);
    lok.writeUInt16LE(20, 4);
    lok.writeUInt16LE(0x0800, 6); // UTF-8 w nazwach
    lok.writeUInt16LE(8, 8);
    lok.writeUInt16LE(DOS_CZAS, 10);
    lok.writeUInt16LE(DOS_DATA, 12);
    lok.writeUInt32LE(crc, 14);
    lok.writeUInt32LE(skompresowane.length, 18);
    lok.writeUInt32LE(dane.length, 22);
    lok.writeUInt16LE(n.length, 26);
    lok.writeUInt16LE(0, 28);
    lokalne.push(lok, n, skompresowane);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x031e, 4); // Unix, zip 3.0
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(DOS_CZAS, 12);
    cen.writeUInt16LE(DOS_DATA, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(skompresowane.length, 20);
    cen.writeUInt32LE(dane.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    centralne.push(cen, n);
    offset += 30 + n.length + skompresowane.length;
  }
  const cd = Buffer.concat(centralne);
  const koniec = Buffer.alloc(22);
  koniec.writeUInt32LE(0x06054b50, 0);
  koniec.writeUInt16LE(pliki.length, 8);
  koniec.writeUInt16LE(pliki.length, 10);
  koniec.writeUInt32LE(cd.length, 12);
  koniec.writeUInt32LE(offset, 16);
  return Buffer.concat([...lokalne, cd, koniec]);
}

function wszystkiePliki(katalog) {
  const wynik = [];
  for (const wpis of readdirSync(katalog).sort()) {
    const sciezka = join(katalog, wpis);
    if (statSync(sciezka).isDirectory()) wynik.push(...wszystkiePliki(sciezka));
    else wynik.push(sciezka);
  }
  return wynik;
}

const pliki = [];
for (const sciezka of wszystkiePliki(ZRODLO)) {
  const wzgl = relative(ZRODLO, sciezka).split("\\").join("/");
  if (wzgl.startsWith(".") || wzgl.endsWith(".mo")) continue;
  pliki.push({ nazwa: `${KATALOG_W_ZIPIE}/${wzgl}`, dane: readFileSync(sciezka) });
  if (wzgl.endsWith(".po")) {
    const mo = zbudujMo(parsujPo(readFileSync(sciezka, "utf8")));
    pliki.push({ nazwa: `${KATALOG_W_ZIPIE}/${wzgl.replace(/\.po$/, ".mo")}`, dane: mo });
  }
}
pliki.sort((a, b) => a.nazwa.localeCompare(b.nazwa));
const zip = zbudujZip(pliki);

const dist = join(ROOT, "dist", "woo");
mkdirSync(dist, { recursive: true });
const wersjonowany = join(dist, `midrev-esp-${wersja}.zip`);
writeFileSync(wersjonowany, zip);
const pub = join(ROOT, "public", "integracja");
mkdirSync(pub, { recursive: true });
writeFileSync(join(pub, "midrev-esp-woocommerce.zip"), zip);
writeFileSync(join(pub, "midrev-esp-woocommerce.json"), JSON.stringify({ wersja, pliki: pliki.length, bajtow: zip.length }) + "\n");
console.log(`midrev-esp ${wersja}: ${pliki.length} plików, ${zip.length} B -> ${relative(ROOT, wersjonowany)}, public/integracja/midrev-esp-woocommerce.zip`);
