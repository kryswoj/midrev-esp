import { adresBazyTestowej, odczytajPlikEnv, wymagajBazyTestowej } from "./baza-testowa";

// Uruchamiany przed KAZDYM plikiem testow (setupFiles), zanim test dotknie config().
for (const [klucz, wartosc] of odczytajPlikEnv()) {
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
