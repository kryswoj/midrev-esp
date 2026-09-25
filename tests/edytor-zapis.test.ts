import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { nowyBlok, pustyDokument, type DokumentMaila } from "../src/domain/email/bloki";
import { ustawOdbiorcow } from "../src/usecases/tresc/odbiorcy-kampanii";
import { zapiszTrescKampanii } from "../src/usecases/tresc/zapisz-tresc";
import { wyslijTestKampanii } from "../src/usecases/tresc/wysylka-testowa";

/**
 * Zapis z edytora na prawdziwej bazie: to, co leży w `content.html` po zapisie, to jest
 * to, co wyśle silnik. Każdy test sprawdza ZAPISANY rekord, nie wynik funkcji.
 */
describe("edytor: zapis treści i odbiorców (baza)", () => {
  const pool = getPool();
  let tenantId: string;
  let obcyTenantId: string;
  let segmentObcy: string;
  let lista: string;

  function dokument(tekst: string): DokumentMaila {
    const d = pustyDokument();
    d.bloki = [
      { ...nowyBlok("tekst"), html: tekst },
      { ...nowyBlok("przycisk"), link: "https://sklep.pl/?a=1&b=2" },
    ];
    return d;
  }

  async function kampania(status: string) {
    const { rows } = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'EDYT kampania', 'Temat', $2, $3) returning id`,
      [tenantId, JSON.stringify({ html: "<p>stara</p>" }), status],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    await pool.query("delete from tenants where name like 'EDYT %'");
    tenantId = (await pool.query("insert into tenants (name) values ('EDYT tenant') returning id")).rows[0].id;
    obcyTenantId = (await pool.query("insert into tenants (name) values ('EDYT obcy') returning id")).rows[0].id;
    segmentObcy = (
      await pool.query("insert into segments (tenant_id, name, rules) values ($1, 'obcy', '[]') returning id", [obcyTenantId])
    ).rows[0].id;
    lista = (await pool.query("insert into lists (tenant_id, name) values ($1, 'EDYT lista') returning id", [tenantId])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query("delete from tenants where name like 'EDYT %'");
    await closePool();
  });

  it("zapis bloków: content.html = render, bloki zapisane, stare klucze content zostają", async () => {
    const id = await kampania("draft");
    await pool.query(`update campaigns set content = content || '{"inne":"zostaje"}'::jsonb where id = $1`, [id]);
    const w = await zapiszTrescKampanii(tenantId, id, { dokument: dokument("Cześć <b>Ala</b>") });
    expect(w.ok).toBe(true);
    const { rows } = await pool.query("select content from campaigns where id = $1", [id]);
    expect(rows[0].content.html).toContain("Cześć <b>Ala</b>");
    expect(rows[0].content.html).toContain('href="https://sklep.pl/?a=1&b=2"');
    expect(rows[0].content.bloki).toHaveLength(2);
    expect(rows[0].content.wersjaSchematu).toBe(1);
    expect(rows[0].content.inne).toBe("zostaje");
  });

  it("zmiana preheadera przerenderowuje HTML dokumentu bloków", async () => {
    const id = await kampania("draft");
    await zapiszTrescKampanii(tenantId, id, { dokument: dokument("x") });
    await zapiszTrescKampanii(tenantId, id, { preheader: "Nowy preheader" });
    const { rows } = await pool.query("select preheader, content->>'html' as html from campaigns where id = $1", [id]);
    expect(rows[0].preheader).toBe("Nowy preheader");
    expect(rows[0].html).toContain("Nowy preheader");
  });

  it("po starcie wysyłki zapis jest odrzucony i treść w bazie się nie zmienia", async () => {
    for (const status of ["sending", "paused", "sent", "cancelled"]) {
      const id = await kampania(status);
      const w = await zapiszTrescKampanii(tenantId, id, { dokument: dokument("nowa") });
      expect(w.ok).toBe(false);
      const { rows } = await pool.query("select content->>'html' as html from campaigns where id = $1", [id]);
      expect(rows[0].html).toBe("<p>stara</p>");
    }
  });

  it("zmiana treści zaakceptowanej kampanii cofa ją do szkicu i wygasza linki; zapis bez zmian — nie", async () => {
    const id = await kampania("draft");
    await zapiszTrescKampanii(tenantId, id, { dokument: dokument("wersja 1") });
    await pool.query("update campaigns set status = 'awaiting_approval' where id = $1", [id]);
    await pool.query(
      `insert into campaign_approvals (tenant_id, campaign_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '7 days')`,
      [tenantId, id, `edyt-${id}`],
    );
    const { rows: przed } = await pool.query("select content from campaigns where id = $1", [id]);
    const bezZmian = await zapiszTrescKampanii(tenantId, id, { dokument: { wersjaSchematu: 1, style: przed[0].content.style, bloki: przed[0].content.bloki } });
    expect(bezZmian.ok && bezZmian.cofnieta).toBe(false);
    expect((await pool.query("select status from campaigns where id = $1", [id])).rows[0].status).toBe("awaiting_approval");

    const zmiana = await zapiszTrescKampanii(tenantId, id, { dokument: dokument("wersja 2") });
    expect(zmiana.ok && zmiana.cofnieta).toBe(true);
    expect((await pool.query("select status from campaigns where id = $1", [id])).rows[0].status).toBe("draft");
    const { rows: linki } = await pool.query(
      "select count(*)::int as ile from campaign_approvals where campaign_id = $1 and expires_at > now()",
      [id],
    );
    expect(linki[0].ile).toBe(0);
  });

  it("autozapis (tylkoSzkic) nie cofa po cichu akceptacji: kampania u klienta zostaje nietknięta", async () => {
    const id = await kampania("awaiting_approval");
    const w = await zapiszTrescKampanii(tenantId, id, { dokument: dokument("auto"), tylkoSzkic: true });
    expect(w.ok).toBe(false);
    const { rows } = await pool.query("select status, content->>'html' as html from campaigns where id = $1", [id]);
    expect(rows[0]).toMatchObject({ status: "awaiting_approval", html: "<p>stara</p>" });
    const szkic = await kampania("draft");
    expect((await zapiszTrescKampanii(tenantId, szkic, { dokument: dokument("auto"), tylkoSzkic: true })).ok).toBe(true);
  });

  it("test przy blokadzie nadawcy (FR45) mówi prawdę zamiast „Test wysłany”", async () => {
    const id = await kampania("draft");
    await zapiszTrescKampanii(tenantId, id, { dokument: dokument("x") });
    const domena = (
      await pool.query(
        "insert into sending_domains (tenant_id, domain, status) values ($1, 'edyt-sklep.pl', 'pending') returning id",
        [tenantId],
      )
    ).rows[0].id;
    await pool.query(
      `insert into tenant_smtp_configs (tenant_id, sending_domain_id, host, port, security, from_name, from_email, connection_verified_at)
       values ($1, $2, 'smtp.edyt-sklep.pl', 587, 'starttls', 'Sklep', 'news@edyt-sklep.pl', now())`,
      [tenantId, domena],
    );
    try {
      const w = await wyslijTestKampanii(tenantId, id, "test@example.test");
      expect(w.ok).toBe(false);
      if (!w.ok) {
        expect(w.blad).toMatch(/Test NIE wyszedł/);
        expect(w.blad).toMatch(/edyt-sklep\.pl nie jest zweryfikowana/);
      }
      // wiadomość testowa czeka w kolejce, niczego nie zajęto
      const { rows } = await pool.query(
        "select current_state from messages where tenant_id = $1 and source_type = 'test' and email = 'test@example.test'",
        [tenantId],
      );
      expect(rows.map((r) => r.current_state)).toEqual(["queued"]);
    } finally {
      await pool.query("delete from messages where tenant_id = $1", [tenantId]);
      await pool.query("delete from tenant_smtp_configs where tenant_id = $1", [tenantId]);
      await pool.query("delete from sending_domains where tenant_id = $1", [tenantId]);
    }
  });

  it("zmiana treści po zaplanowaniu zdejmuje plan (B4 wraca przy nowym terminie); sama nazwa — nie", async () => {
    const id = await kampania("draft");
    await zapiszTrescKampanii(tenantId, id, { dokument: dokument("v1") });
    await pool.query("update campaigns set scheduled_at = now() + interval '1 day' where id = $1", [id]);
    const tylkoNazwa = await zapiszTrescKampanii(tenantId, id, { nazwa: "EDYT nowa nazwa" });
    expect(tylkoNazwa.ok && tylkoNazwa.planZdjety).toBe(false);
    expect((await pool.query("select scheduled_at from campaigns where id = $1", [id])).rows[0].scheduled_at).not.toBeNull();
    const zmiana = await zapiszTrescKampanii(tenantId, id, { dokument: dokument("v2 bez linku") });
    expect(zmiana.ok && zmiana.planZdjety).toBe(true);
    expect((await pool.query("select scheduled_at from campaigns where id = $1", [id])).rows[0].scheduled_at).toBeNull();
  });

  it("równoległe zapisy (bloki + temat) nie przywracają starych bloków", async () => {
    const id = await kampania("draft");
    await zapiszTrescKampanii(tenantId, id, { dokument: dokument("A") });
    await Promise.all([
      zapiszTrescKampanii(tenantId, id, { dokument: dokument("B") }),
      zapiszTrescKampanii(tenantId, id, { temat: "Nowy temat" }),
    ]);
    const { rows } = await pool.query("select subject, content->>'html' as html from campaigns where id = $1", [id]);
    expect(rows[0].subject).toBe("Nowy temat");
    expect(rows[0].html).toContain(">B<");
  });

  it("kampania innego tenanta jest nieosiągalna", async () => {
    const id = await kampania("draft");
    const w = await zapiszTrescKampanii(obcyTenantId, id, { dokument: dokument("wlam") });
    expect(w.ok).toBe(false);
  });

  it("odbiorcy: cudzy segment odrzucony, własna lista zapisana, po starcie wysyłki zamrożone", async () => {
    const id = await kampania("draft");
    const obcy = await ustawOdbiorcow(tenantId, id, [{ typ: "segment", id: segmentObcy }], []);
    expect(obcy.ok).toBe(false);
    expect((await pool.query("select count(*)::int as ile from campaign_audience where campaign_id = $1", [id])).rows[0].ile).toBe(0);

    const ok = await ustawOdbiorcow(tenantId, id, [{ typ: "list", id: lista }], []);
    expect(ok.ok && ok.zmieniono).toBe(true);
    const ponownie = await ustawOdbiorcow(tenantId, id, [{ typ: "list", id: lista }], []);
    expect(ponownie.ok && ponownie.zmieniono).toBe(false);
    expect(await ustawOdbiorcow(tenantId, id, [{ typ: "list", id: lista }], [{ typ: "list", id: lista }])).toMatchObject({ ok: false });

    const wyslana = await kampania("sent");
    expect((await ustawOdbiorcow(tenantId, wyslana, [{ typ: "list", id: lista }], [])).ok).toBe(false);
  });
});
