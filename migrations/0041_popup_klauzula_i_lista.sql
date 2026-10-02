-- Fala 1 UX, pkt 4 (P0 prawny): klauzula zgody w formularzu zapisu (popupie).
--
-- Do tej pory popup NIE pokazywal klauzuli, a zglos-popup.ts zapisywal do consents.wording
-- stale zdanie bez polskich znakow, ktorego osoba nigdy nie widziala. Dowod zgody opisywal
-- wiec tekst niewyswietlony (RODO art. 7 ust. 1, UŚUDE). Od tej migracji:
--  - klauzula jest wlasnoscia popupu i jest WERSJONOWANA: kazda zmiana tekstu albo adresu
--    polityki prywatnosci to nowy, niezmienny wiersz popup_consent_versions;
--  - skrypt na stronie sklepu pokazuje tekst biezacej wersji przy NIEZAZNACZONYM polu wyboru
--    i odsyla numer wersji, ktora wyswietlil;
--  - serwer zapisuje w consents PELNY tekst tej wersji (z bazy, nie od przegladarki) i wskazanie
--    na wersje (popup_consent_version_id), a w method_detail popup i numer wersji.
--
-- Lista docelowa: popups.list_id. Zapis z popupu dopisuje osobe do list_members ze zrodlem
-- 'formularz:<popupId>', czyli zrodlem pojedynczym (ZRODLA_POJEDYNCZE), wiec odpala wyzwalacz
-- "dolaczenie do listy" tak samo jak dodanie reczne.
--
-- Expand (AD-46): nowe kolumny sa NULLABLE, nic nie jest wymagane od starego kodu. Stary kod po
-- rollbacku dalej tworzy popupy (bez wersji klauzuli); nowy kod takiego popupu NIE wyswietla na
-- stronie sklepu (brak klauzuli = brak formularza), zamiast zbierac zgody bez tekstu.
--
-- Istniejace popupy dostaja wersje 1 z domyslnym tekstem (nazwa firmy z danych nadawcy albo
-- nazwa konta). Od wdrozenia ich skrypt pokazuje ten tekst z polem wyboru. Wczesniejszych wpisow
-- w consents NIE ruszamy: rejestr jest append-only (AD-16), a historia ma pokazywac prawde
-- o tym, co wtedy zapisano.

create table popup_consent_versions (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null,
  popup_id uuid not null,
  version int not null check (version >= 1),
  -- dokladnie ten tekst widzi osoba przy polu wyboru (textContent, bez HTML)
  wording text not null check (length(btrim(wording)) between 20 and 2000),
  -- link "Polityka prywatnosci" pod klauzula; tylko http(s), bez spacji
  privacy_url text check (privacy_url is null or (privacy_url ~ '^https?://[^\s<>"]+$' and length(privacy_url) <= 500)),
  created_at timestamptz not null default now(),
  -- kiedy przestala byc biezaca (nowa wersja); null = biezaca
  superseded_at timestamptz,
  unique (tenant_id, id),
  unique (popup_id, version),
  -- Wersja jest dowodem zgody: samego popupu NIE da sie usunac, dopoki ma wersje (no action;
  -- review Codeksa R1). Znika wylacznie razem z tenantem (kaskada z tenants ponizej; no action
  -- sprawdza sie na koncu instrukcji, wiec usuniecie tenanta przechodzi).
  foreign key (tenant_id, popup_id) references popups (tenant_id, id),
  foreign key (tenant_id) references tenants (id) on delete cascade
);

-- Wersja jest dowodem: tresci, adresu i numeru nie wolno zmieniac po zapisie. Dozwolone jest
-- wylacznie ustawienie superseded_at (raz).
create function popup_consent_versions_niezmienne() returns trigger language plpgsql as $$
begin
  if new.wording is distinct from old.wording
     or new.privacy_url is distinct from old.privacy_url
     or new.version is distinct from old.version
     or new.popup_id is distinct from old.popup_id
     or new.tenant_id is distinct from old.tenant_id
     or new.created_at is distinct from old.created_at
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'popup_consent_versions: wersja klauzuli jest niezmienna (dozwolone tylko jednorazowe superseded_at)';
  end if;
  return new;
end $$;

create trigger popup_consent_versions_niezmienne
  before update on popup_consent_versions
  for each row execute function popup_consent_versions_niezmienne();

alter table popups
  -- numer biezacej wersji klauzuli; null = popup bez klauzuli (nie wyswietla sie)
  add column consent_version int,
  -- lista, na ktora trafia osoba po zapisie; null = bez listy
  add column list_id uuid,
  add constraint popups_consent_version_fk
    foreign key (id, consent_version) references popup_consent_versions (popup_id, version)
    deferrable initially deferred,
  -- usuniecie listy nie usuwa popupu, tylko zdejmuje liste docelowa (tenant_id zostaje)
  add constraint popups_list_fk
    foreign key (tenant_id, list_id) references lists (tenant_id, id) on delete set null (list_id);

alter table consents
  -- wersja klauzuli popupu, przy ktorej osoba zaznaczyla zgode (tekst jest i tak w wording)
  add column popup_consent_version_id uuid,
  add constraint consents_popup_consent_version_fk
    foreign key (tenant_id, popup_consent_version_id) references popup_consent_versions (tenant_id, id)
    on delete set null (popup_consent_version_id);

-- Wersja 1 dla istniejacych popupow (patrz naglowek).
insert into popup_consent_versions (tenant_id, popup_id, version, wording)
select p.tenant_id, p.id, 1,
       'Zapisuję się na newsletter ' || left(coalesce(nullif(btrim(t.sender_company_name), ''), t.name), 200)
       || ' i zgadzam się na otrzymywanie wiadomości e-mail z ofertami i nowościami. '
       || 'Zgodę mogę wycofać w każdej chwili, klikając link w stopce wiadomości.'
  from popups p
  join tenants t on t.id = p.tenant_id;

update popups set consent_version = 1;

-- ---------------------------------------------------------------------------
-- Fala 1 UX, pkt 5: lista profili z wyszukiwarka i paginacja kursorem.
-- Wyszukiwanie po PREFIKSIE (e-mail z 0034, imie, nazwisko, telefon E.164) idzie po indeksach
-- btree z text_pattern_ops i tenant_id na czele, wiec nigdy nie skanuje cudzych tenantow.
-- Kolejnosc listy (najnowsze profile) i kursor (created_at, id) maja wlasny indeks.
-- Zwykle `create index` w transakcji migracji, jak w 0034 (tabele w sandboxie/produkcji male).
create index profiles_lista_idx on profiles (tenant_id, created_at desc, id desc);
create index profiles_imie_prefix_idx on profiles (tenant_id, lower(first_name) text_pattern_ops) where first_name is not null;
create index profiles_nazwisko_prefix_idx on profiles (tenant_id, lower(last_name) text_pattern_ops) where last_name is not null;
create index profiles_telefon_prefix_idx on profiles (tenant_id, midrev_telefon_e164(phone) text_pattern_ops) where phone is not null;
