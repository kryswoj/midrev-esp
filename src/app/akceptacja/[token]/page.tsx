import { createHash } from "node:crypto";
import { getPool } from "../../../adapters/db/pool";
import { zdecydujAkcja } from "./akcje";

export const dynamic = "force-dynamic";

/**
 * Publiczna strona akceptacji kampanii (FR39, FR40). Klient sklepu dostaje link mailem
 * i decyduje BEZ logowania: token jednorazowy, ważny 7 dni, w bazie tylko hash (NFR10).
 * Strona musi działać na telefonie (NFR32), bo tam zostanie otwarta.
 */
export default async function Akceptacja({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
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

  const oprawa = (tresc: React.ReactNode) => (
    <main className="mx-auto grid min-h-screen max-w-2xl place-items-start px-4 py-10">
      <div className="w-full">{tresc}</div>
    </main>
  );

  if (!wiersz) return oprawa(<h1>Ten link jest nieprawidłowy</h1>);
  if (new Date(wiersz.expires_at) < new Date() && !wiersz.decided_at)
    return oprawa(
      <>
        <h1>Ten link wygasł</h1>
        <p className="mt-2 text-[var(--color-tekst-2)]">
          Link do akceptacji jest ważny 7 dni. Poproś agencję o nowy.
        </p>
      </>,
    );
  if (wiersz.decided_at)
    return oprawa(
      <>
        <h1>{wiersz.decision === "approved" ? "Kampania zaakceptowana" : "Uwagi przekazane"}</h1>
        <p className="mt-2 text-[var(--color-tekst-2)]">
          Decyzja z {new Date(wiersz.decided_at).toLocaleString("pl-PL")} została zapisana. Ten link
          był jednorazowy.
        </p>
      </>,
    );

  const html = String((wiersz.content as any)?.html ?? "<p>(kampania nie ma jeszcze treści)</p>");

  return oprawa(
    <>
      <p className="etykieta">{wiersz.sklep} · akceptacja kampanii</p>
      <h1 className="mt-1">{wiersz.name}</h1>
      <p className="mt-1 text-[var(--color-tekst-2)]">
        Temat: <strong className="text-[var(--color-tekst)]">{wiersz.subject ?? "—"}</strong>
        {wiersz.preheader ? <> · {wiersz.preheader}</> : null}
      </p>

      <div className="karta mt-4 overflow-hidden bg-white">
        <iframe
          title="Podgląd kampanii"
          srcDoc={`<!doctype html><body style="margin:16px;font:14px/1.6 -apple-system,Segoe UI,sans-serif;color:#111">${html}</body>`}
          className="h-[420px] w-full border-0 bg-white"
          sandbox=""
        />
      </div>

      <form action={zdecydujAkcja} className="mt-4 space-y-3">
        <input type="hidden" name="token" value={token} />
        <label className="block">
          <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">
            Uwagi (wypełnij tylko, jeśli zgłaszasz poprawki)
          </span>
          <textarea name="uwagi" rows={3} className="pole" placeholder="np. zmieńcie zdjęcie w nagłówku" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="przycisk" name="decyzja" value="approved" type="submit">
            Akceptuję, wysyłajcie
          </button>
          <button className="przycisk przycisk-wtorny" name="decyzja" value="changes_requested" type="submit">
            Zgłaszam uwagi
          </button>
        </div>
        <p className="text-[12px] text-[var(--color-tekst-3)]">
          Kampania nie wyjdzie bez Twojej akceptacji, także o zaplanowanej porze.
        </p>
      </form>
    </>,
  );
}
