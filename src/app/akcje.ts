"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { utworzTenanta } from "../adapters/db/repozytoria";
import { podlaczSklepWoo } from "../usecases/podlacz-sklep";
import { wykonajImport } from "../usecases/importuj-historie";

// Server actions są cienkim opakowaniem use-case (AD-17). Zero logiki biznesowej tutaj.

export async function utworzTenantaAkcja(formularz: FormData) {
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) return;
  const tenant = await utworzTenanta(nazwa);
  redirect(`/t/${tenant.id}`);
}

export async function podlaczSklepAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const wynik = await podlaczSklepWoo(tenantId, {
    baseUrl: String(formularz.get("baseUrl") ?? "").trim(),
    consumerKey: String(formularz.get("consumerKey") ?? "").trim(),
    consumerSecret: String(formularz.get("consumerSecret") ?? "").trim(),
  });
  revalidatePath(`/t/${tenantId}`);
  if (!wynik.ok) {
    redirect(`/t/${tenantId}?blad=${encodeURIComponent(wynik.blad)}`);
  }
  redirect(`/t/${tenantId}?ok=${encodeURIComponent("Sklep podłączony")}`);
}

export async function importujAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const storeId = String(formularz.get("storeId"));
  const wynik = await wykonajImport(tenantId, storeId);
  revalidatePath(`/t/${tenantId}`);
  const komunikat = wynik.rozbieznosc
    ? `Import zakończony z rozbieżnością: ${wynik.rozbieznosc}`
    : `Zaimportowano ${wynik.utworzoneZamowienia} zamówień i ${wynik.utworzoneProfile} nowych profili`;
  redirect(`/t/${tenantId}?ok=${encodeURIComponent(komunikat)}`);
}

export async function utworzSegmentAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  const typ = String(formularz.get("typ"));
  const wartosc = Number(formularz.get("wartosc") ?? 0);
  if (!nazwa) return;

  const regula =
    typ === "wydal_powyzej"
      ? { typ, kwotaMinor: Math.round(wartosc * 100) }
      : typ === "liczba_zamowien_min"
        ? { typ, ile: wartosc }
        : typ === "ma_zgode"
          ? { typ, kanal: "email" }
          : { typ, dni: wartosc };

  const { utworzSegment } = await import("../adapters/db/repozytoria");
  await utworzSegment(tenantId, nazwa, [regula]);
  revalidatePath(`/t/${tenantId}/segmenty`);
  redirect(`/t/${tenantId}/segmenty?ok=${encodeURIComponent("Segment zapisany")}`);
}

export async function utworzListeAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) return;
  const { utworzListe } = await import("../adapters/db/repozytoria");
  await utworzListe(tenantId, nazwa, String(formularz.get("opis") ?? "") || null);
  revalidatePath(`/t/${tenantId}/listy`);
  redirect(`/t/${tenantId}/listy?ok=${encodeURIComponent("Lista utworzona")}`);
}

export async function utworzKampanieAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) return;
  const { utworzKampanie } = await import("../adapters/db/repozytoria");
  await utworzKampanie(tenantId, nazwa, String(formularz.get("temat") ?? "") || null);
  revalidatePath(`/t/${tenantId}/kampanie`);
  redirect(`/t/${tenantId}/kampanie?ok=${encodeURIComponent("Kampania utworzona w szkicu")}`);
}

// ── Kampanie: treść, test, akceptacja, wysyłka ────────────────────────────────

export async function zapiszTrescAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const { getPool } = await import("../adapters/db/pool");
  await getPool().query(
    `update campaigns set subject = $3, preheader = $4,
            content = jsonb_set(coalesce(content, '{}'::jsonb), '{html}', to_jsonb($5::text)),
            updated_at = now()
      where tenant_id = $1 and id = $2`,
    [
      tenantId,
      campaignId,
      String(formularz.get("temat") ?? "").trim() || null,
      String(formularz.get("preheader") ?? "").trim() || null,
      String(formularz.get("html") ?? ""),
    ],
  );
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  redirect(`/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent("Treść zapisana")}`);
}

