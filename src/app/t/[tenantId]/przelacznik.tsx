"use client";

import { useRouter } from "next/navigation";

/**
 * Operator pracuje na wielu klientach naraz i przełącza się między nimi w jedno
 * kliknięcie (FR2). To odstępstwo od typowego SaaS, gdzie użytkownik należy do jednego
 * workspace, dlatego przełącznik siedzi na samej górze nawigacji, a nie w ustawieniach.
 */
export function PrzelacznikTenanta({
  tenanci,
  biezacyId,
}: {
  tenanci: { id: string; name: string }[];
  biezacyId: string;
}) {
  const router = useRouter();
  return (
    <label className="block px-0.5">
      <span className="sr-only">Klient</span>
      <select
        className="pole"
        value={biezacyId}
        onChange={(e) => router.push(`/t/${e.target.value}`)}
      >
        {tenanci.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
