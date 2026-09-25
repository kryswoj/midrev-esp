import type pg from "pg";
import { getPool } from "../../adapters/db/pool";
import { hashAdresu } from "../../adapters/hash-adresu";
import { dopasuj } from "./analiza";
import { czytajCsv } from "./csv";
import type { PoleProfilu } from "./mapowanie";
import { otworzPlik, plikIstnieje, sciezkaPliku, usunPlik } from "./pliki";
import { globalnieWykluczone, przeczytajSupresje, wykluczoneWSklepie } from "./podglad";
import { normalizujWiersz, POWOD_SUPRESJI, type RodzajSupresji, type WierszProfilu } from "./wiersz";
import type { BladPrzebiegu, PrzebiegImportu } from "./zadania";

/**
 * Wykonanie importu (handler joba `import_klaviyo`). Idempotentne, bo kazdy zapis jest
 * albo upsertem, albo insertem chronionym unikalnoscia / not exists: ponowione zadanie
 * (at-least-once, AD-5) ani drugi import tego samego pliku niczego nie dubluje.
 *
 * Kolejnosc jest celowa: NAJPIERW plik supresji, POTEM profile. Osoba, ktora jest w obu
 * (eksport listy pokazuje ja jako SUBSCRIBED, a eksport supresji jako wypisana), ma po
 * imporcie byc wykluczona - sprawdzenie rejestru wykluczen w fazie profili juz ja widzi.
 *
 * Liczniki: kazdy zapis raportuje rowCount (faktyczny wynik INSERT-a po ON CONFLICT),
 * a po zakonczeniu osobny odczyt zwrotny z bazy liczy stan koncowy. Oba trafiaja do
 * `counters` i ekran pokazuje oba.
 */

const PARTIA = 500;
const MAKS_BLEDOW_W_BAZIE = 5000;

export interface LicznikiImportu {
  przetworzone: number;
  wierszy: number;
  bledy: number;
  duplikaty: number;
  profileNowe: number;
  profileZaktualizowane: number;
  zgodyNadane: number;
  zgodyJuzByly: number;
  zgodyWycofane: number;
  bezZgody: number;
  pominieteGlobalnie: number;
  pominieteWSklepie: number;
  pominietePlikSupresji: number;
  wypisyZapisane: number;
  doListyDodane: number;
  supresje: {
    wierszy: number;
    bledy: number;
    lokalneZapisane: number;
    lokalneJuzByly: number;
    globalneZapisane: number;
    globalneJuzByly: number;
  } | null;
  /** odczyt zwrotny z bazy po zakonczeniu */
  odczyt: {
    profileWBazie: number;
    zgodyZTegoPrzebiegu: number;
    wycofaniaZTegoPrzebiegu: number;
    wypisyZTegoPrzebiegu: number;
    naLiscieZTegoPrzebiegu: number;
    naLiscieRazem: number | null;
    bledowZapisanych: number;
  } | null;
  trwaloSek: number | null;
}

function puste(): LicznikiImportu {
  return {
    przetworzone: 0, wierszy: 0, bledy: 0, duplikaty: 0, profileNowe: 0, profileZaktualizowane: 0,
    zgodyNadane: 0, zgodyJuzByly: 0, zgodyWycofane: 0, bezZgody: 0, pominieteGlobalnie: 0, pominieteWSklepie: 0,
    pominietePlikSupresji: 0, wypisyZapisane: 0, doListyDodane: 0, supresje: null, odczyt: null, trwaloSek: null,
  };
}

