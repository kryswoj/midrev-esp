-- Poprawka z review silnika: /r odtwarzal linki z AKTUALNEJ tresci kampanii, wiec edycja
-- kampanii po wysylce zmienialaby cel klikniecia w mailach, ktore juz wyszly. Snapshot
-- linkow nalezy do wiadomosci, tak samo jak jej HTML (AD-32): odbiorca klika w to,
-- co dostal, a nie w to, co ktos pozniej poprawil.
alter table messages add column links jsonb not null default '[]'::jsonb;
