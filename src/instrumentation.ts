/**
 * Hak startowy Nexta (src/instrumentation.ts): `register` biegnie RAZ przy starcie
 * serwera, zanim przyjmie pierwsze żądanie. Tu stoi walidacja środowiska panelu —
 * ta sama, co w workerze (src/walidacja-startowa.ts). Dotąd panel startował bez
 * DATABASE_URL i z domyślnym APP_URL, a błąd wychodził dopiero przy pierwszym żądaniu.
 * Import dynamiczny w gałęzi nodejs (wzorzec z dokumentacji Next): middleware (edge)
 * też woła register, a walidacja dotyka fs i process.exit.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { zweryfikujStartPanelu } = await import("./walidacja-startowa");
    zweryfikujStartPanelu();
  }
}