class ZbieraczBledow {
  private bufor: BladPrzebiegu[] = [];
  public razem = 0;
  public zapisane = 0;
  constructor(private tenantId: string, private jobId: string) {}
  dodaj(b: BladPrzebiegu) {
    this.razem += 1;
    if (this.zapisane + this.bufor.length >= MAKS_BLEDOW_W_BAZIE) return;
    this.bufor.push(b);
  }
  async zrzuc(przez: pg.Pool | pg.PoolClient) {
    if (!this.bufor.length) return;
    const b = this.bufor;
    this.bufor = [];
    await przez.query(
      `insert into import_job_errors (tenant_id, job_id, file, line_no, email, reason)
       select $1, $2, f, l, e, r from unnest($3::text[], $4::int[], $5::text[], $6::text[]) as u(f, l, e, r)`,
      [this.tenantId, this.jobId, b.map((x) => x.file), b.map((x) => x.line_no), b.map((x) => x.email), b.map((x) => x.reason)],
    );
    this.zapisane += b.length;
  }
}

async function zapiszPostep(tenantId: string, jobId: string, liczniki: LicznikiImportu) {
  await getPool().query(
    `update import_jobs set counters = $3, error_count = $4 where tenant_id = $1 and id = $2`,
    [tenantId, jobId, JSON.stringify(liczniki), liczniki.bledy + (liczniki.supresje?.bledy ?? 0)],
  );
}

/** Faza 1: plik supresji -> tenant_suppressions (wypisy, reczne) i suppressions (skargi, odbicia). */
async function wykonajSupresje(tenantId: string, job: PrzebiegImportu, liczniki: LicznikiImportu, bledy: ZbieraczBledow, aktor: string) {
  if (!job.suppression_file_name || !job.suppression_mapping) return new Map<string, RodzajSupresji>();
  const sciezka = sciezkaPliku(tenantId, job.id, "suppressions");
  if (!(await plikIstnieje(sciezka))) throw new Error("Plik supresji zniknął z dysku.");
  const s = await przeczytajSupresje(sciezka, job.suppression_mapping);
  liczniki.supresje = { wierszy: s.wierszy, bledy: s.bledy, lokalneZapisane: 0, lokalneJuzByly: 0, globalneZapisane: 0, globalneJuzByly: 0 };

  // bledy per wiersz: drugie przejscie tylko po to, zeby miec numery linii (plik supresji
  // jest maly - to lista wypisow, nie cala baza)
  {
    const { czytajCsv: czytaj } = await import("./csv");
    const { normalizujWierszSupresji } = await import("./wiersz");
    let pierwszy = true;
    for await (const rekord of czytaj(otworzPlik(sciezka))) {
      if (pierwszy) { pierwszy = false; continue; }
      if (rekord.blad) { bledy.dodaj({ file: "suppressions", line_no: rekord.linia, email: null, reason: rekord.blad }); continue; }
      const w = normalizujWierszSupresji(rekord.linia, dopasuj(rekord.pola, job.suppression_mapping.length), job.suppression_mapping);
      if (!w.ok) bledy.dodaj({ file: "suppressions", line_no: w.linia, email: w.email, reason: w.powod });
    }
  }

  const wpisy = [...s.rodzaje.entries()];
  const dataDomyslna = job.created_at;
  for (let i = 0; i < wpisy.length; i += PARTIA) {
    const partia = wpisy.slice(i, i + PARTIA);
    const lokalne = partia.filter(([, r]) => !POWOD_SUPRESJI[r].globalna);
    const globalne = partia.filter(([, r]) => POWOD_SUPRESJI[r].globalna);
    const klient = await getPool().connect();
    try {
      await klient.query("begin");
      if (lokalne.length) {
        // not exists po (adres, powod, data): drugi import tego samego pliku nie dopisuje
        // drugiego identycznego wpisu, a rejestr zostaje append-only
        const w = await klient.query(
          // Bez daty ze zrodla wpis dostaje date przebiegu, ktora w kazdym przebiegu jest
          // inna - dlatego wtedy deduplikacja idzie po (adres, powod) bez daty (u.zr = false).
          `insert into tenant_suppressions (tenant_id, email, action, reason, actor, occurred_at)
           select $1, u.e, 'suppressed', u.r, $2, u.d
             from unnest($3::text[], $4::text[], $5::timestamptz[], $6::boolean[]) as u(e, r, d, zr)
            where not exists (
              select 1 from tenant_suppressions t
               where t.tenant_id = $1 and lower(btrim(t.email)) = lower(btrim(u.e))
                 and t.action = 'suppressed' and t.reason = u.r and (t.occurred_at = u.d or not u.zr)
            )`,
          [tenantId, aktor, lokalne.map(([k]) => k), lokalne.map(([, r]) => POWOD_SUPRESJI[r].reason), lokalne.map(([k]) => s.daty.get(k) ?? dataDomyslna), lokalne.map(([k]) => Boolean(s.daty.get(k)))],
        );
        liczniki.supresje.lokalneZapisane += w.rowCount ?? 0;
        liczniki.supresje.lokalneJuzByly += lokalne.length - (w.rowCount ?? 0);
      }
      if (globalne.length) {
        // Deduplikacja po adresie ALBO po haszu (0022): adres zanonimizowany po RODO
        // siedzi na liscie jako sam hasz i NIE wolno dopisac go drugi raz jawnie -
        // to bylaby ponowna identyfikacja osoby, ktora zazadala usuniecia danych.
        const juz = await globalnieWykluczone(globalne.map(([k]) => k));
        const nowe = globalne.filter(([k]) => !juz.has(k));
        liczniki.supresje.globalneJuzByly += globalne.length - nowe.length;
        if (nowe.length) {
          // email_hash od razu, zeby wpis przezyl przyszla anonimizacje tak samo jak
          // wpisy z odbic na zywo
          const w = await klient.query(
            `insert into suppressions (email, reason, email_hash)
             select u.e, u.r, u.h from unnest($1::text[], $2::text[], $3::text[]) as u(e, r, h)
             on conflict ((lower(btrim(email)))) do nothing`,
            [nowe.map(([k]) => k), nowe.map(([, r]) => POWOD_SUPRESJI[r].reason), nowe.map(([k]) => hashAdresu(k))],
          );
          liczniki.supresje.globalneZapisane += w.rowCount ?? 0;
          liczniki.supresje.globalneJuzByly += nowe.length - (w.rowCount ?? 0);
        }
      }
      await bledy.zrzuc(klient);
      await klient.query("commit");
    } catch (blad) {
      await klient.query("rollback");
      throw blad;
    } finally {
      klient.release();
    }
  }
  await bledy.zrzuc(getPool());
  await zapiszPostep(tenantId, job.id, liczniki);
  return s.rodzaje;
}

