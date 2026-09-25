import { NextResponse } from "next/server";
import { wierszCsv } from "../../../../../../usecases/import-klaviyo/csv";
import { przebieg, wszystkieBledy } from "../../../../../../usecases/import-klaviyo/zadania";
import { wymaganyTenant } from "../../../../../autoryzacja";

/**
 * Lista bledow przebiegu jako CSV. POST z formularza (jak eksport profilu): GET-y
 * bywaja prefetchowane. Kazde pole przechodzi przez poleCsv, wiec adres zaczynajacy sie
 * od "=" albo "@" nie stanie sie formula w arkuszu (CSV injection).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_zadanie: Request, ctx: { params: Promise<{ tenantId: string; jobId: string }> }) {
  const { tenantId: zadany, jobId } = await ctx.params;
  const { tenantId } = await wymaganyTenant(zadany);
  if (!UUID.test(jobId)) return new NextResponse("Nie znaleziono importu", { status: 404 });
  const job = await przebieg(tenantId, jobId);
  if (!job) return new NextResponse("Nie znaleziono importu", { status: 404 });

  const koder = new TextEncoder();
  const strumien = new ReadableStream<Uint8Array>({
    async start(kontroler) {
      try {
        kontroler.enqueue(koder.encode("﻿" + wierszCsv(["Plik", "Linia", "Adres", "Powód"])));
        for await (const b of wszystkieBledy(tenantId, job.id)) {
          kontroler.enqueue(koder.encode(wierszCsv([b.file === "profiles" ? "profile" : "wykluczenia", b.line_no, b.email, b.reason])));
        }
        kontroler.close();
      } catch (blad) {
        kontroler.error(blad);
      }
    },
  });
  const dzis = new Date().toISOString().slice(0, 10);
  return new NextResponse(strumien, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="import-bledy-${job.id.slice(0, 8)}-${dzis}.csv"`,
      "cache-control": "no-store",
    },
  });
}
