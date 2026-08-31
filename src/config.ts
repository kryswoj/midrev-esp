import { z } from "zod";

// Jedyne miejsce w kodzie, które dotyka process.env (AD-1, konwencje).
// Walidacja przy starcie, żeby brak zmiennej wywalał proces od razu, a nie w środku
// wysyłki do klienta. Komunikat nazywa brakującą zmienną i nigdy nie pokazuje wartości.
const schemat = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL jest wymagany"),
  SECRETS_KEY: z
    .string()
    .length(64, "SECRETS_KEY musi być 32 bajtami zapisanymi szesnastkowo (64 znaki)")
    .default("0".repeat(64)),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
});

let zbuforowana: z.infer<typeof schemat> | undefined;

export function config() {
  if (zbuforowana) return zbuforowana;
  const wynik = schemat.safeParse(process.env);
  if (!wynik.success) {
    const brakujace = wynik.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Konfiguracja niekompletna — ${brakujace}`);
  }
  zbuforowana = wynik.data;
  return zbuforowana;
}