interface Partia {
  wiersze: WierszProfilu[];
}

async function zapiszPartie(
  tenantId: string,
  job: PrzebiegImportu,
  partia: Partia,
  kluczeSupresji: Map<string, RodzajSupresji>,
  liczniki: LicznikiImportu,
  bledy: ZbieraczBledow,
  aktor: string,
) {
  const w = partia.wiersze;
  if (!w.length) return;
  const klucze = w.map((x) => x.klucz);
  // wykluczenia sprawdzane PRZED zapisem zgody, w tej samej partii: globalna lista wygrywa
  // z plikiem, wypis z tego sklepu tez (zdjecie wykluczenia to decyzja administratora, FR30)
  const [globalne, lokalne] = await Promise.all([globalnieWykluczone(klucze), wykluczoneWSklepie(tenantId, klucze)]);

  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const profile = await klient.query<{ id: string; klucz: string; nowy: boolean }>(
      `insert into profiles (tenant_id, email, first_name, last_name, phone, properties)
       select $1, u.e, u.f, u.l, u.p, u.pr::jsonb
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as u(e, f, l, p, pr)
       on conflict (tenant_id, (lower(btrim(email)))) where email is not null
       do update set
         first_name = coalesce(profiles.first_name, excluded.first_name),
         last_name  = coalesce(profiles.last_name, excluded.last_name),
         phone      = coalesce(profiles.phone, excluded.phone),
         properties = profiles.properties || excluded.properties
       returning id, lower(btrim(email)) as klucz, (xmax = 0) as nowy`,
      [tenantId, w.map((x) => x.email), w.map((x) => x.imie), w.map((x) => x.nazwisko), w.map((x) => x.telefon), w.map((x) => JSON.stringify(x.wlasciwosci))],
    );
    const idPoKluczu = new Map(profile.rows.map((r) => [r.klucz, r.id]));
    for (const r of profile.rows) {
      if (r.nowy) liczniki.profileNowe += 1;
      else liczniki.profileZaktualizowane += 1;
    }

    const zgody: { pid: string; md: string; occ: Date }[] = [];
    const wycofania: { pid: string; md: string; occ: Date }[] = [];
    const wypisy: { email: string; reason: string; occ: Date; zeZrodla: boolean }[] = [];
    for (const x of w) {
      const pid = idPoKluczu.get(x.klucz);
      if (!pid) {
        bledy.dodaj({ file: "profiles", line_no: x.linia, email: x.email, reason: "profil nie powstał (kolizja tożsamości)" });
        continue;
      }
      const md = x.zrodlo ? `klaviyo: ${x.zrodlo}` : "klaviyo";
      if (x.zgoda === "granted" && x.zgodaData) {
        if (globalne.has(x.klucz)) liczniki.pominieteGlobalnie += 1;
        else if (lokalne.has(x.klucz)) liczniki.pominieteWSklepie += 1;
        else if (kluczeSupresji.has(x.klucz)) liczniki.pominietePlikSupresji += 1;
        else zgody.push({ pid, md, occ: x.zgodaData });
      } else if (x.zgoda === "unsubscribed" || x.supresja) {
        const occ = x.zgodaData ?? job.created_at;
        wypisy.push({ email: x.email, reason: x.supresja ? "supresja e-mail w Klaviyo" : "wypisanie w Klaviyo", occ, zeZrodla: Boolean(x.zgodaData) });
        if (x.zgoda === "unsubscribed" && x.zgodaData) wycofania.push({ pid, md, occ: x.zgodaData });
      } else {
        liczniki.bezZgody += 1;
      }
    }

    if (zgody.length) {
      const r = await klient.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, method_detail, occurred_at, import_job_id)
         select $1, u.pid, 'email', 'granted', 'import', u.md, u.occ, $2
           from unnest($3::uuid[], $4::text[], $5::timestamptz[]) as u(pid, md, occ)
         on conflict (tenant_id, profile_id, channel, state, occurred_at) where source = 'import' do nothing`,
        [tenantId, job.id, zgody.map((z) => z.pid), zgody.map((z) => z.md), zgody.map((z) => z.occ)],
      );
      liczniki.zgodyNadane += r.rowCount ?? 0;
      liczniki.zgodyJuzByly += zgody.length - (r.rowCount ?? 0);
    }
    if (wycofania.length) {
      const r = await klient.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, method_detail, occurred_at, import_job_id)
         select $1, u.pid, 'email', 'withdrawn', 'import', u.md, u.occ, $2
           from unnest($3::uuid[], $4::text[], $5::timestamptz[]) as u(pid, md, occ)
         on conflict (tenant_id, profile_id, channel, state, occurred_at) where source = 'import' do nothing`,
        [tenantId, job.id, wycofania.map((z) => z.pid), wycofania.map((z) => z.md), wycofania.map((z) => z.occ)],
      );
      liczniki.zgodyWycofane += r.rowCount ?? 0;
    }
    if (wypisy.length) {
      const r = await klient.query(
        `insert into tenant_suppressions (tenant_id, email, action, reason, actor, occurred_at)
         select $1, u.e, 'suppressed', u.r, $2, u.d
           from unnest($3::text[], $4::text[], $5::timestamptz[], $6::boolean[]) as u(e, r, d, zr)
          where not exists (
            select 1 from tenant_suppressions t
             where t.tenant_id = $1 and lower(btrim(t.email)) = lower(btrim(u.e))
               and t.action = 'suppressed' and t.reason = u.r and (t.occurred_at = u.d or not u.zr)
          )`,
        [tenantId, aktor, wypisy.map((x) => x.email), wypisy.map((x) => x.reason), wypisy.map((x) => x.occ), wypisy.map((x) => x.zeZrodla)],
      );
      liczniki.wypisyZapisane += r.rowCount ?? 0;
    }
    if (job.options.listId) {
      const r = await klient.query(
        `insert into list_members (tenant_id, list_id, profile_id, source)
         select $1, $2, u.pid, $3 from unnest($4::uuid[]) as u(pid)
         on conflict (list_id, profile_id) do nothing`,
        // przedrostek źródła decyduje, czy dodanie odpali automatyzację „dołączenie do listy":
        // import jest MASOWY i domyślnie jej nie odpala (review flow 24.09, B#1)
        [tenantId, job.options.listId, `import_klaviyo:${aktor}`, profile.rows.map((p) => p.id)],
      );
      liczniki.doListyDodane += r.rowCount ?? 0;
    }
    await bledy.zrzuc(klient);
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
}

