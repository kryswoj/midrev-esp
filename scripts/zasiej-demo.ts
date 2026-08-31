// Skrypt demonstracyjny: zaklada tenanta, podpina sandbox Woo i importuje historie.
// Nie jest czescia produktu - sluzy do pokazania dzialajacego przekroju na zywych danych.
import { readFileSync } from "node:fs";
import { listaTenantow, utworzTenanta } from "../src/adapters/db/repozytoria";
import { podlaczSklepWoo } from "../src/usecases/podlacz-sklep";
import { wykonajImport } from "../src/usecases/importuj-historie";
import { closePool } from "../src/adapters/db/pool";

const poswiadczenia = Object.fromEntries(
  readFileSync("sandbox/woo/.woo-credentials", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const nazwa = process.argv[2] ?? "Sklep Testowy MidRev";
const istniejacy = (await listaTenantow()).find((t) => t.name === nazwa);
const tenant = istniejacy ?? (await utworzTenanta(nazwa));
console.log(`tenant: ${tenant.name} (${tenant.id})`);

const podlaczenie = await podlaczSklepWoo(tenant.id, {
  baseUrl: poswiadczenia.WOO_URL,
  consumerKey: poswiadczenia.WOO_CONSUMER_KEY,
  consumerSecret: poswiadczenia.WOO_CONSUMER_SECRET,
});
console.log("podlaczenie:", podlaczenie);
if (!podlaczenie.ok) process.exit(1);

const wynik = await wykonajImport(tenant.id, podlaczenie.storeId);
console.log("import:", wynik);
console.log(`panel: http://localhost:3005/t/${tenant.id}`);
await closePool();
