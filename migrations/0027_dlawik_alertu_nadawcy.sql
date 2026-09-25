-- Dlawik alertu "wysylka sklepu stoi, serwer nadawcy odmawia" (review A2 #3).
--
-- Blad nadawcy (zle haslo SMTP, MAIL FROM 421, serwer lezy) cofa partie do kolejki bez
-- zuzycia prob. Bez alertu kolejka sklepu stawala po cichu; z alertem bez dlawika tik
-- automatyzacji co minute wysylalby ten sam komunikat. Alert idzie raz na godzine albo
-- od razu po zmianie konfiguracji SMTP (updated_at pozniejsze niz ostatni alert).
-- Kolumna na tenants, nie na tenant_smtp_configs: tenant bez wlasnego serwera (dostawca
-- domyslny) tez moze trafic na odmowe polaczenia.

alter table tenants add column sender_block_alert_at timestamptz;
