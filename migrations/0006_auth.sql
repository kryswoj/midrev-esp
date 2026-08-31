-- Story 1.4 - konta, sesje i dostep do tenantow (AD-2, AD-15, AD-21).
--
-- Trzy decyzje, ktore ta migracja rozstrzyga:
--
-- 1. E-mail uzytkownika jest unikalny po lower(btrim(...)), tak samo jak e-mail
--    profilu w 0001. Bez tego "a@x.com" i "A@x.com" to dwa konta i logowanie
--    zaczyna zalezec od wielkosci liter, ktora wpisal uzytkownik przy rejestracji.
-- 2. W sessions NIE MA tokenu, jest wylacznie jego SHA-256. Wyciek zrzutu bazy
--    nie moze dawac gotowych ciasteczek do wklejenia - hash jest jednokierunkowy,
--    a token ma 256 bitow entropii, wiec odwrocenie po slowniku nie istnieje.
-- 3. memberships wiaze z tenantem tylko role client. Rola globalna admin/operator
--    ma dostep do wszystkich tenantow z definicji (prostszy z dwoch wariantow
--    dopuszczonych w story): dokladanie membershipa operatorowi przy kazdym nowym
--    tenancie to synchronizacja, ktora predzej czy pozniej sie rozjedzie.

create table users (
  id uuid primary key default uuidv7(),
  email text not null,
  password_hash text not null,
  display_name text not null,
  -- admin: zarzadza platforma; operator: pracuje na wszystkich tenantach;
  -- client: widzi wylacznie tenanty ze swoich membershipow
  role text not null check (role in ('admin', 'operator', 'client')),
  created_at timestamptz not null default now()
);

create unique index users_email_lower_idx on users (lower(btrim(email)));

create table sessions (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id) on delete cascade,
  -- SHA-256 losowego tokenu z ciasteczka, hex. Nigdy sam token (patrz naglowek).
  -- Check pilnuje ksztaltu: gdyby kod przez pomylke zapisal jawny token
  -- (base64url, inna dlugosc), baza odmowi zamiast po cichu zdegradowac model.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- wylogowanie ze wszystkich urzadzen i sprzatanie wygaslych sesji ida po user_id
create index sessions_user_idx on sessions (user_id);

create table memberships (
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- wylacznie client: admin i operator maja dostep globalny z roli w users,
  -- wiec membership o innej roli bylby stanem posrednim, ktorego nikt nie
  -- interpretuje. Role per tenant to swiadoma przyszla migracja, nie furtka tutaj.
  role text not null check (role in ('client')),
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- widok "kto ma dostep do tego tenanta" idzie od strony tenanta
create index memberships_tenant_idx on memberships (tenant_id);
