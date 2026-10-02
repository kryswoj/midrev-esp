import { describe, expect, it } from "vitest";
import { wersjaZRevision } from "../src/wersja-wydania";
import { czyBladWersji } from "../src/app/ui/blad-wersji";

// Audyt UX 02.10, P0-1 „stara karta po wdrożeniu”: wersja z REVISION (deploy.sh) zasila
// deploymentId i /api/wersja, a ekrany błędu rozpoznają błąd starej karty.
describe("wersja wydania z pliku REVISION", () => {
  it("wdrożenie z repo: 12 znaków SHA", () => {
    expect(wersjaZRevision("637ebc5a1b2c3d4e5f60718293a4b5c6d7e8f901 v0.2.0\n")).toBe("637ebc5a1b2c");
  });
  it("wdrożenie z archiwum: 12 znaków sha256, także ze spacją w nazwie pliku", () => {
    const hash = "ab".repeat(32);
    expect(wersjaZRevision(`archiwum midrev-esp-637ebc5.tar.gz sha256:${hash}`)).toBe("abababababab");
    expect(wersjaZRevision(`archiwum moje archiwum.tar.gz sha256:${hash}`)).toBe("abababababab");
  });
  it("pusty albo dziwny plik = brak wersji (mechanizmy wyłączone, nie losowa wartość)", () => {
    expect(wersjaZRevision("")).toBe("");
    expect(wersjaZRevision("main")).toBe("");
    expect(wersjaZRevision("archiwum x.tar.gz")).toBe("");
    expect(wersjaZRevision("<script> v1")).toBe("");
  });
});

describe("rozpoznanie błędu starej karty", () => {
  it("łapie komunikaty Nexta o nieznanej akcji i brakującym chunku", () => {
    for (const m of [
      "Server action not found.",
      'Server Action "7f3a" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
      "Failed to find Server Action. This request might be from an older or newer deployment.",
      "Loading chunk 123 failed.",
      "Loading CSS chunk app-layout failed.",
      "Failed to fetch dynamically imported module: https://esp.midrev.pl/_next/static/chunks/x.js",
    ]) expect(czyBladWersji(new Error(m)), m).toBe(true);
    const chunk = new Error("x");
    chunk.name = "ChunkLoadError";
    expect(czyBladWersji(chunk)).toBe(true);
  });
  it("NIE połyka innych błędów (ogólny ekran z ponowieniem zostaje)", () => {
    for (const m of [
      "An unexpected response was received from the server.",
      "duplicate key value violates unique constraint",
      "Nie znaleziono kampanii",
      "fetch failed",
      "",
    ]) expect(czyBladWersji(new Error(m)), m).toBe(false);
    expect(czyBladWersji(null)).toBe(false);
    expect(czyBladWersji("Server action not found.")).toBe(false);
  });
});
