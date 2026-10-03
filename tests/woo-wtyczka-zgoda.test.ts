import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Decyzja RODO (wariant B, 03.10.2026): wtyczka Woo bez sygnału zgody nie wysyła zdarzeń koszyka
 * ani kasy. Logika `can_track` w PHP, uruchamiana w php:8.2-cli (docker). Bez dockera albo obrazu
 * test jest pomijany (środowisko), a nie zielony.
 */
const KATALOG = join(dirname(fileURLToPath(import.meta.url)), "..");

function php(tryb: string): Record<string, boolean> | null {
  try {
    const wyjscie = execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "-v", `${KATALOG}:/app:ro`, "php:8.2-cli", "php", "/app/tests/woo-php/can-track.php", tryb],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(wyjscie);
  } catch (b) {
    const e = b as { code?: string; stderr?: string };
    if (e.code === "ENOENT" || /Unable to find image|Cannot connect to the Docker daemon|permission denied/i.test(String(e.stderr ?? ""))) return null;
    throw b;
  }
}

const dostepny = php("bez-api") !== null;

describe.skipIf(!dostepny)("wtyczka Woo: zdarzenia koszyka tylko po zgodzie (can_track)", () => {
  it("bez WP Consent API: zgoda = ciasteczko __mx_id z midrev.js; brak albo śmieć = nic nie wychodzi (także token koszyka w zamówieniu); filtr nadpisuje świadomie", () => {
    expect(php("bez-api")).toEqual({ token_w_zamowieniu_bez_zgody: false, token_w_zamowieniu_ze_zgoda: true, bez_ciastka: false, z_ciastkiem: true, zle_ciastko: false, filtr_true_bez_ciastka: true, filtr_false_z_ciastkiem: false });
  });
  it("z WP Consent API decyduje kategoria „marketing” (ciasteczko i filtr nie mają znaczenia)", () => {
    expect(php("api-nie")).toEqual({ token_w_zamowieniu_bez_zgody: false, token_w_zamowieniu_ze_zgoda: false, bez_ciastka: false, z_ciastkiem: false, zle_ciastko: false, filtr_true_bez_ciastka: false, filtr_false_z_ciastkiem: false });
    expect(php("api-tak")).toEqual({ token_w_zamowieniu_bez_zgody: true, token_w_zamowieniu_ze_zgoda: true, bez_ciastka: true, z_ciastkiem: true, zle_ciastko: true, filtr_true_bez_ciastka: true, filtr_false_z_ciastkiem: true });
  });
});
