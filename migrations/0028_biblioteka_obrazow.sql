-- Biblioteka obrazow (audyt 24.09, #14 / FR33). Klient bez wlasnego hostingu ma moc
-- wgrac grafike do maila, a blok Obraz i Produkt dostaje adres na naszej publicznej
-- trasie /o/{token}.{ext}.
--
-- Plik lezy na dysku w var/obrazy/{tenant_id}/{id}.{ext}. Sciezka powstaje WYLACZNIE
-- z identyfikatorow nadanych przez serwer (tenant_id, id) i rozszerzenia z tej tabeli
-- (check nizej), nigdy z nazwy pliku od uzytkownika: "../../.env" w nazwie nie ma jak
-- stac sie sciezka. Nazwa oryginalna sluzy tylko do wyswietlenia.
--
-- token: publiczny, nieodgadywalny identyfikator w adresie obrazu (32 losowe bajty,
-- base64url = 43 znaki). Maila otwiera odbiorca bez sesji, wiec trasa jest publiczna;
-- adres nie zdradza ani tenanta, ani id, i nie da sie po nim przejsc do sasiednich
-- obrazow. mime i ext wynikaja z magicznych bajtow pliku, nie z deklaracji przegladarki.
--
-- uploaded_at: data zdarzenia (wgrania) podawana jawnie z kodu, bez default now()
-- (lista kontrolna zapisu do produkcji, pkt 2). created_at to techniczny znacznik
-- zapisu wiersza.
create table images (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{43}$'),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  ext text not null check (ext in ('png', 'jpg', 'gif', 'webp')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  width integer not null check (width between 1 and 20000),
  height integer not null check (height between 1 and 20000),
  original_name text not null check (char_length(original_name) between 1 and 200),
  uploaded_by text,
  uploaded_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- klucz zlozony pod przyszle FK "(tenant_id, image_id)": kazda tabela, ktora kiedys
  -- wskaze obraz, wskaze go RAZEM z tenantem, wiec nie zepnie obrazu z cudzym sklepem
  unique (tenant_id, id),
  -- rozszerzenie i typ musza sobie odpowiadac: trasa publiczna serwuje Content-Type z mime,
  -- a plik na dysku ma rozszerzenie z ext
  check (
    (ext = 'png' and mime = 'image/png') or
    (ext = 'jpg' and mime = 'image/jpeg') or
    (ext = 'gif' and mime = 'image/gif') or
    (ext = 'webp' and mime = 'image/webp')
  )
);

create index images_tenant_idx on images (tenant_id, uploaded_at desc, id desc);
