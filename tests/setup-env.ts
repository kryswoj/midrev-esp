import { adresBazyTestowej, odczytajPlikEnv, wymagajBazyTestowej } from "./baza-testowa";

// Flagi funkcji z .env deweloperskiego nie moga zmieniac wyniku testow: testy, ktore ich
// potrzebuja, ustawiaja je same. Tak samo flagi wyeksportowane w powloce.
const FLAGI_FUNKCJI = ["MIDREV_GRAF_V2", "MIDREV_PONOWNE_WEJSCIE", "SES_ZDARZENIA_SNS", "SES_TENANTS"];

// Uruchamiany przed KAZDYM plikiem testow (setupFiles), zanim test dotknie config().
for (const flaga of FLAGI_FUNKCJI) delete process.env[flaga];
for (const [klucz, wartosc] of odczytajPlikEnv()) {
  if (FLAGI_FUNKCJI.includes(klucz)) continue;
  if (!(klucz in process.env)) process.env[klucz] = wartosc;
}

// Testy chodza WYLACZNIE na bazie testowej. DATABASE_URL z .env to baza deweloperska
// (serwer :3005 + worker), wiec nadpisujemy ja bezwarunkowo - takze wtedy, gdy ktos
// wyeksportowal DATABASE_URL w powloce.
process.env.DATABASE_URL = adresBazyTestowej();
// Testy to sandbox z definicji (Mailpit, klucz z zer, http). Guardy produkcyjne sprawdza
// osobny test na czystej funkcji zbudujKonfiguracje, nie globalny stan procesu.
process.env.MIDREV_SANDBOX = "1";
wymagajBazyTestowej(process.env.DATABASE_URL, "setup-env");
