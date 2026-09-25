"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../autoryzacja";
import {
  jestPolemProfilu,
  jestPolemSupresji,
  sprawdzMapowanie,
  sprawdzMapowanieSupresji,
  type PoleProfilu,
  type PoleSupresji,
} from "../../../../usecases/import-klaviyo/mapowanie";
import { pominSupresje, przebieg, zapiszMapowanie, zapiszMapowanieSupresji, zlecStart } from "../../../../usecases/import-klaviyo/zadania";
import { listaTenanta } from "../../../../usecases/listy/czlonkowie";

/**
 * Server actions kreatora importu. Kazda zaczyna od wymaganyTenant (AD-21) i sprawdza,
 * ze przebieg nalezy do tenanta (przebieg() ma predykat tenant_id). Identyfikatory z
 * formularza to deklaracje: UUID sprawdzany przed pierwszym zapytaniem, zeby smiec
 * konczyl sie kontrolowana odmowa, nie bledem Postgresa (audyt #17).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function baza(tenantId: string) {
  return `/t/${tenantId}/import`;
}

function wroc(sciezka: string, pola: { ok?: string; blad?: string; uwaga?: string }): never {
  const q = new URLSearchParams();
  if (pola.blad) q.set("blad", pola.blad);
  if (pola.ok) q.set("ok", pola.ok);
  if (pola.uwaga) q.set("uwaga", pola.uwaga);
  redirect(`${sciezka}?${q.toString()}`);
}

async function przebiegZFormularza(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const jobId = String(f.get("jobId") ?? "");
  if (!UUID.test(jobId)) wroc(baza(tenantId), { blad: "Nie ma takiego importu." });
  const job = await przebieg(tenantId, jobId);
  if (!job) wroc(baza(tenantId), { blad: "Nie ma takiego importu." });
  return { tenantId, job };
}

export async function zapiszMapowanieAkcja(f: FormData) {
  const { tenantId, job } = await przebiegZFormularza(f);
  const sciezka = `${baza(tenantId)}/${job.id}/mapowanie`;
  if (!["uploaded", "mapped", "suppressions"].includes(job.status)) wroc(`${baza(tenantId)}/${job.id}`, { blad: "Ten import już wystartował; mapowania nie da się zmienić." });

  const mapowanie: PoleProfilu[] = [];
  for (let i = 0; i < job.headers.length; i += 1) {
    const w = f.get(`kol-${i}`);
    if (!jestPolemProfilu(w)) wroc(sciezka, { blad: `Kolumna ${i + 1} ma nieznane przypisanie.` });
    mapowanie.push(w);
  }
  const listaSurowa = String(f.get("listId") ?? "");
  let listId: string | null = null;
  if (listaSurowa) {
    if (!UUID.test(listaSurowa) || !(await listaTenanta(tenantId, listaSurowa))) wroc(sciezka, { blad: "Wybrana lista nie istnieje." });
    listId = listaSurowa;
  }

  const wynik = sprawdzMapowanie(mapowanie, job.headers);
  if (!wynik.ok) {
    // mapowanie zapisujemy mimo bledu, zeby operator nie tracil pracy (audyt B4)
    await zapiszMapowanie(tenantId, job.id, mapowanie, listId);
    wroc(sciezka, { blad: wynik.bledy.join(" ") });
  }
  await zapiszMapowanie(tenantId, job.id, mapowanie, listId);
  revalidatePath(sciezka);
  if (wynik.ostrzezenia.length && f.get("potwierdzam") !== "tak") {
    // ostrzezenie wymaga swiadomego potwierdzenia: strona pokaze je przy zapisanym mapowaniu
    wroc(sciezka, { uwaga: "1" });
  }
  redirect(`${baza(tenantId)}/${job.id}/supresje`);
}

export async function zapiszSupresjeAkcja(f: FormData) {
  const { tenantId, job } = await przebiegZFormularza(f);
  const sciezka = `${baza(tenantId)}/${job.id}/supresje`;
  if (!["mapped", "suppressions"].includes(job.status)) wroc(`${baza(tenantId)}/${job.id}`, { blad: "Ten import już wystartował." });
  if (!job.suppression_headers) wroc(sciezka, { blad: "Najpierw wgraj plik supresji albo świadomie pomiń ten krok." });

  const mapowanie: PoleSupresji[] = [];
  for (let i = 0; i < job.suppression_headers.length; i += 1) {
    const w = f.get(`skol-${i}`);
    if (!jestPolemSupresji(w)) wroc(sciezka, { blad: `Kolumna ${i + 1} ma nieznane przypisanie.` });
    mapowanie.push(w);
  }
  const wynik = sprawdzMapowanieSupresji(mapowanie, job.suppression_headers);
  if (!wynik.ok) wroc(sciezka, { blad: wynik.bledy.join(" ") });
  if (!(await zapiszMapowanieSupresji(tenantId, job.id, mapowanie))) wroc(sciezka, { blad: "Nie udało się zapisać mapowania supresji. Odśwież stronę." });
  revalidatePath(sciezka);
  redirect(`${baza(tenantId)}/${job.id}/podglad`);
}

export async function pominSupresjeAkcja(f: FormData) {
  const { tenantId, job } = await przebiegZFormularza(f);
  const sciezka = `${baza(tenantId)}/${job.id}/supresje`;
  if (!["mapped", "suppressions"].includes(job.status)) wroc(`${baza(tenantId)}/${job.id}`, { blad: "Ten import już wystartował." });
  if (f.get("rozumiem") !== "tak") wroc(sciezka, { blad: "Żeby pominąć wypisy i skargi, zaznacz, że rozumiesz ryzyko." });
  if (!(await pominSupresje(tenantId, job.id))) wroc(sciezka, { blad: "Nie udało się zapisać decyzji. Odśwież stronę." });
  revalidatePath(sciezka);
  redirect(`${baza(tenantId)}/${job.id}/podglad`);
}

export async function uruchomImportAkcja(f: FormData) {
  const { tenantId, job } = await przebiegZFormularza(f);
  if (job.status !== "suppressions") wroc(`${baza(tenantId)}/${job.id}`, { blad: job.status === "planned" || job.status === "running" ? "Ten import już się wykonuje." : "Ten import nie jest gotowy do startu." });
  if (!(await zlecStart(tenantId, job.id))) wroc(`${baza(tenantId)}/${job.id}/podglad`, { blad: "Podgląd nie został policzony. Otwórz go ponownie i uruchom import." });
  revalidatePath(baza(tenantId));
  redirect(`${baza(tenantId)}/${job.id}?ok=${encodeURIComponent("Import uruchomiony. Wykonuje go proces w tle; ta strona odświeża się sama.")}`);
}
