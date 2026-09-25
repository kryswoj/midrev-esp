import { NextResponse } from "next/server";
import { eksportujListe, listaTenanta } from "../../../../../../usecases/listy/czlonkowie";
import { wymaganyTenant } from "../../../../../autoryzacja";

/**
 * Eksport listy do CSV (naglowki w konwencji Klaviyo, zeby plik dalo sie wgrac gdzie
 * indziej). POST z formularza, nie GET: dane osobowe nie moga wyjsc na prefetch.
 * Strumien partiami, nie tablica w pamieci. Pola przez poleCsv (CSV injection).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_zadanie: Request, ctx: { params: Promise<{ tenantId: string; listId: string }> }) {
  const { tenantId: zadany, listId } = await ctx.params;
  const { tenantId } = await wymaganyTenant(zadany);
  if (!UUID.test(listId)) return new NextResponse("Nie znaleziono listy", { status: 404 });
  const lista = await listaTenanta(tenantId, listId);
  if (!lista) return new NextResponse("Nie znaleziono listy", { status: 404 });

  const koder = new TextEncoder();
  const strumien = new ReadableStream<Uint8Array>({
    async start(kontroler) {
      try {
        kontroler.enqueue(koder.encode("﻿"));
        for await (const linia of eksportujListe(tenantId, listId)) kontroler.enqueue(koder.encode(linia));
        kontroler.close();
      } catch (blad) {
        kontroler.error(blad);
      }
    },
  });
  const nazwa = lista.name.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 60) || "lista";
  const dzis = new Date().toISOString().slice(0, 10);
  return new NextResponse(strumien, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="lista-${nazwa}-${dzis}.csv"`,
      "cache-control": "no-store",
    },
  });
}
