/**
 * Operator: podpięcie zdarzeń SES (odbicia, skargi, doręczenia) przez SNS.
 *
 *   npm run ses:zdarzenia                 # plan (nic nie zmienia)
 *   npm run ses:zdarzenia -- --wykonaj    # wykonanie (ZGODA Krystiana: zmiana w AWS)
 *
 * Wymaga: AWS_SES_ACCESS_KEY_ID/SECRET użytkownika aplikacji (polityka IAM z
 * 07-prosta-domena.md, z uprawnieniami SNS), AWS_ACCOUNT_ID, APP_URL (https).
 * Po wykonaniu: dopisz wypisany ARN do SES_SNS_TOPIC_ARN, ustaw SES_ZDARZENIA_SNS=1
 * i zrestartuj aplikację — potwierdzenie subskrypcji przyjdzie na /api/webhooks/ses.
 * Klucze nigdy nie są wypisywane.
 */
import { portSes, portSns } from "../src/adapters/aws/fabryka";
import { getPool } from "../src/adapters/db/pool";
import { config } from "../src/config";
import { skonfigurujZdarzeniaSes } from "../src/usecases/wysylka-konfiguracja/zdarzenia-ses-konfiguracja";

const wykonaj = process.argv.includes("--wykonaj");
const k = config();
const ses = portSes();
const sns = portSns();
if (!ses || !sns) {
  console.error("Brak AWS_SES_ACCESS_KEY_ID/AWS_SES_SECRET_ACCESS_KEY — nie ma czym rozmawiać z AWS.");
  process.exit(1);
}
if (!k.AWS_ACCOUNT_ID) {
  console.error("Brak AWS_ACCOUNT_ID (12 cyfr) — potrzebny do polityki tematu.");
  process.exit(1);
}
const wynik = await skonfigurujZdarzeniaSes({ ses, sns, konto: k.AWS_ACCOUNT_ID, endpoint: `${k.APP_URL}/api/webhooks/ses`, wykonaj });
for (const krok of wynik.kroki) console.log(`${krok.stan.padEnd(15)} ${krok.krok.padEnd(40)} ${krok.opis}`);
console.log(wykonaj ? `\nTemat: ${wynik.topicArn ?? "-"}` : "\nTo był plan. Wykonanie: --wykonaj (po zgodzie).");
await getPool().end();
process.exit(wynik.kroki.some((x) => x.stan === "brak_uprawnien" || x.stan === "blad") ? 2 : 0);
