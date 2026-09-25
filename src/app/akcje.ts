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
  const storeId = wymaganyUuid(formularz.get("storeId"));
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

  // Reguła przechodzi przez TEN SAM parser, którym czyta ją kompilator segmentów:
  // nieznany typ, pusta wartość (dni: 0 / NaN) albo ujemna kwota to komunikat na
  // ekranie, a nie 500 na /segmenty, na każdym profilu i na odbiorcach kampanii.
  const { parsujReguly } = await import("../domain/segmenty");
  let reguly;
  try {
    reguly = parsujReguly([regula]);
  } catch (blad) {
    redirect(`/t/${tenantId}/segmenty?blad=${encodeURIComponent((blad as Error).message)}`);
  }
  const { utworzSegment } = await import("../adapters/db/repozytoria");
  await utworzSegment(tenantId, nazwa, reguly);
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
  const id = await utworzKampanie(tenantId, nazwa, String(formularz.get("temat") ?? "").trim() || null);
  revalidatePath(`/t/${tenantId}/kampanie`);
  // nowa kampania otwiera się od razu w kreatorze, na kroku 1 (Odbiorcy) — jak w Klaviyo
  redirect(`/t/${tenantId}/kampanie/${id}/odbiorcy?ok=${encodeURIComponent("Szkic utworzony. Wybierz, do kogo pójdzie kampania.")}`);
}

// ── Kampanie: treść, test, akceptacja, wysyłka ────────────────────────────────

/**
 * Adres powrotu z formularza. Tylko ścieżka wewnątrz TEJ kampanii — inaczej hidden input
 * byłby otwartym przekierowaniem.
 */
function powrotKampanii(tenantId: string, campaignId: string, surowy: FormDataEntryValue | null): string {
  const baza = `/t/${tenantId}/kampanie/${campaignId}`;
  const cel = String(surowy ?? "");
  return cel === baza || /^\/t\/[0-9a-f-]{36}\/kampanie\/[0-9a-f-]{36}\/(odbiorcy|tresc|ustawienia)$/i.test(cel) && cel.startsWith(`${baza}/`)
    ? cel
    : baza;
}

const UUID_KAMPANII = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identyfikator z formularza albo z wywołania: śmieć = 404, nie błąd Postgresa (audyt #17). */
function wymaganyUuid(surowy: unknown): string {
  const id = String(surowy ?? "");
  if (!UUID_KAMPANII.test(id)) notFound();
  return id;
}

/** campaignId z formularza albo z wywołania: śmieć = 404, nie błąd Postgresa. */
function wymaganaKampania(surowy: unknown): string {
  return wymaganyUuid(surowy);
}

// Krok 3: nazwa robocza, temat i preheader. useActionState: błąd nie kasuje wpisanych pól.
export async function zapiszUstawieniaAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const wartosci = {
    nazwa: String(formularz.get("nazwa") ?? ""),
    temat: String(formularz.get("temat") ?? ""),
    preheader: String(formularz.get("preheader") ?? ""),
  };
  const { zapiszTrescKampanii } = await import("../usecases/tresc/zapisz-tresc");
  const wynik = await zapiszTrescKampanii(tenantId, campaignId, wartosci);
  if (!wynik.ok) return { blad: wynik.blad, wartosci };
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`, "layout");
  const komunikat =
    (wynik.cofnieta
      ? "Zapisano. Kampania wróciła do szkicu, a wcześniejsze linki akceptacji wygasły - klient akceptował inną wersję."
      : "Temat i preheader zapisane") +
    (wynik.planZdjety ? " Plan wysyłki zdjęty — zaplanuj ponownie, termin przejdzie listę kontrolną od nowa." : "");
  const dalej = formularz.get("dalej") === "tak";
  redirect(
    dalej
      ? `/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent(komunikat)}`
      : `/t/${tenantId}/kampanie/${campaignId}/ustawienia?ok=${encodeURIComponent(komunikat)}`,
  );
}

/**
 * Autozapis kroku 1 (odbiorcy): wołany z komponentu klienta przy każdej zmianie wyboru,
 * bez przekierowania. Zmiana odbiorców nie cofa akceptacji (klient akceptuje treść),
 * więc autozapis jest tu bezpieczny także dla kampanii czekającej na klienta.
 */
export async function autozapisOdbiorcowAkcja(
  tenantIdSurowy: string,
  campaignIdSurowy: string,
  wybor: { wlacz: string[]; wylacz: string[] },
): Promise<{ ok: true } | { ok: false; blad: string }> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const campaignId = wymaganaKampania(campaignIdSurowy);
  const { ustawOdbiorcow, zrodloZPola } = await import("../usecases/tresc/odbiorcy-kampanii");
  if (!Array.isArray(wybor?.wlacz) || !Array.isArray(wybor?.wylacz) || wybor.wlacz.length + wybor.wylacz.length > 50) {
    return { ok: false, blad: "Nieprawidłowy wybór odbiorców. Odśwież stronę." };
  }
  const wlacz = wybor.wlacz.map((v) => zrodloZPola(String(v)));
  const wylacz = wybor.wylacz.map((v) => zrodloZPola(String(v)));
  if ([...wlacz, ...wylacz].some((z) => z === null)) return { ok: false, blad: "Nieznane źródło odbiorców. Odśwież stronę." };
  const wynik = await ustawOdbiorcow(tenantId, campaignId, wlacz as any, wylacz as any);
  if (!wynik.ok) return wynik;
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`, "layout");
  return { ok: true };
}

