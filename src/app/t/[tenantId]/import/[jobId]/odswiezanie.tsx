"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Odswieza dane serwera co 2 s, dopoki import trwa. Bez WebSocketow: RSC refresh wystarcza. */
export function Odswiezanie({ aktywne }: { aktywne: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!aktywne) return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [aktywne, router]);
  return null;
}
