"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { utworzTenantaZDostepem } from "../adapters/db/repozytoria";
import { podlaczSklepWoo } from "../usecases/podlacz-sklep";
import { wykonajImport } from "../usecases/importuj-historie";
import { wymaganaSesja, wymaganyTenant } from "./autoryzacja";
import type { StanFormularza } from "./formularze";

// Server actions są cienkim opakowaniem use-case (AD-17). Zero logiki biznesowej tutaj.
// KAŻDA akcja dostająca tenantId z formularza zaczyna od wymaganyTenant() (AD-21):
// hidden input to dane od klienta, dopiero porównanie z sesją czyni z niego dostęp.
//
// Obsługa błędów (audyt UX 2026-08-31, B3-B5): formularze, w które operator wpisuje
// dużo, idą przez useActionState - akcja zwraca { blad, wartosci } i wpisane dane
// wracają do pól. Lekkie formularze zostają przy redirect(?blad=), ale ZAWSZE
// z komunikatem na stronie, z której przyszły. Żadna walidacja nie kończy się
// cichym `return`.

export async function utworzTenantaAkcja(formularz: FormData) {
  const sesja = await wymaganaSesja();
  // workspace'y zakłada MidRev (admin/operator), nie klient - inaczej dowolne
  // konto client mogłoby mintować sobie tenanty i membershipy (audyt K1, pkt 3;
  // formularz na stronie głównej jest ukryty dla client, ale akcja to osobne
  // wejście POST i broni się sama)
  if (sesja.role === "client") notFound();
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  // HTML-owe required przepuszcza same spacje; brak nazwy to komunikat, nie cisza
  if (!nazwa) redirect(`/?blad=${encodeURIComponent("Podaj nazwę sklepu - same spacje to nie nazwa")}`);
  // null = bez membershipu: admin/operator mają dostęp globalny z roli (0006).
  // Gdyby polityka kiedyś dopuściła twórcę-clienta, utworzTenantaZDostepem
  // tworzy membership w tej samej transakcji co tenant - podać wtedy userId.
  const tenant = await utworzTenantaZDostepem(nazwa, null);
  redirect(`/t/${tenant.id}`);
}

export async function podlaczSklepAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const dane = {
    baseUrl: String(formularz.get("baseUrl") ?? "").trim(),
    consumerKey: String(formularz.get("consumerKey") ?? "").trim(),
    consumerSecret: String(formularz.get("consumerSecret") ?? "").trim(),
  };
  const wynik = await podlaczSklepWoo(tenantId, dane);
  if (!wynik.ok) {
    // błąd wraca do formularza razem z adresem i kluczem - operator poprawia
    // literówkę zamiast wpisywać wszystko od zera (audyt B3/B4). Consumer secret
    // ŚWIADOMIE nie wraca: echo w stanie server action to sekret w odpowiedzi
    // RSC i w DOM, a strona obiecuje, że poświadczenia nie pojawiają się
    // w odpowiedziach (review Codeksa, runda 1).
    return {
      blad: `${wynik.blad}. Wpisz consumer secret ponownie - nie odsyłamy go do przeglądarki.`,
      wartosci: { baseUrl: dane.baseUrl, consumerKey: dane.consumerKey },
    };
  }
  revalidatePath(`/t/${tenantId}/sklepy`);
  // wynik akcji ląduje na stronie, z której przyszła (audyt B3), nie na Przeglądzie
  redirect(`/t/${tenantId}/sklepy?ok=${encodeURIComponent("Sklep podłączony")}`);
}

export async function importujAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const storeId = String(formularz.get("storeId"));
  const wynik = await wykonajImport(tenantId, storeId);
  revalidatePath(`/t/${tenantId}/sklepy`);
  const komunikat = wynik.rozbieznosc
    ? `Import zakończony z rozbieżnością: ${wynik.rozbieznosc}`
    : `Zaimportowano ${wynik.utworzoneZamowienia} zamówień i ${wynik.utworzoneProfile} nowych profili`;
  // komunikat na /sklepy, bo tam jest przycisk importu (audyt B3)
  redirect(`/t/${tenantId}/sklepy?ok=${encodeURIComponent(komunikat)}`);
}

