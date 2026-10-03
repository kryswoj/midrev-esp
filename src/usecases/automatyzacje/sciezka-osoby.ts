import { getPool } from "../../adapters/db/pool";
import { schematGrafu, tytulWezla, wezel, type Graf } from "../../domain/automatyzacje/graf";

/**
 * "Sciezka osoby" (pomysl z edrone: wpisujesz adres i widzisz, jak TEN czlowiek przeszedl
 * przez automatyzacje). Czyta flow_participants + flow_transitions, tlumaczy identyfikatory
 * wezlow na nazwy z wersji definicji, po ktorej osoba szla.
 */

export interface KrokSciezki {
  kiedy: Date;
  rodzaj: string;
  tytul: string;
  opis: string | null;
  messageId: string | null;
}

export interface SciezkaOsoby {
  flowId: string;
  nazwa: string;
  statusFlow: string;
  status: "w_toku" | "zakonczony" | "wyszedl" | "przerwany";
  wersja: number;
  wszedl: Date;
  zakonczyl: Date | null;
  biezacyKrok: string | null;
  wznowienie: Date | null;
  powodWyjscia: string | null;
  kroki: KrokSciezki[];
}

export const POWODY_WYJSCIA: Record<string, string> = {
  zakup: "kupił po wejściu do automatyzacji",
  brak_zgody: "brak zgody na e-mail",
  brak_adresu: "brak adresu e-mail",
  wykluczenie_globalne: "adres wykluczony globalnie",
  wykluczenie_sklepu: "adres wykluczony w tym sklepie",
  "automatyzacja wyłączona": "automatyzacja została wyłączona",
  "segment nieprawidłowy": "segment z warunku ma reguły, których nie da się policzyć",
  "segment z warunku nie istnieje": "segment z warunku został usunięty",
  "opóźnienie przeterminowane (automatyzacja stała)": "automatyzacja stała dłużej niż doba po terminie tego kroku",
  filtr_profilu: "nie spełnia już filtra profilu automatyzacji",
};

/** Powody pominiecia maila (E4b): dodatkowy filtr, smart sending, filtr przy wysylce. */
const POWODY_POMINIECIA: Record<string, string> = {
  dodatkowy_filtr: "nie spełnia dodatkowego filtra tego maila",
  smart_sending: "smart sending: dostał od nas maila niedawno",
  filtr_profilu: "nie spełniał filtra profilu w chwili wysyłki",
  blad_definicji: "definicji automatyzacji nie dało się odczytać",
};