async function odczytZwrotny(tenantId: string, job: PrzebiegImportu, klucze: string[], aktor: string, bledy: ZbieraczBledow) {
  const pool = getPool();
  let profileWBazie = 0;
  for (let i = 0; i < klucze.length; i += 5000) {
    const { rows } = await pool.query(
      "select count(*)::int as n from profiles where tenant_id = $1 and lower(btrim(email)) = any($2::text[])",
      [tenantId, klucze.slice(i, i + 5000)],
    );
    profileWBazie += rows[0].n;
  }
  const { rows: z } = await pool.query(
    `select count(*) filter (where state = 'granted')::int as nadane,
            count(*) filter (where state = 'withdrawn')::int as wycofane
       from consents where tenant_id = $1 and import_job_id = $2`,
    [tenantId, job.id],
  );
  const { rows: w } = await pool.query(
    "select count(*)::int as n from tenant_suppressions where tenant_id = $1 and actor = $2",
    [tenantId, aktor],
  );
  let naLiscieZTegoPrzebiegu = 0;
  let naLiscieRazem: number | null = null;
  if (job.options.listId) {
    const { rows } = await pool.query(
      `select count(*) filter (where source = $3)::int as z_przebiegu, count(*)::int as razem
         from list_members where tenant_id = $1 and list_id = $2`,
      [tenantId, job.options.listId, `import_klaviyo:${aktor}`],
    );
    naLiscieZTegoPrzebiegu = rows[0].z_przebiegu;
    naLiscieRazem = rows[0].razem;
  }
  const { rows: b } = await pool.query(
    "select count(*)::int as n from import_job_errors where tenant_id = $1 and job_id = $2",
    [tenantId, job.id],
  );
  return {
    profileWBazie,
    zgodyZTegoPrzebiegu: z[0].nadane,
    wycofaniaZTegoPrzebiegu: z[0].wycofane,
    wypisyZTegoPrzebiegu: w[0].n,
    naLiscieZTegoPrzebiegu,
    naLiscieRazem,
    bledowZapisanych: b[0].n,
  };
}