export async function wyslijTestAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const adres = String(formularz.get("adres") ?? "").trim();
  if (!adres) return;

  const { randomUUID } = await import("node:crypto");
  const { randomBytes } = await import("node:crypto");
  const { getPool } = await import("../adapters/db/pool");
  const { zlozWiadomosc } = await import("../usecases/wysylka/renderuj");
  const { wyslijPartie } = await import("../usecases/wysylka/wyslij-kampanie");

  const pool = getPool();
  const { rows } = await pool.query(
    `select c.subject, c.content, t.name as sklep from campaigns c
      join tenants t on t.id = c.tenant_id where c.tenant_id = $1 and c.id = $2`,
    [tenantId, campaignId],
  );
  const kampania = rows[0];
  const html = String((kampania?.content as any)?.html ?? "");
  if (!kampania?.subject || !html.trim()) {
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent("Uzupełnij temat i treść przed testem")}`);
  }

  // Test idzie DOKŁADNIE tą samą ścieżką co wysyłka właściwa: ta sama funkcja renderująca,
  // ta sama kolejka, ten sam adapter. Trzy osobne ścieżki oznaczają, że test pokazuje
  // co innego niż dostaje odbiorca. source_id losowy, żeby każdy test był osobną wiadomością.
  const clickToken = randomBytes(18).toString("base64url");
  const unsubToken = randomBytes(18).toString("base64url");
  const { html: pelny } = zlozWiadomosc({
    trescHtml: html,
    clickToken,
    unsubscribeToken: unsubToken,
    nazwaSklepu: kampania.sklep,
  });
  await pool.query(
    `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
     values ($1, null, 'test', $2, $3, $4, $5, $6, $7)`,
    [tenantId, randomUUID(), adres, `[TEST] ${kampania.subject}`, pelny, clickToken, unsubToken],
  );
  await wyslijPartie(tenantId, { limit: 5 });
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  redirect(`/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent(`Test wysłany na ${adres}`)}`);
}

export async function doAkceptacjiAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const { randomBytes, createHash } = await import("node:crypto");
  const { getPool } = await import("../adapters/db/pool");
  const { config } = await import("../config");

  const pool = getPool();
  const { rows } = await pool.query(
    "select subject, content from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  if (!rows[0]?.subject || !String((rows[0].content as any)?.html ?? "").trim()) {
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent("Kampania bez tematu albo treści nie idzie do akceptacji")}`);
  }

  // token jednorazowy: jawny tylko w linku, w bazie hash (NFR10)
  const token = randomBytes(24).toString("base64url");
  await pool.query(
    `insert into campaign_approvals (tenant_id, campaign_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '7 days')`,
    [tenantId, campaignId, createHash("sha256").update(token).digest("hex")],
  );
  await pool.query(
    "update campaigns set status = 'awaiting_approval', updated_at = now() where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  const link = `${config().APP_URL}/akceptacja/${token}`;
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  // Docelowo link idzie mailem do klienta; do czasu modułu powiadomień operator
  // przekazuje go sam, więc pokazujemy go w komunikacie.
  redirect(`/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent(`Link do akceptacji dla klienta: ${link}`)}`);
}

export async function wyslijTerazAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const { getPool } = await import("../adapters/db/pool");
  const { dodajZadanie } = await import("../jobs/kolejka");

  const pool = getPool();
  // wysyłka wyłącznie z ważną akceptacją (FR41): to jest reguła w kodzie, nie procedura
  const { rows } = await pool.query(
    `update campaigns set status = 'sending', updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'approved'
        and exists (select 1 from campaign_approvals a
                     where a.tenant_id = $1 and a.campaign_id = $2 and a.decision = 'approved')
      returning id`,
    [tenantId, campaignId],
  );
  if (!rows.length) {
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent("Wysyłka zablokowana: kampania nie ma akceptacji klienta")}`);
  }
  await dodajZadanie(tenantId, "wyslij_kampanie", { campaignId });
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  redirect(`/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent("Wysyłka ruszyła, worker przejmuje kolejkę")}`);
}

export async function przeliczAtrybucjeAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const { przeliczAtrybucje } = await import("../usecases/przelicz-atrybucje");
  const wynik = await przeliczAtrybucje(tenantId);
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  redirect(
    `/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent(`Atrybucja przeliczona: ${wynik.przypisanych} zamówień w oknie ${wynik.oknoGodzin}h`)}`,
  );
}
