"use server";

import { createHash } from "node:crypto";
import { getPool } from "../../../adapters/db/pool";
import { redirect } from "next/navigation";

export async function zdecydujAkcja(formularz: FormData) {
  const token = String(formularz.get("token") ?? "");
  const decyzja = String(formularz.get("decyzja"));
  const uwagi = String(formularz.get("uwagi") ?? "").trim() || null;
  // spreparowana decyzja spoza słownika wraca na stronę tokenu zamiast kończyć
  // się ciszą (audyt B5: żadna gałąź walidacji nie kończy się gołym return)
  if (!["approved", "changes_requested"].includes(decyzja)) {
    redirect(`/akceptacja/${token}`);
  }
  // "Zgłaszam uwagi" bez uwag to dla operatora decyzja bez treści - wymagamy
  // niepustego pola i mówimy to przy polu (audyt S9)
  if (decyzja === "changes_requested" && !uwagi) {
    redirect(`/akceptacja/${token}?blad=uwagi`);
  }

  const hash = createHash("sha256").update(token).digest("hex");
  const pool = getPool();

  // decyzja zapada tylko raz: warunek decided_at is null zamyka wyścig dwóch kliknięć
  const { rows } = await pool.query(
    `update campaign_approvals
        set decided_at = now(), decision = $2, comment = $3
      where token_hash = $1 and decided_at is null and expires_at > now()
      returning tenant_id, campaign_id`,
    [hash, decyzja, uwagi],
  );
  const wiersz = rows[0];
  if (wiersz) {
    // strażnik stanu: decyzja klienta zmienia kampanię tylko wtedy, gdy ta CZEKA
    // na akceptację. Bez tego warunku drugi, starszy token potrafiłby cofnąć
    // wysłaną kampanię do draftu albo postawić approved na czymś, co już poszło
    // (znalezisko W9). Kampania w innym stanie = prośba nieaktualna; sama decyzja
    // w campaign_approvals zostaje jako zapis historyczny.
    await pool.query(
      `update campaigns set status = $3, updated_at = now()
        where tenant_id = $1 and id = $2 and status = 'awaiting_approval'`,
      [wiersz.tenant_id, wiersz.campaign_id, decyzja === "approved" ? "approved" : "draft"],
    );
  }
  redirect(`/akceptacja/${token}`);
}