/**
 * Autozapis kroku 3 (nazwa, temat, preheader) — wyłącznie dla szkicu. Kampania czekająca
 * na klienta albo zaakceptowana zapisuje ręcznie (formularz wyżej), bo zmiana tematu
 * cofa akceptację i ma być świadomą decyzją, a nie skutkiem pisania.
 */
export async function autozapisUstawienAkcja(
  tenantIdSurowy: string,
  campaignIdSurowy: string,
  wartosci: { nazwa: string; temat: string; preheader: string },
): Promise<{ ok: true; planZdjety: boolean } | { ok: false; blad: string }> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const campaignId = wymaganaKampania(campaignIdSurowy);
  const { zapiszTrescKampanii } = await import("../usecases/tresc/zapisz-tresc");
  const wynik = await zapiszTrescKampanii(tenantId, campaignId, {
    nazwa: String(wartosci?.nazwa ?? ""),
    temat: String(wartosci?.temat ?? ""),
    preheader: String(wartosci?.preheader ?? ""),
    tylkoSzkic: true,
  });
  if (!wynik.ok) return wynik;
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`, "layout");
  return { ok: true, planZdjety: wynik.planZdjety };
}

export type WynikZapisuBlokow =
  | { ok: true; cofnieta: boolean; planZdjety: boolean; uwagi: string[]; zapisanoO: string }
  | { ok: false; blad: string };

/**
 * Krok 2: zapis dokumentu z edytora bloków. Wołane z komponentu klienta (nie formularz),
 * więc zwraca wynik zamiast przekierowania — edytor zostaje na miejscu z historią cofania.
 * Walidacja zod, sanityzacja tekstów i render do `content.html` dzieją się TUTAJ, na
 * serwerze: przeglądarce nie wierzymy ani co do struktury, ani co do HTML-a.
 */
export async function zapiszBlokiAkcja(
  tenantIdSurowy: string,
  campaignIdSurowy: string,
  dokumentJson: string,
  /** autozapis szkicu: zapis tylko, gdy kampania nadal jest szkicem (warunek w UPDATE) */
  autozapis = false,
): Promise<WynikZapisuBlokow> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const campaignId = wymaganaKampania(campaignIdSurowy);
  const { przygotujDokument, zapiszTrescKampanii } = await import("../usecases/tresc/zapisz-tresc");
  const przygotowany = przygotujDokument(dokumentJson);
  if (!przygotowany.ok) return przygotowany;
  const wynik = await zapiszTrescKampanii(tenantId, campaignId, { dokument: przygotowany.dokument, tylkoSzkic: autozapis === true });
  if (!wynik.ok) return wynik;
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`, "layout");
  return { ok: true, cofnieta: wynik.cofnieta, planZdjety: wynik.planZdjety, uwagi: wynik.uwagi, zapisanoO: new Date().toISOString() };
}