export async function utworzSegmentAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  const typ = String(formularz.get("typ"));
  const wartosc = Number(formularz.get("wartosc") ?? 0);
  if (!nazwa) {
    redirect(`/t/${tenantId}/segmenty?blad=${encodeURIComponent("Podaj nazwę segmentu - same spacje to nie nazwa")}`);
  }

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
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) {
    redirect(`/t/${tenantId}/listy?blad=${encodeURIComponent("Podaj nazwę listy - same spacje to nie nazwa")}`);
  }
  const { utworzListe } = await import("../adapters/db/repozytoria");
  await utworzListe(tenantId, nazwa, String(formularz.get("opis") ?? "") || null);
  revalidatePath(`/t/${tenantId}/listy`);
  redirect(`/t/${tenantId}/listy?ok=${encodeURIComponent("Lista utworzona")}`);
}

export async function utworzKampanieAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) {
    redirect(`/t/${tenantId}/kampanie?blad=${encodeURIComponent("Podaj nazwę kampanii - same spacje to nie nazwa")}`);
  }
  const { utworzKampanie } = await import("../adapters/db/repozytoria");
  await utworzKampanie(tenantId, nazwa, String(formularz.get("temat") ?? "") || null);
  revalidatePath(`/t/${tenantId}/kampanie`);
  redirect(`/t/${tenantId}/kampanie?ok=${encodeURIComponent("Kampania utworzona w szkicu")}`);
}

// ── Kampanie: treść, test, akceptacja, wysyłka ────────────────────────────────

export async function zapiszTrescAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const wartosci = {
    temat: String(formularz.get("temat") ?? ""),
    preheader: String(formularz.get("preheader") ?? ""),
    html: String(formularz.get("html") ?? ""),
  };
  const { getPool } = await import("../adapters/db/pool");
  const pool = getPool();

  const { rows } = await pool.query(
    "select status from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  if (!rows[0]) return { blad: "Nie znaleziono kampanii", wartosci };
  const statusPrzed = String(rows[0].status);
  if (["sending", "sent"].includes(statusPrzed)) {
    return {
      blad: "Kampania po starcie wysyłki jest zamknięta - odbiorcy dostali to, co zaakceptował klient, i treść karty musi się z tym zgadzać.",
      wartosci,
    };
  }

  // edycja treści unieważnia akceptację: klient akceptował konkretną wersję,
  // więc zmiana po akceptacji (albo w trakcie czekania na nią) cofa kampanię
  // do draftu i wymusza nową rundę (FR41). Warunek na statusie powtórzony
  // w UPDATE, bo między SELECT a UPDATE worker mógł ruszyć wysyłkę.
  // status cofa się do draftu TYLKO gdy treść faktycznie się zmienia (porównanie
  // ze starymi wartościami w bazie): ponowny klik "Zapisz treść" bez zmian nie
  // ma unieważniać rundy akceptacji (review Codeksa, runda 2)
  const zapis = await pool.query(
    `update campaigns set subject = $3, preheader = $4,
            content = jsonb_set(coalesce(content, '{}'::jsonb), '{html}', to_jsonb($5::text)),
            status = case
              when status in ('approved', 'awaiting_approval')
                   and (subject is distinct from $3
                        or preheader is distinct from $4
                        or coalesce(content->>'html', '') is distinct from $5)
              then 'draft' else status end,
            updated_at = now()
      where tenant_id = $1 and id = $2 and status not in ('sending', 'sent')
      returning status`,
    [
      tenantId,
      campaignId,
      wartosci.temat.trim() || null,
      wartosci.preheader.trim() || null,
      wartosci.html,
    ],
  );
  // wyścig SELECT->UPDATE domknięty na wyniku (review Codeksa, runda 1): jeśli
  // między odczytem a zapisem kampania weszła w wysyłkę, to NIE jest sukces
  if (zapis.rowCount === 0) {
    return {
      blad: "Kampania w międzyczasie weszła w wysyłkę - treść nie została zmieniona.",
      wartosci,
    };
  }
  const cofnieta =
    ["approved", "awaiting_approval"].includes(statusPrzed) &&
    zapis.rows[0].status === "draft";
  if (cofnieta) {
    // stare, niezdecydowane linki akceptacji przestają działać: dotyczyły innej
    // treści, więc klient nie może nimi zaakceptować wersji, której nie widział
    // (review Codeksa, runda 1)
    await pool.query(
      `update campaign_approvals set expires_at = now()
        where tenant_id = $1 and campaign_id = $2 and decided_at is null and expires_at > now()`,
      [tenantId, campaignId],
    );
  }
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  const komunikat = cofnieta
    ? "Treść zapisana. Kampania wróciła do szkicu, a wcześniejsze linki akceptacji wygasły - klient akceptował inną wersję."
    : "Treść zapisana";
  redirect(`/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent(komunikat)}`);
}

