import type pg from "pg";
import { getPool } from "../../adapters/db/pool";
import { hashAdresu, zaslepkaWykluczenia } from "../../adapters/hash-adresu";
import { dodajZadanie } from "../../jobs/kolejka";
import type { PoleProfilu, PoleSupresji } from "./mapowanie";

/**
 * Przebiegi importu (tabela import_jobs z 0021). Kazde zapytanie ma jawny predykat
 * tenant_id (AD-2): identyfikator przebiegu z URL-a to deklaracja, nie dostep.
 *
 * SQL siedzi tutaj, a nie w repozytoria.ts, bo tamten plik nalezy do innego wlasciciela
 * w tej iteracji; po scaleniu zapytania moga tam wrocic jednym przeniesieniem.
 */

export type StatusPrzebiegu = "uploaded" | "mapped" | "suppressions" | "planned" | "running" | "done" | "failed";

export interface OpcjePrzebiegu {
  listId?: string | null;
  supresjePominiete?: boolean;
}

export interface PrzebiegImportu {
  id: string;
  tenant_id: string;
  status: StatusPrzebiegu;
  source: string;
  file_name: string;
  file_size: number;
  row_count: number;
  headers: string[];
  sample: string[][];
  mapping: PoleProfilu[];
  options: OpcjePrzebiegu;
  suppression_file_name: string | null;
  suppression_file_size: number | null;
  suppression_row_count: number | null;
  suppression_headers: string[] | null;
  suppression_sample: string[][] | null;
  suppression_mapping: PoleSupresji[] | null;
  planned: Record<string, unknown>;
  counters: Record<string, unknown>;
  error_count: number;
  started_at: Date | null;
  finished_at: Date | null;
  last_error: string | null;
  created_by: string | null;
  created_at: Date;
}

export interface BladPrzebiegu {
  file: "profiles" | "suppressions";
  line_no: number;
  email: string | null;
  reason: string;
}

const KOLUMNY = `id, tenant_id, status, source, file_name, file_size::int as file_size, row_count,
  headers, sample, mapping, options, suppression_file_name, suppression_file_size::int as suppression_file_size,
  suppression_row_count, suppression_headers, suppression_sample, suppression_mapping,
  planned, counters, error_count, started_at, finished_at, last_error, created_by, created_at`;