const RODZAJE: Record<string, string> = {
  wejscie: "Wejście",
  przejscie: "Przejście",
  wyslano: "Wysłano e-mail",
  pominieto: "Pominięto e-mail",
  warunek: "Warunek",
  podzial: "Test A/B",
  oczekiwanie: "Oczekiwanie",
  profil: "Aktualizacja profilu",
  wyjscie: "Wyjście",
  koniec: "Koniec",
  przerwanie: "Przerwanie",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sciezkaOsobyWeFlow(tenantId: string, profileId: string): Promise<SciezkaOsoby[]> {
  // smiec zamiast UUID = pusta sciezka, nie blad Postgresa (review #13)
  if (!UUID.test(profileId) || !UUID.test(tenantId)) return [];
  const pool = getPool();
  const { rows: uczestnicy } = await pool.query(
    `select p.id, p.flow_id, p.status, p.version, p.node_id, p.entered_at, p.finished_at, p.resume_at, p.exit_reason,
            f.name, f.status as flow_status, v.definition
       from flow_participants p
       join flows f on f.tenant_id = p.tenant_id and f.id = p.flow_id
       join flow_versions v on v.tenant_id = p.tenant_id and v.flow_id = p.flow_id and v.version = p.version
      where p.tenant_id = $1 and p.profile_id = $2
      order by p.entered_at desc`,
    [tenantId, profileId],
  );
  if (!uczestnicy.length) return [];
  const { rows: przejscia } = await pool.query(
    `select participant_id, kind, from_node, to_node, detail, occurred_at
       from flow_transitions
      where tenant_id = $1 and profile_id = $2
      order by occurred_at, id`,
    [tenantId, profileId],
  );
  const { rows: emaile } = await pool.query(
    "select id, name, subject from journeys where tenant_id = $1 and flow_id = any($2::uuid[])",
    [tenantId, uczestnicy.map((u) => u.flow_id)],
  );
  const slownik = { emaile: Object.fromEntries(emaile.map((e) => [e.id, { nazwa: e.name, temat: e.subject ?? "" }])) };

  return uczestnicy.map((u) => {
    const parsed = schematGrafu.safeParse(u.definition);
    const g: Graf | null = parsed.success ? parsed.data : null;
    const nazwa = (id: string | null) => {
      if (!id) return "";
      const w = g ? wezel(g, id) : undefined;
      return w ? tytulWezla(w, slownik) : id;
    };
    const kroki: KrokSciezki[] = przejscia
      .filter((t) => t.participant_id === u.id)
      .filter((t) => t.kind !== "przejscie" || (g && wezel(g, t.to_node)?.typ !== "koniec"))
      .map((t) => {
        const d = (t.detail ?? {}) as Record<string, unknown>;
        let tytul = RODZAJE[t.kind] ?? t.kind;
        let opis: string | null = null;
        switch (t.kind) {
          case "wejscie":
            opis = nazwa(t.to_node);
            break;
          case "przejscie":
            tytul = nazwa(t.to_node);
            opis = "przejście do kroku";
            break;
          case "wyslano":
            opis = nazwa(t.from_node);
            break;
          case "pominieto":
            opis = `${nazwa(t.from_node)}: ${POWODY_POMINIECIA[String(d.powod ?? "")] ?? String(d.powod ?? "")}`;
            break;
          case "warunek":
            tytul = `${nazwa(t.from_node)}: ${d.wynik ? "Tak" : "Nie"}`;
            opis = d.podzialZdarzenia ? "sprawdzone na zdarzeniu, które wprowadziło osobę" : "warunek sprawdzony na danych z tej chwili";
            break;
          case "podzial":
            tytul = `Test A/B: gałąź ${String(d.galaz ?? "")}`;
            break;
          case "oczekiwanie":
            tytul = nazwa(t.from_node);
            opis = d.do ? `czeka do ${new Date(String(d.do)).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}` : null;
            break;
          case "profil":
            opis = d.akcja === "dodaj_do_listy" ? "dodano do listy"
              : d.akcja === "usun_z_listy" ? "usunięto z listy"
              : d.akcja === "ustaw_wlasciwosc" ? `ustawiono „${String(d.klucz ?? "")}”${d.pominieto ? " (pominięto: profil zanonimizowany)" : ""}`
              : `usunięto właściwość „${String(d.klucz ?? "")}”`;
            break;
          case "wyjscie":
            opis = POWODY_WYJSCIA[String(d.powod ?? "")] ?? String(d.powod ?? "");
            break;
          case "przerwanie":
            opis = String(d.powod ?? "");
            break;
        }
        return { kiedy: t.occurred_at, rodzaj: t.kind, tytul, opis, messageId: typeof d.messageId === "string" ? d.messageId : null };
      });
    return {
      flowId: u.flow_id,
      nazwa: u.name,
      statusFlow: u.flow_status,
      status: u.status,
      wersja: u.version,
      wszedl: u.entered_at,
      zakonczyl: u.finished_at,
      biezacyKrok: u.status === "w_toku" ? nazwa(u.node_id) : null,
      wznowienie: u.status === "w_toku" ? u.resume_at : null,
      powodWyjscia: u.exit_reason ? POWODY_WYJSCIA[u.exit_reason] ?? u.exit_reason : null,
      kroki,
    };
  });
}

/** Odrzucone proby wejscia (filtr profilu przy wejsciu, E4b): osoba nie weszla, wiec nie ma przebiegu. */
export interface PominieteWejscie {
  flowId: string;
  nazwa: string;
  kiedy: Date;
  powod: string;
  filtr: string | null;
}

export async function pominieteWejscia(tenantId: string, profileId: string, limit = 20): Promise<PominieteWejscie[]> {
  if (!UUID.test(profileId) || !UUID.test(tenantId)) return [];
  const { rows } = await getPool().query(
    `select s.flow_id, f.name, s.occurred_at, s.reason, s.detail->>'filtr' as filtr
       from flow_entry_skips s join flows f on f.tenant_id = s.tenant_id and f.id = s.flow_id
      where s.tenant_id = $1 and s.profile_id = $2
      order by s.occurred_at desc limit $3`,
    [tenantId, profileId, limit],
  );
  return rows.map((r) => ({ flowId: r.flow_id, nazwa: r.name, kiedy: r.occurred_at, powod: r.reason === "filtr_profilu" ? "nie spełniała filtra profilu w chwili wejścia" : r.reason, filtr: r.filtr }));
}