export async function wyslijTestAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const adres = String(formularz.get("adres") ?? "").trim();
  if (!adres) {
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent("Podaj adres, na który ma pójść test")}`);
  }

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
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const { randomBytes, createHash } = await import("node:crypto");
  const { getPool } = await import("../adapters/db/pool");
  const { config } = await import("../config");

  const pool = getPool();
  const { rows } = await pool.query(
    "select subject, content, status from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  // wstępna kontrola dla czytelnych komunikatów; autorytatywna bramka to warunek
  // WHERE w transakcji niżej, bo między odczytem a zapisem kampania mogła się zmienić
  if (!rows[0]?.subject || !String((rows[0].content as any)?.html ?? "").trim()) {
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent("Kampania bez tematu albo treści nie idzie do akceptacji")}`);
  }
  if (!["draft", "awaiting_approval", "approved"].includes(String(rows[0].status))) {
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent("Kampania w tym stanie nie idzie do akceptacji")}`);
  }

  // token jednorazowy: jawny tylko w linku, w bazie hash (NFR10)
  const token = randomBytes(24).toString("base64url");
  // zmiana statusu i insert tokenu w JEDNEJ transakcji (review Codeksa, runda 2):
  // awaria na insercie nie może zostawić kampanii w awaiting_approval bez linku.
  // WHERE powtarza pełną bramkę: stan przed wysyłką (spreparowany POST nie cofnie
  // sending/sent/cancelled do czekania na klienta) ORAZ komplet tematu i treści
  // (równoległy zapis mógł je wyczyścić po wstępnym SELECT).
  const klient = await pool.connect();
  let zablokowana = false;
  try {
    await klient.query("begin");
    const zmiana = await klient.query(
      `update campaigns set status = 'awaiting_approval', updated_at = now()
        where tenant_id = $1 and id = $2
          and status in ('draft', 'awaiting_approval', 'approved')
          and subject is not null and coalesce(content->>'html', '') <> ''`,
      [tenantId, campaignId],
    );
    if (zmiana.rowCount === 0) {
      await klient.query("rollback");
      zablokowana = true;
    } else {
      await klient.query(
        `insert into campaign_approvals (tenant_id, campaign_id, token_hash, expires_at)
         values ($1, $2, $3, now() + interval '7 days')`,
        [tenantId, campaignId, createHash("sha256").update(token).digest("hex")],
      );
      await klient.query("commit");
    }
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
  if (zablokowana) {
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent("Kampania w tym stanie nie idzie do akceptacji")}`);
  }
  const link = `${config().APP_URL}/akceptacja/${token}`;
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  // Docelowo link idzie mailem do klienta; do czasu modułu powiadomień operator
  // przekazuje go sam. Pełny link istnieje TYLKO teraz (w bazie leży hash), więc
  // wraca parametrem ?link= i karta renderuje go z przyciskiem Kopiuj; sekcja
  // "Akceptacja klienta" pokazuje potem stan bez samego linku.
  redirect(
    `/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent("Link do akceptacji wygenerowany, ważny 7 dni")}&link=${encodeURIComponent(link)}`,
  );
}

export async function wyslijTerazAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const { getPool } = await import("../adapters/db/pool");
  const { dodajZadanie } = await import("../jobs/kolejka");

  const pool = getPool();
  // wysyłka wyłącznie z ważną akceptacją (FR41): to jest reguła w kodzie, nie procedura
  const { rows } = await pool.query(
    `update campaigns set status = 'sending', updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'approved'
        and (select a.decision from campaign_approvals a
              where a.tenant_id = $1 and a.campaign_id = $2 and a.decided_at is not null
              order by a.decided_at desc limit 1) = 'approved'
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
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = String(formularz.get("campaignId"));
  const { przeliczAtrybucje } = await import("../usecases/przelicz-atrybucje");
  const wynik = await przeliczAtrybucje(tenantId);
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  redirect(
    `/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent(`Atrybucja przeliczona: ${wynik.przypisanych} zamówień w oknie ${wynik.oknoGodzin}h`)}`,
  );
}