/**
 * Podgląd „tak dostanie odbiorca": bloki → HTML → PRAWDZIWE `zlozWiadomosc` (oprawa silnika
 * i stopka z wypisem), z tokenami-atrapami i bez pixela. Nic nie zapisuje.
 */
export async function podgladBlokowAkcja(
  tenantIdSurowy: string,
  campaignIdSurowy: string,
  dokumentJson: string,
): Promise<{ ok: true; html: string; uwagi: string[] } | { ok: false; blad: string }> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const campaignId = wymaganaKampania(campaignIdSurowy);
  const { przygotujDokument } = await import("../usecases/tresc/zapisz-tresc");
  const { renderujDokument } = await import("../usecases/tresc/render-blokow");
  const { zlozWiadomosc } = await import("../usecases/wysylka/renderuj");
  const { getPool } = await import("../adapters/db/pool");
  const przygotowany = przygotujDokument(dokumentJson);
  if (!przygotowany.ok) return przygotowany;
  const { rows } = await getPool().query(
    `select c.preheader, t.name as sklep from campaigns c join tenants t on t.id = c.tenant_id
      where c.tenant_id = $1 and c.id = $2`,
    [tenantId, campaignId],
  );
  if (!rows[0]) return { ok: false, blad: "Nie znaleziono kampanii." };
  const render = renderujDokument(przygotowany.dokument, { preheader: rows[0].preheader });
  const { html } = zlozWiadomosc({
    trescHtml: render.html,
    clickToken: "podglad",
    unsubscribeToken: "podglad",
    nazwaSklepu: String(rows[0].sklep ?? ""),
    sledzKlikniecia: false,
    sledzOtwarcia: false,
  });
  return { ok: true, html, uwagi: render.uwagi };
}

export async function wyslijTestAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const cel = powrotKampanii(tenantId, campaignId, formularz.get("wrocDo"));
  const { wyslijTestKampanii } = await import("../usecases/tresc/wysylka-testowa");
  const wynik = await wyslijTestKampanii(tenantId, campaignId, String(formularz.get("adres") ?? ""));
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  if (!wynik.ok) redirect(`${cel}?blad=${encodeURIComponent(wynik.blad)}`);
  redirect(`${cel}?ok=${encodeURIComponent(wynik.komunikat)}`);
}

/** Wysyłka testowa z edytora: bez przekierowania, żeby nie gubić stanu płótna. */
export async function wyslijTestZEdytoraAkcja(
  tenantIdSurowy: string,
  campaignIdSurowy: string,
  adres: string,
): Promise<{ ok: true; komunikat: string } | { ok: false; blad: string }> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const campaignId = wymaganaKampania(campaignIdSurowy);
  const { wyslijTestKampanii } = await import("../usecases/tresc/wysylka-testowa");
  return wyslijTestKampanii(tenantId, campaignId, adres);
}

