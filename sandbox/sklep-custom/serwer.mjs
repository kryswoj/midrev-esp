// Strona testowa „własny sklep” do E2E integracji custom (0044). Serwuje produkt.html
// z podstawionym adresem skryptu: MIDREV_SRC=http://localhost:3073/js/v1/AbC123.js
// node sandbox/sklep-custom/serwer.mjs 3074
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 3074);
const src = process.env.MIDREV_SRC ?? "";
const katalog = import.meta.dirname;
createServer((req, res) => {
  const sciezka = new URL(req.url, `http://localhost:${port}`).pathname;
  const plik = sciezka === "/" || sciezka === "/produkt.html" ? "produkt.html" : null;
  if (!plik) {
    res.writeHead(404).end("nie ma");
    return;
  }
  const html = readFileSync(join(katalog, plik), "utf8").replaceAll("__MIDREV_SRC__", src).replaceAll("__ORIGIN__", `http://localhost:${port}`);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
}).listen(port, "127.0.0.1", () => console.log(`sklep testowy: http://localhost:${port}/produkt.html`));