export async function utworzPrzebieg(
  tenantId: string,
  dane: {
    /** identyfikator nadany PRZED zapisem pliku: sciezka na dysku jest z niego budowana */
    id: string;
    fileName: string;
    fileSize: number;
    rowCount: number;
    headers: string[];
    sample: string[][];
    mapping: PoleProfilu[];
    createdBy: string | null;
    listId: string | null;
  },
  przez: pg.Pool | pg.PoolClient = getPool(),
): Promise<string> {
  const { rows } = await przez.query(
    `insert into import_jobs (id, tenant_id, file_name, file_size, row_count, headers, sample, mapping, options, created_by)
     values ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      tenantId,
      dane.fileName,
      dane.fileSize,
      dane.rowCount,
      JSON.stringify(dane.headers),
      JSON.stringify(dane.sample),
      JSON.stringify(dane.mapping),
      JSON.stringify({ listId: dane.listId }),
      dane.createdBy,
      dane.id,
    ],
  );
  return rows[0].id as string;
}

export async function przebieg(tenantId: string, jobId: string): Promise<PrzebiegImportu | null> {
  const { rows } = await getPool().query<PrzebiegImportu>(
    `select ${KOLUMNY} from import_jobs where tenant_id = $1 and id = $2`,
    [tenantId, jobId],
  );
  return rows[0] ?? null;
}

export async function przebiegiTenanta(tenantId: string, limit = 30): Promise<PrzebiegImportu[]> {
  const { rows } = await getPool().query<PrzebiegImportu>(
    `select ${KOLUMNY} from import_jobs where tenant_id = $1 order by created_at desc limit $2`,
    [tenantId, limit],
  );
  return rows;
}

/** Statusy, w ktorych kreator jeszcze nic nie zapisal do bazy odbiorcow i wolno cofac. */
const EDYTOWALNE: StatusPrzebiegu[] = ["uploaded", "mapped", "suppressions"];

export async function zapiszMapowanie(
  tenantId: string,
  jobId: string,
  mapping: PoleProfilu[],
  listId: string | null,
): Promise<boolean> {
  const wynik = await getPool().query(
    `update import_jobs
        set mapping = $3, options = options || $4::jsonb,
            status = case when status = 'uploaded' then 'mapped' else status end
      where tenant_id = $1 and id = $2 and status = any($5::text[])`,
    [tenantId, jobId, JSON.stringify(mapping), JSON.stringify({ listId }), EDYTOWALNE],
  );
  return (wynik.rowCount ?? 0) > 0;
}

export async function zapiszPlikSupresji(
  tenantId: string,
  jobId: string,
  dane: { fileName: string; fileSize: number; rowCount: number; headers: string[]; sample: string[][]; mapping: PoleSupresji[] },
): Promise<boolean> {
  const wynik = await getPool().query(
    `update import_jobs
        set suppression_file_name = $3, suppression_file_size = $4, suppression_row_count = $5,
            suppression_headers = $6, suppression_sample = $7, suppression_mapping = $8,
            options = options - 'supresjePominiete',
            status = case when status in ('mapped', 'suppressions') then 'mapped' else status end
      where tenant_id = $1 and id = $2 and status = any($9::text[])`,
    [tenantId, jobId, dane.fileName, dane.fileSize, dane.rowCount, JSON.stringify(dane.headers), JSON.stringify(dane.sample), JSON.stringify(dane.mapping), ["mapped", "suppressions"]],
  );
  return (wynik.rowCount ?? 0) > 0;
}

export async function zapiszMapowanieSupresji(tenantId: string, jobId: string, mapping: PoleSupresji[]): Promise<boolean> {
  const wynik = await getPool().query(
    `update import_jobs set suppression_mapping = $3, status = 'suppressions'
      where tenant_id = $1 and id = $2 and status in ('mapped', 'suppressions') and suppression_file_name is not null`,
    [tenantId, jobId, JSON.stringify(mapping)],
  );
  return (wynik.rowCount ?? 0) > 0;
}

/** Swiadome pominiecie kroku supresji: zapisane jako opcja, zeby raport to pamietal. */
export async function pominSupresje(tenantId: string, jobId: string): Promise<boolean> {
  const wynik = await getPool().query(
    `update import_jobs
        set options = options || '{"supresjePominiete": true}'::jsonb,
            suppression_file_name = null, suppression_file_size = null, suppression_row_count = null,
            suppression_headers = null, suppression_sample = null, suppression_mapping = null,
            status = 'suppressions'
      where tenant_id = $1 and id = $2 and status in ('mapped', 'suppressions')`,
    [tenantId, jobId],
  );
  return (wynik.rowCount ?? 0) > 0;
}

export async function zapiszPlan(tenantId: string, jobId: string, planned: Record<string, unknown>): Promise<void> {
  await getPool().query(
    `update import_jobs set planned = $3 where tenant_id = $1 and id = $2 and status = 'suppressions'`,
    [tenantId, jobId, JSON.stringify(planned)],
  );
}

/**
 * Start importu: przejscie w 'planned' i wpis do kolejki W JEDNEJ transakcji. Rozdzielenie
 * tych dwoch krokow to dokladnie blad #16 z audytu (kampania "w wysylce" bez joba).
 */
export async function zlecStart(tenantId: string, jobId: string): Promise<boolean> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const wynik = await klient.query(
      `update import_jobs set status = 'planned'
        where tenant_id = $1 and id = $2 and status = 'suppressions' and planned <> '{}'::jsonb`,
      [tenantId, jobId],
    );
    if (!wynik.rowCount) {
      await klient.query("rollback");
      return false;
    }
    await dodajZadanie(tenantId, "import_klaviyo", { jobId }, { przez: klient });
    await klient.query("commit");
    return true;
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
}

export async function bledyPrzebiegu(tenantId: string, jobId: string, limit = 50): Promise<BladPrzebiegu[]> {
  const { rows } = await getPool().query<BladPrzebiegu>(
    `select file, line_no, email, reason from import_job_errors
      where tenant_id = $1 and job_id = $2 order by file, line_no limit $3`,
    [tenantId, jobId, limit],
  );
  return rows;
}

export async function* wszystkieBledy(tenantId: string, jobId: string): AsyncGenerator<BladPrzebiegu> {
  const partia = 1000;
  let offset = 0;
  for (;;) {
    const { rows } = await getPool().query<BladPrzebiegu>(
      `select file, line_no, email, reason from import_job_errors
        where tenant_id = $1 and job_id = $2 order by file, line_no limit $3 offset $4`,
      [tenantId, jobId, partia, offset],
    );
    for (const r of rows) yield r;
    if (rows.length < partia) return;
    offset += partia;
  }
}

/** Listy tenanta do wyboru w kreatorze (nazwa + liczebnosc). */
export async function listyDoWyboru(tenantId: string): Promise<{ id: string; name: string; czlonkow: number }[]> {
  const { rows } = await getPool().query(
    `select l.id, l.name,
            (select count(*)::int from list_members m where m.tenant_id = l.tenant_id and m.list_id = l.id) as czlonkow
       from lists l where l.tenant_id = $1 order by l.name`,
    [tenantId],
  );
  return rows;
}

/**
 * Sciezka RODO (art. 17) dla danych importu, do wywolania z anonimizujProfil:
 * adres w raporcie bledow zamienia sie na te sama zaslepke co w wykluczeniach
 * (`anonimizowano:<16 znakow hasza>`), a w probkach jeszcze otwartych przebiegow
 * kazda komorka rowna adresowi dostaje zaslepke. Zakonczone przebiegi nie maja
 * probek (czyszczone przy done/failed) ani plikow (kasowane przy done).
 * Zwraca liczby faktycznie zmienionych wierszy.
 */
export async function anonimizujWImporcie(
  tenantId: string,
  email: string,
  przez: pg.Pool | pg.PoolClient = getPool(),
): Promise<{ bledy: number; probki: number }> {
  const klucz = email.trim().toLowerCase();
  const zaslepka = zaslepkaWykluczenia(hashAdresu(email));
  const b = await przez.query(
    `update import_job_errors set email = $3
      where tenant_id = $1 and lower(btrim(email)) = $2 and email <> $3`,
    [tenantId, klucz, zaslepka],
  );
  const { rows } = await przez.query<{ id: string; sample: string[][]; suppression_sample: string[][] | null }>(
    `select id, sample, suppression_sample from import_jobs
      where tenant_id = $1 and status not in ('done', 'failed')
        and (sample::text ilike $2 or coalesce(suppression_sample::text, '') ilike $2)`,
    [tenantId, `%${klucz.replace(/[\\%_]/g, (m) => `\\${m}`)}%`],
  );
  let probki = 0;
  for (const r of rows) {
    const zamien = (probka: string[][] | null) =>
      probka ? probka.map((w) => w.map((k) => (k.trim().toLowerCase() === klucz ? zaslepka : k))) : null;
    const sample = zamien(r.sample);
    const supresje = zamien(r.suppression_sample);
    const w = await przez.query(
      `update import_jobs set sample = $3, suppression_sample = $4 where tenant_id = $1 and id = $2`,
      [tenantId, r.id, JSON.stringify(sample), supresje ? JSON.stringify(supresje) : null],
    );
    probki += w.rowCount ?? 0;
  }
  return { bledy: b.rowCount ?? 0, probki };
}