export async function doAkceptacjiAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
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
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const { getPool } = await import("../adapters/db/pool");
  const { dodajZadanie } = await import("../jobs/kolejka");

  const { stanWysylkiTenanta } = await import("../usecases/wysylka/reputacja");

  const pool = getPool();
  // Wstrzymanie tenanta (B5) sprawdzane PRZED bramką akceptacji tylko po to, żeby dać
  // właściwy komunikat. Wiążący jest warunek w UPDATE niżej — między odczytem a zapisem
  // progi mogły wstrzymać wysyłkę.
  const wstrzymanie = await stanWysylkiTenanta(tenantId);
  if (wstrzymanie.wstrzymany) {
    redirect(
      `/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent(`Wysyłka tego sklepu jest wstrzymana: ${wstrzymanie.powod ?? "bez podanego powodu"}. Wznów ją, zanim ruszysz kampanię.`)}`,
    );
  }
  // B4: lista kontrolna jest TWARDĄ bramką także tutaj, nie tylko wyszarzonym przyciskiem
  // na ekranie — spreparowany POST nie może wysłać kampanii bez tematu, odbiorców, linku
  // albo ze zablokowanej domeny.
  const { listaKontrolnaKampanii } = await import("../usecases/tresc/lista-kontrolna");
  const lista = await listaKontrolnaKampanii(tenantId, campaignId);
  const niespelnione = lista.punkty.filter((p) => p.stan === "blad");
  if (niespelnione.length) {
    redirect(
      `/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent(
        `Lista kontrolna nie przechodzi: ${niespelnione.map((p) => `${p.etykieta.toLowerCase()} — ${p.opis}`).join(" ")}`,
      )}`,
    );
  }
  // wysyłka wyłącznie z ważną akceptacją (FR41): to jest reguła w kodzie, nie procedura.
  // Zmiana statusu i wpis do kolejki w JEDNEJ transakcji (wzorzec z dispatchera,
  // sterowanie.ts): awaria między UPDATE-em a dodajZadanie zostawiałaby kampanię
  // w 'sending' bez joba, na zawsze, bez alertu (audyt 24.09, #16).
  const klient = await pool.connect();
  let uruchomiona = false;
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `update campaigns set status = 'sending', updated_at = now()
        where tenant_id = $1 and id = $2 and status = 'approved'
          and exists (select 1 from tenants t where t.id = $1 and t.sending_paused_at is null)
          and (select a.decision from campaign_approvals a
                where a.tenant_id = $1 and a.campaign_id = $2 and a.decided_at is not null
                order by a.decided_at desc limit 1) = 'approved'
        returning id`,
      [tenantId, campaignId],
    );
    if (rows.length) {
      await dodajZadanie(tenantId, "wyslij_kampanie", { campaignId }, { przez: klient });
      await klient.query("commit");
      uruchomiona = true;
    } else {
      await klient.query("rollback");
    }
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
  if (!uruchomiona) {
    // Powód odmowy czytamy z bazy, zamiast zgadywać: od czasu dispatchera (B1) najczęstszym
    // powodem nie jest brak akceptacji, tylko to, że kampanię uruchomił już ktoś inny —
    // harmonogram albo druga zakładka. Komunikat "brak akceptacji" byłby wtedy nieprawdą.
    const { rows: teraz } = await pool.query(
      "select status from campaigns where tenant_id = $1 and id = $2",
      [tenantId, campaignId],
    );
    const status = String(teraz[0]?.status ?? "");
    const powod =
      status === "sending" || status === "sent"
        ? "Wysyłka tej kampanii już ruszyła — uruchomił ją harmonogram albo druga osoba."
        : status === "paused"
          ? "Kampania jest wstrzymana. Wznów ją zamiast startować od nowa."
          : status === "cancelled"
            ? "Kampania jest odwołana."
            : "Wysyłka zablokowana: kampania nie ma akceptacji klienta.";
    redirect(`/t/${tenantId}/kampanie/${campaignId}?blad=${encodeURIComponent(powod)}`);
  }
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  redirect(`/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent("Wysyłka ruszyła, worker przejmuje kolejkę")}`);
}

export async function przeliczAtrybucjeAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const { przeliczAtrybucje } = await import("../usecases/przelicz-atrybucje");
  const wynik = await przeliczAtrybucje(tenantId);
  revalidatePath(`/t/${tenantId}/kampanie/${campaignId}`);
  redirect(
    `/t/${tenantId}/kampanie/${campaignId}?ok=${encodeURIComponent(`Atrybucja przeliczona: ${wynik.przypisanych} zamówień w oknie ${wynik.oknoGodzin}h`)}`,
  );
}


