import { createHash } from "node:crypto";
import { getPool } from "../../../adapters/db/pool";
import { Alert, Button, Card, CardBody, Field, Icon, Textarea } from "../../ui";
import { zdecydujAkcja } from "./akcje";

export const dynamic = "force-dynamic";

/**
 * Publiczna strona akceptacji kampanii (FR39, FR40). Klient sklepu dostaje link mailem
 * i decyduje BEZ logowania: token jednorazowy, ważny 7 dni, w bazie tylko hash (NFR10).
 * Strona musi działać na telefonie (NFR32), bo tam zostanie otwarta.
 */
export default async function Akceptacja({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ blad?: string }>;
}) {
  const { token } = await params;
  // flaga błędu, nie treść: komunikat renderuje strona, więc URL nie jest
  // kanałem do wstrzyknięcia tekstu
  const { blad } = await searchParams;
  const hash = createHash("sha256").update(token).digest("hex");
  const { rows } = await getPool().query(
    `select a.id, a.decided_at, a.decision, a.expires_at, c.name, c.subject, c.preheader, c.content,
            t.name as sklep
       from campaign_approvals a
       join campaigns c on c.tenant_id = a.tenant_id and c.id = a.campaign_id
       join tenants t on t.id = a.tenant_id
      where a.token_hash = $1`,
    [hash],
  );
  const wiersz = rows[0];

  const oprawa = (tresc: React.ReactNode, waska = false) => (
    <main className="min-h-screen bg-[var(--color-plotno)] px-4 py-6 sm:px-6 sm:py-10">
      <div className={`mx-auto w-full ${waska ? "max-w-[560px]" : "max-w-[920px]"}`}>
        <div className="mb-6 flex items-center gap-2.5 px-1">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--color-akcent)] text-[17px] font-bold text-white shadow-sm">m</span>
          <span className="text-[16px] font-semibold tracking-[-0.018em]">midrev esp</span>
        </div>
        {tresc}
      </div>
    </main>
  );

  if (!wiersz) return oprawa(
    <Card><CardBody className="py-10 sm:p-10"><div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-[var(--color-blad-tlo)] text-[var(--color-blad)]"><Icon name="blad" size={23} /></div><h1>Ten link jest nieprawidłowy</h1><p className="mt-2 text-[var(--color-tekst-2)]">Sprawdź, czy adres został skopiowany w całości, albo poproś agencję o nowy link.</p></CardBody></Card>,
    true,
  );
  if (new Date(wiersz.expires_at) < new Date() && !wiersz.decided_at)
    return oprawa(
      <Card><CardBody className="py-10 sm:p-10"><div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-[var(--color-czeka-tlo)] text-[var(--color-czeka)]"><Icon name="uwaga" size={23} /></div><h1>Ten link wygasł</h1><p className="mt-2 text-[var(--color-tekst-2)]">Link do akceptacji jest ważny 7 dni. Poproś agencję o nowy.</p></CardBody></Card>,
      true,
    );
  if (wiersz.decided_at)
    return oprawa(
      <Card><CardBody className="py-10 sm:p-10"><div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-[var(--color-ok-tlo)] text-[var(--color-ok)]"><Icon name="gotowe" size={23} /></div><h1>{wiersz.decision === "approved" ? "Kampania zaakceptowana" : "Uwagi przekazane"}</h1><p className="mt-2 text-[var(--color-tekst-2)]">Decyzja z <span className="liczba">{new Date(wiersz.decided_at).toLocaleString("pl-PL")}</span> została zapisana. Ten link był jednorazowy.</p></CardBody></Card>,
      true,
    );

  const html = String((wiersz.content as any)?.html ?? "<p>(kampania nie ma jeszcze treści)</p>");

  return oprawa(
    <div className="space-y-6">
      <header className="px-1">
        <p className="mb-2 text-[13px] font-semibold text-[var(--color-akcent)]">{wiersz.sklep} · akceptacja kampanii</p>
        <h1>{wiersz.name}</h1>
        <div className="mt-3 max-w-[70ch] rounded-lg border border-[var(--color-linia)] bg-white px-4 py-3 text-[14px] text-[var(--color-tekst-2)]">
          <span className="font-medium text-[var(--color-tekst)]">Temat:</span> {wiersz.subject ?? "—"}
          {wiersz.preheader ? <div className="mt-1 text-[13px]"><span className="font-medium text-[var(--color-tekst)]">Tekst podglądu:</span> {wiersz.preheader}</div> : null}
        </div>
      </header>

      <Card>
        <div className="border-b border-[var(--color-linia)] px-5 py-4 sm:px-6">
          <h2>Podgląd wiadomości</h2>
          <p className="mt-1 text-[13px] text-[var(--color-tekst-2)]">Sprawdź treść, układ i wszystkie elementy kampanii.</p>
        </div>
        <iframe
          title="Podgląd kampanii"
          srcDoc={`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:24px;font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#16181d">${html}</body></html>`}
          className="h-[460px] w-full border-0 bg-white"
          sandbox=""
        />
      </Card>

      <Card>
        <CardBody>
          <form action={zdecydujAkcja} className="space-y-5">
            <input type="hidden" name="token" value={token} />
            {blad === "uwagi" ? (
              <Alert tone="blad" title="Opisz potrzebne poprawki">Napisz, co należy zmienić, żeby agencja mogła przygotować kolejną wersję.</Alert>
            ) : null}
            <Field
              label="Uwagi do kampanii"
              htmlFor="uwagi"
              hint="Pole jest wymagane tylko wtedy, gdy zgłaszasz poprawki."
            >
              <Textarea id="uwagi" name="uwagi" rows={4} aria-invalid={blad === "uwagi"} placeholder="np. Zmieńcie zdjęcie w nagłówku" />
            </Field>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button className="max-sm:w-full" variant="secondary" name="decyzja" value="changes_requested" type="submit">Zgłaszam poprawki</Button>
              <Button className="max-sm:w-full" name="decyzja" value="approved" type="submit"><Icon name="gotowe" size={17} />Akceptuję kampanię</Button>
            </div>
            <p className="text-[12px] leading-[18px] text-[var(--color-tekst-3)]">Kampania nie wyjdzie bez Twojej akceptacji, także o zaplanowanej porze.</p>
          </form>
        </CardBody>
      </Card>
    </div>,
  );
}
