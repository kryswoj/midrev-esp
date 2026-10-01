import { NextResponse, type NextRequest } from "next/server";
import { parsujWiadomoscSns, zweryfikujWiadomoscSns } from "../../../../adapters/aws/podpis-sns";
import { config } from "../../../../config";
import { przetworzWiadomoscSns } from "../../../../usecases/wysylka/zdarzenia-ses";
import { przeczytajOgraniczone } from "../../przeczytaj-ograniczone";

/**
 * Zdarzenia SES (odbicia, skargi, doręczenia) przez SNS → HTTPS.
 *
 * Publiczna (bez sesji) pod prefiksem `/api/webhooks` (trasy-publiczne.ts), na hoście
 * panelu esp.midrev.pl, który Caddy przepuszcza w całości — zmiana Caddyfile nie jest
 * potrzebna. Ochrona: podpis SNS (certyfikat tylko z sns.<region>.amazonaws.com),
 * allowlista tematu, idempotencja po MessageId (zdarzenia-ses.ts).
 *
 * Odpowiedzi: 200 = przyjęte albo świadomie odłożone (SNS nie ponawia), 403 = zły podpis
 * albo obcy temat, 400 = to nie jest wiadomość SNS, 500 = nasza awaria (SNS ponowi).
 * Treść zdarzenia NIE trafia do logów (adresy odbiorców).
 */

// wiadomość SNS ma do 256 KB treści + koperta JSON z podpisem
const MAKS_CIALO_B = 300_000;

export async function POST(zadanie: NextRequest) {
  const cialo = await przeczytajOgraniczone(zadanie, MAKS_CIALO_B);
  if (cialo === null) return new NextResponse("za duże ciało", { status: 413 });
  let surowa: unknown;
  try {
    surowa = JSON.parse(cialo);
  } catch {
    return new NextResponse("to nie jest wiadomość SNS", { status: 400 });
  }
  const w = parsujWiadomoscSns(surowa);
  if (!w) return new NextResponse("to nie jest wiadomość SNS", { status: 400 });
  const naglowek = zadanie.headers.get("x-amz-sns-message-type");
  if (naglowek && naglowek !== w.Type) return new NextResponse("niezgodny typ wiadomości", { status: 400 });

  const podpis = await zweryfikujWiadomoscSns(w, { region: config().AWS_REGION });
  if (!podpis.ok) {
    console.warn(`[ses-zdarzenia] odrzucono wiadomość ${w.MessageId.slice(0, 80)}: ${podpis.powod}`);
    return new NextResponse("zły podpis", { status: 403 });
  }
  try {
    const wynik = await przetworzWiadomoscSns(w);
    return new NextResponse(wynik.wynik, { status: wynik.status });
  } catch (blad) {
    console.error(`[ses-zdarzenia] błąd przetwarzania ${w.MessageId.slice(0, 80)}: ${String((blad as Error)?.message ?? blad).slice(0, 200)}`);
    return new NextResponse("błąd, spróbuj ponownie", { status: 500 });
  }
}