// ── Kampanie: plan wysyłki, wstrzymanie, odwołanie (BLOK B) ───────────────────

export async function zaplanujWysylkeAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const surowa = String(formularz.get("kiedy") ?? "").trim();
  const { zaplanujKampanie } = await import("../usecases/wysylka/sterowanie");

  // Puste pole = zdjęcie planu, a nie cichy brak akcji. Operator, który wyczyścił datę
  // i kliknął zapis, chce odwołać plan i ma dostać potwierdzenie, że plan zniknął.
  // Pole datetime-local nie zna strefy, a etykieta obiecuje „czas polski": parsujemy
  // JAWNIE w Europe/Warsaw, niezależnie od strefy serwera (host stoi w UTC; audyt #6).
  const { parsujCzasPolski } = await import("../usecases/wysylka/strefa");
  const cel = `/t/${tenantId}/kampanie/${campaignId}`;
  const kiedy = surowa ? parsujCzasPolski(surowa) : null;
  if (surowa && !kiedy) {
    redirect(`${cel}?blad=${encodeURIComponent("Termin wysyłki ma niepoprawny format. Wybierz datę i godzinę w polu.")}`);
  }
  // B4: planowany termin to też decyzja o wysyłce — kampania, która dziś nie przechodzi
  // listy kontrolnej, nie dostaje terminu. Zdjęcie planu (puste pole) zawsze wolno.
  // Stan sprzed terminu (np. domena zweryfikowana dziś, zepsuta jutro) pilnuje dalej
  // silnik: FR45 w wyborze nadawcy przed każdą partią.
  if (kiedy) {
    const { listaKontrolnaKampanii } = await import("../usecases/tresc/lista-kontrolna");
    const lista = await listaKontrolnaKampanii(tenantId, campaignId);
    const niespelnione = lista.punkty.filter((p) => p.stan === "blad");
    if (niespelnione.length) {
      redirect(
        `${cel}?blad=${encodeURIComponent(
          `Nie planuję wysyłki, lista kontrolna nie przechodzi: ${niespelnione.map((p) => p.etykieta.toLowerCase()).join(", ")}.`,
        )}`,
      );
    }
  }
  const wynik = await zaplanujKampanie(tenantId, campaignId, kiedy);
  if (!wynik.ok) redirect(`${cel}?blad=${encodeURIComponent(wynik.blad)}`);
  if (kiedy) {
    // Druga kontrola PO ustawieniu terminu (review Codeksa, runda 2): równoległy zapis treści
    // między pierwszą kontrolą a zapisem planu mógł usunąć np. ostatni link. Zapis treści
    // PO ustawieniu planu zdejmuje plan sam (zapiszTrescKampanii), więc to domyka okno wyścigu.
    const { listaKontrolnaKampanii } = await import("../usecases/tresc/lista-kontrolna");
    const ponownie = await listaKontrolnaKampanii(tenantId, campaignId);
    if (!ponownie.gotowa) {
      await zaplanujKampanie(tenantId, campaignId, null);
      redirect(
        `${cel}?blad=${encodeURIComponent("Treść zmieniła się w trakcie planowania i lista kontrolna już nie przechodzi — plan zdjęty.")}`,
      );
    }
  }
  revalidatePath(cel);
  const { formatujDateICzas } = await import("../domain/daty");
  redirect(
    `${cel}?ok=${encodeURIComponent(
      wynik.kiedy
        ? `Wysyłka zaplanowana na ${formatujDateICzas(wynik.kiedy)}. Ruszy sama, o ile klient zaakceptuje kampanię.`
        : "Plan wysyłki zdjęty. Kampania nie wyjdzie sama.",
    )}`,
  );
}