export async function wykonajImport(tenantId: string, jobId: string): Promise<LicznikiImportu | null> {
  const pool = getPool();
  // przejecie zadania: tylko z planned (pierwsze podejscie), running (ponowienie po
  // padzie workera) albo failed (ponowienie po bledzie przejsciowym). done nie rusza.
  const { rows } = await pool.query<PrzebiegImportu>(
    `update import_jobs
        set status = 'running', started_at = coalesce(started_at, now()), last_error = null
      where tenant_id = $1 and id = $2 and status in ('planned', 'running', 'failed')
      returning *`,
    [tenantId, jobId],
  );
  const job = rows[0];
  if (!job) return null;
  const start = Date.now();
  const aktor = `import:${job.id}`;
  const liczniki = puste();
  const bledy = new ZbieraczBledow(tenantId, job.id);

  try {
    // ponowienie zaczyna od czystej listy bledow TEGO przebiegu (zakres ograniczony do joba)
    await pool.query("delete from import_job_errors where tenant_id = $1 and job_id = $2", [tenantId, job.id]);

    const kluczeSupresji = await wykonajSupresje(tenantId, job, liczniki, bledy, aktor);

    const sciezka = sciezkaPliku(tenantId, job.id, "profiles");
    if (!(await plikIstnieje(sciezka))) throw new Error("Plik profili zniknął z dysku. Wgraj go ponownie.");
    const mapowanie = job.mapping as PoleProfilu[];
    const naglowki = job.headers;
    const widziane = new Set<string>();
    let partia: Partia = { wiersze: [] };
    let pierwszy = true;
    let odOstatniegoPostepu = 0;

    for await (const rekord of czytajCsv(otworzPlik(sciezka))) {
      if (pierwszy) { pierwszy = false; continue; }
      liczniki.wierszy += 1;
      liczniki.przetworzone += 1;
      if (rekord.blad) {
        liczniki.bledy += 1;
        bledy.dodaj({ file: "profiles", line_no: rekord.linia, email: null, reason: rekord.blad });
        continue;
      }
      const w = normalizujWiersz(rekord.linia, dopasuj(rekord.pola, naglowki.length), mapowanie, naglowki);
      if (!w.ok) {
        liczniki.bledy += 1;
        bledy.dodaj({ file: "profiles", line_no: w.linia, email: w.email, reason: w.powod });
        continue;
      }
      if (widziane.has(w.wiersz.klucz)) {
        liczniki.duplikaty += 1;
        continue;
      }
      widziane.add(w.wiersz.klucz);
      partia.wiersze.push(w.wiersz);
      if (partia.wiersze.length >= PARTIA) {
        await zapiszPartie(tenantId, job, partia, kluczeSupresji, liczniki, bledy, aktor);
        partia = { wiersze: [] };
        odOstatniegoPostepu += PARTIA;
        if (odOstatniegoPostepu >= 2000) {
          await zapiszPostep(tenantId, job.id, liczniki);
          odOstatniegoPostepu = 0;
        }
      }
    }
    await zapiszPartie(tenantId, job, partia, kluczeSupresji, liczniki, bledy, aktor);
    await bledy.zrzuc(pool);

    liczniki.odczyt = await odczytZwrotny(tenantId, job, [...widziane], aktor, bledy);
    liczniki.trwaloSek = Math.round((Date.now() - start) / 10) / 100;
    // Po zakonczeniu probki wierszy (adresy, nazwiska) i wgrane pliki przestaja byc
    // potrzebne, a zostawione lezalyby poza sciezka RODO (audyt: anonimizacja ich nie
    // widzi). Kasujemy je razem z domknieciem przebiegu; raport zyje na licznikach.
    await pool.query(
      `update import_jobs
          set status = 'done', finished_at = now(), counters = $3, error_count = $4,
              sample = '[]'::jsonb, suppression_sample = null
        where tenant_id = $1 and id = $2 and status = 'running'`,
      [tenantId, job.id, JSON.stringify(liczniki), bledy.razem],
    );
    await usunPlik(sciezka);
    if (job.suppression_file_name) await usunPlik(sciezkaPliku(tenantId, job.id, "suppressions"));
    return liczniki;
  } catch (blad) {
    const tresc = blad instanceof Error ? blad.message : String(blad);
    await bledy.zrzuc(pool).catch(() => undefined);
    // probki znikaja takze przy bledzie; pliki zostaja, bo ponowienie ich potrzebuje
    await pool.query(
      `update import_jobs
          set status = 'failed', last_error = $3, finished_at = now(), counters = $4, error_count = $5,
              sample = '[]'::jsonb, suppression_sample = null
        where tenant_id = $1 and id = $2 and status = 'running'`,
      [tenantId, job.id, tresc, JSON.stringify(liczniki), bledy.razem],
    );
    throw blad;
  }
}
