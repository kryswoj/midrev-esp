-- E6 / Story 6.1 (czesc MVP pod os profilu): indeksy, ktorych brak wskazal audyt 30.09
-- (01-stan-kodu.md, ryzyka 6 i 11). Na prawie pustej produkcji zwykle `create index`
-- w transakcji migracji; przy duzych tabelach `concurrently` poza migracja (osobny skrypt).

-- historia wysylek i liczniki na profilu (dzis skan wiadomosci tenanta)
create index messages_profil_idx on messages (tenant_id, profile_id, created_at desc);
-- wyszukiwanie profili po prefiksie adresu (lista profili)
create index profiles_email_prefix_idx on profiles (tenant_id, lower(email) text_pattern_ops) where email is not null;