export async function wstrzymajKampanieAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const { wstrzymajKampanie } = await import("../usecases/wysylka/sterowanie");
  const wynik = await wstrzymajKampanie(tenantId, campaignId);
  const cel = `/t/${tenantId}/kampanie/${campaignId}`;
  if (!wynik.ok) redirect(`${cel}?blad=${encodeURIComponent(wynik.blad)}`);
  revalidatePath(cel);
  // Komunikat mówi WPROST, czego nie da się cofnąć: liczba przekazana dostawcy jest
  // ostateczna, a partia w locie dojdzie do końca.
  redirect(
    `${cel}?ok=${encodeURIComponent(
      `Wysyłka wstrzymana. Do dostawcy poszło już ${wynik.stan.przekazane} z ${wynik.stan.wszystkie} wiadomości i tego nie da się cofnąć. ` +
        `W kolejce czeka ${wynik.stan.wKolejce}, w locie jest ${wynik.stan.wLocie} — te ostatnie dojdą do końca.`,
    )}`,
  );
}

export async function wznowKampanieAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const { wznowKampanie } = await import("../usecases/wysylka/sterowanie");
  const wynik = await wznowKampanie(tenantId, campaignId);
  const cel = `/t/${tenantId}/kampanie/${campaignId}`;
  if (!wynik.ok) redirect(`${cel}?blad=${encodeURIComponent(wynik.blad)}`);
  revalidatePath(cel);
  redirect(`${cel}?ok=${encodeURIComponent("Wysyłka wznowiona, worker przejmuje resztę kolejki")}`);
}

export async function odwolajKampanieAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const campaignId = wymaganaKampania(formularz.get("campaignId"));
  const cel = `/t/${tenantId}/kampanie/${campaignId}`;
  // Odwołanie jest nieodwracalne, więc wymaga świadomego potwierdzenia przy liczbach
  // pokazanych na ekranie. Brak zaznaczenia to komunikat, nie cisza.
  if (String(formularz.get("potwierdzam") ?? "") !== "tak") {
    redirect(`${cel}?blad=${encodeURIComponent("Zaznacz potwierdzenie — odwołania kampanii nie da się cofnąć")}`);
  }
  const { odwolajKampanie } = await import("../usecases/wysylka/sterowanie");
  const wynik = await odwolajKampanie(tenantId, campaignId);
  if (!wynik.ok) redirect(`${cel}?blad=${encodeURIComponent(wynik.blad)}`);
  revalidatePath(cel);
  redirect(
    `${cel}?ok=${encodeURIComponent(
      `Kampania odwołana. Zatrzymano ${wynik.zatrzymaneTeraz} wiadomości z kolejki. ` +
        `Do dostawcy poszło ${wynik.stan.przekazane} z ${wynik.stan.wszystkie} i tych nie da się cofnąć.`,
    )}`,
  );
}

export async function wznowWysylkeSklepuAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const wrocDo = String(formularz.get("wrocDo") ?? `/t/${tenantId}/kampanie`);
  const { wznowWysylkeTenanta } = await import("../usecases/wysylka/reputacja");
  const { dodajZadanie } = await import("../jobs/kolejka");
  const wynik = await wznowWysylkeTenanta(tenantId);
  if (!wynik.wznowiony) {
    redirect(`${wrocDo}?blad=${encodeURIComponent("Wysyłka tego sklepu nie była wstrzymana")}`);
  }
  // Kampanie, których job zakończył się na wstrzymaniu, same z siebie nie ruszą —
  // job już się domknął. Bez tego wznowienie byłoby zdjęciem blokady i niczym więcej.
  for (const campaignId of wynik.doWznowienia) {
    await dodajZadanie(tenantId, "wyslij_kampanie", { campaignId });
  }
  revalidatePath(wrocDo);
  redirect(
    `${wrocDo}?ok=${encodeURIComponent(
      wynik.doWznowienia.length
        ? `Wysyłka sklepu wznowiona. Do kolejki wróciło ${wynik.doWznowienia.length} kampanii.`
        : "Wysyłka sklepu wznowiona.",
    )}`,
  );
}
