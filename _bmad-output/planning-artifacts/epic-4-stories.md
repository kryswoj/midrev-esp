## Epik 4: Kampanie i akceptacja klienta

Cel epiku: operator składa kampanię w edytorze wizualnym, dobiera odbiorców, ogląda podgląd i wysyła test, klient akceptuje ją jednym kliknięciem bez logowania, a system zleca wysyłkę silnikowi z Epiku 3 albo jej nie zleca i mówi dlaczego.

### Granice epiku

Te story kończą się na **zleceniu** wysyłki: zmiana stanu kampanii plus zadanie w kolejce w tej samej transakcji. Materializacja listy odbiorców, tworzenie rekordów `messages`, wiążące `canSendTo`, wywołanie dostawcy i obsługa odbić należą do Epiku 3. Wszędzie, gdzie ta granica ma znaczenie, jest to zapisane w notatkach story.

### Pięć zasad, które przechodzą przez cały epik

1. **Utrwalony HTML należy do wiadomości, nie do kampanii.** Kampania trzyma dokument edytora, wiadomość trzyma HTML, który faktycznie poszedł. Inaczej zmiana szablonu zmienia wstecznie to, co ludzie już dostali, a podgląd archiwalnej wysyłki kłamie.
2. **Linki przepisuje wstrzyknięta funkcja, nigdy regex po gotowym HTML.** Regex rozjeżdża się na komentarzach warunkowych Outlooka i na URL-ach w atrybutach stylu, a błąd tutaj to niepoliczone kliknięcia w atrybucji (AD-14).
3. **Adapter Maily wycina z wyjścia zaszyty `@font-face` wskazujący na obcy serwer.** Każde otwarcie takiego maila ujawnia adres IP odbiorcy osobie trzeciej, której nie ma w żadnej umowie powierzenia.
4. **Jedna ścieżka renderowania dla podglądu, wysyłki testowej i wysyłki właściwej.** Różnica wyłącznie w polu `mode`. Trzy ścieżki oznaczają, że test pokazuje co innego niż dostaje odbiorca.
5. **Widok klienta działa na telefonie (NFR32) i nie przekazuje stanu samym kolorem (NFR33).**

---

### Story 4.1: Model kampanii i jej cykl życia

Jako operator, chcę utworzyć kampanię z nazwą, tematem i nadawcą, żeby mieć byt, do którego doczepiam treść, odbiorców i termin.

**Pokrywa:** FR32 (część trwała) | **Rządzą:** AD-2, AD-3, AD-10, AD-12, AD-15, AD-17, AD-21, AD-32 | **Jakość:** NFR9, NFR20, NFR35, NFR36

**Kryteria akceptacji**

1. **Zakładając** operatora zalogowanego do tenanta T, **kiedy** tworzy kampanię z nazwą, tematem i adresem nadawcy, **wtedy** powstaje wiersz w `campaigns` ze stanem `draft`, kluczem z `uuidv7()` i `tenant_id` wziętym z sesji, **oraz** wiersz w `campaign_state_events` z jawnie ustawionym `occurred_at` pochodzącym z zegara aplikacji, nie z domyślnej wartości kolumny.
2. **Zakładając** operatora zalogowanego do tenanta A, **kiedy** w ciele żądania poda `tenantId` tenanta B, **wtedy** kampania powstaje w tenancie A, **oraz** odczyt kampanii tenanta B kończy się `{ ok: false, error: { code: 'not_found' } }`, a nie odmową ujawniającą, że taki rekord istnieje.
3. **Zakładając** kampanię w stanie `sent`, **kiedy** use-case próbuje przejścia do `draft`, **wtedy** wynikiem jest `{ ok: false, error: { code: 'invalid_state_transition' } }`, **oraz** wiersz w `campaigns` pozostaje bez zmian, a w `campaign_state_events` nie przybywa wpisu.
4. **Zakładając** zapisany dokument szablonu w `template_content`, **kiedy** przeszukać drzewo źródeł poza `src/adapters/editor/**`, **wtedy** nie ma tam ani jednego odwołania do pól wewnątrz tej kolumny (dostęp wyłącznie jako nieprzezroczysty `jsonb`).
5. **Zakładając** świeżo zmigrowaną bazę, **kiedy** wykonać `insert` do `campaign_state_events` bez `occurred_at`, **wtedy** baza odrzuca zapis błędem `not null`, **oraz** zapytanie do `information_schema.columns` potwierdza brak `column_default` na tej kolumnie.

**Notatki implementacyjne**

Nowy plik migracji o kolejnym wolnym numerze (Epiki 3 i 6 idą równolegle, więc numer bierz z `ls migrations`, nigdy nie edytuj zastosowanego pliku, AD-12).

```
campaigns(
  id uuid pk default uuidv7(), tenant_id uuid not null references tenants(id),
  name text not null, subject text, preheader text,
  from_name text, from_email text, reply_to text,
  template_editor_id text, template_schema_version integer, template_content jsonb,
  state text not null, approval_required boolean not null default true,
  scheduled_at timestamptz, schedule_timezone text,
  created_by uuid, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
campaign_state_events(
  id uuid pk default uuidv7(), tenant_id, campaign_id, from_state, to_state,
  actor_kind text, actor_ref text, reason text,
  occurred_at timestamptz not null,        -- BEZ default
  recorded_at timestamptz not null default now()
)
```

Stany: `draft`, `pending_approval`, `changes_requested`, `approved`, `scheduled`, `sending`, `paused`, `sent`, `cancelled`, `blocked_no_approval`. Dozwolone przejścia jako jawna tablica w `src/domain/campaign/state-machine.ts`, nie jako rozsiane `if`-y.

Pliki: `src/domain/campaign/campaign.ts` (encja, `canTransition`), `src/usecases/campaigns/create-campaign.ts`, `update-campaign-meta.ts`, `get-campaign.ts`, `list-campaigns.ts`, repozytorium `src/adapters/db/campaigns-repo.ts` z ręcznym SQL i parsowaniem wyniku zodem (AD-18), warstwa web `src/app/(operator)/campaigns/page.tsx` oraz `new/page.tsx` plus server action będąca cienkim opakowaniem use-case (AD-17).

Pułapki: `crypto.randomUUID()` jest zakazane, daje wersję 4 i psuje uporządkowanie indeksu (AD-15). Zmiana kolumny `state` i wpis do `campaign_state_events` muszą iść w jednej transakcji, inaczej log kłamie o historii kampanii. Identyfikator na zewnątrz w formie `cmp_<uuid>`, wewnątrz goły uuid.

**Testy**

Integracyjny na sandboxie (AD-20): utworzenie, odczyt, komplet dozwolonych i niedozwolonych przejść, test izolacji tenanta, test odpytujący `information_schema` o brak `default` na `occurred_at`. Test źródłowy skanujący drzewo pod kątem naruszenia kryterium 4. Dla warstwy web: testem sprawdzone, że server action bez nazwy kampanii zwraca błąd walidacji i nie tworzy wiersza; zrzutem ekranu w przeglądarce sprawdzona lista kampanii ze stanami i formularz tworzenia.

---

### Story 4.2: Port TemplateEditor i adapter Maily

Jako deweloper, chcę renderować treść kampanii przez port z jedną implementacją Maily, żeby zmiana edytora była podmianą adaptera, a nie przepisaniem modułu kampanii.

**Pokrywa:** FR32 | **Rządzą:** AD-32, AD-1, AD-11 | **Jakość:** NFR35, NFR37

**Kryteria akceptacji**

1. **Zakładając** dokument szablonu z nagłówkiem, dwiema kolumnami, przyciskiem i polskimi znakami, **kiedy** wywołać `render` z `mode: 'send'`, **wtedy** wyjście deklaruje `charset=UTF-8`, atrybut `lang` odpowiada `locale` z wejścia, znaki diakrytyczne przechodzą bez zniekształceń, **oraz** obecna jest reguła `@media` zwijająca kolumny poniżej 480 px.
2. **Zakładając** dowolny dokument, **kiedy** przeszukać wyjściowy HTML pod kątem hostów, **wtedy** nie ma w nim żadnego obcego hosta w `src`, w `href` czcionek ani w `@font-face`, w szczególności `rsms.me`, **oraz** test wymienia dozwolone hosty jawną listą (domeny tenanta i nasz CDN), a nie zaprzeczeniem konkretnej nazwy.
3. **Zakładając** dokument z trzema linkami zewnętrznymi, **kiedy** podać w `RenderInput` funkcję `rewriteLink` dopisującą znacznik, **wtedy** wszystkie trzy `href` w wyjściu są przepisane, **oraz** `RenderOutput.links` zawiera dokładnie te trzy adresy po przepisaniu, **oraz** przepisanie zostało wykonane na poziomie dokumentu, co potwierdza test z komentarzem warunkowym Outlooka i URL-em w atrybucie `style`, których regex by nie obsłużył poprawnie.
4. **Zakładając** to samo wejście, **kiedy** wywołać `render` dwukrotnie, **wtedy** wyjście jest identyczne bajt w bajt (brak losowych identyfikatorów, brak znacznika czasu w treści).
5. **Zakładając** `mode: 'send'` i podany `openPixelUrl`, **kiedy** renderować, **wtedy** piksel jest w wyjściu; **kiedy** ten sam dokument renderować z `mode: 'preview'`, **wtedy** piksela nie ma, **oraz** poza obecnością piksela oba wyjścia są identyczne.
6. **Zakładając** dokument z blokiem, którego aktywny adapter nie obsługuje, **kiedy** wywołać `validate`, **wtedy** wynik to `{ ok: false }` z listą nieobsługiwanych bloków, **oraz** `capabilities()` zwraca `productBlock: false` w fazie 1.
7. **Zakładając** zmienną niosącą kwotę, **kiedy** podać ją w `variables` jako liczbę całkowitą w groszach z kodem waluty, **wtedy** w wyjściu jest sformatowana kwota z separatorem dziesiętnym, **oraz** w kodzie adaptera nie ma arytmetyki zmiennoprzecinkowej na kwotach (AD-11).
8. **Zakładając** dokument w `schemaVersion` 1 i adapter obsługujący 2, **kiedy** wywołać `migrate(doc, 2)`, **wtedy** zwrócony dokument ma `schemaVersion: 2` i renderuje się bez ostrzeżeń, **oraz** dokument wejściowy pozostaje niezmieniony.
9. **Zakładając** dowolny wyrenderowany dokument, **kiedy** odczytać `RenderOutput.text`, **wtedy** jest niepusty i pozbawiony znaczników HTML.

**Notatki implementacyjne**

Kontrakt portu przenosisz wprost z `research-edytor-maili.md` sekcja 8.1: `src/domain/ports/template-editor.ts` z typami `TemplateDocument` (`editorId`, `schemaVersion`, `content: unknown`), `TemplateRenderer` (`capabilities`, `validate`, `render`, `migrate`), `RenderInput` (`document`, `locale`, `brand`, `variables`, `products`, `rewriteLink`, `openPixelUrl`, `mode`), `RenderOutput` (`html`, `text`, `links`, `warnings`), `EditorCapabilities`.

Adapter: `src/adapters/editor/maily/renderer.ts`, `capabilities.ts`, `sanitize.ts`. Piny `@maily-to/core@0.3.7` i `@maily-to/render@0.2.3`.

Przepisywanie linków: przez API dokumentu (w Maily `setLinkValues`), zanim powstanie HTML. Nigdy po HTML.

Wycięcie `@font-face`: najpierw sprawdź, czy renderer daje opcję wyłączenia webfontu. Jeśli nie, zrób z tego jawny, nazwany krok sanitizujący na wyjściu z własnym testem, a nie doklejkę przy okazji innej funkcji. Właściwym zabezpieczeniem i tak jest asercja z kryterium 2, bo ona wyłapie także obcy host, który pojawi się w przyszłej wersji biblioteki.

Blok produktowy zostaje referencją, nie zrzutem danych: dokument zapisuje odwołanie (kolekcja, liczba pozycji, sortowanie), a produkty wchodzą przez `RenderInput.products` rozwiązane tuż przed renderowaniem. W fazie 1 `capabilities().productBlock === false` (FR42 to faza 3), ale kontrakt ma to pole od początku, bo dorobienie go później oznacza migrację dokumentów.

**Testy**

Wspólny zestaw testów akceptacyjnych adaptera jako parametryzowany plik `tests/editor-contract.test.ts`, uruchamiany dla każdego zarejestrowanego adaptera (wzorzec z AD-8 i AD-20, na realnym wyjściu, bez mocków): kodowanie, język, responsywność, brak obcych hostów, śledzenie, piksel, wersja tekstowa, determinizm, izolacja marki tenanta. Dla warstwy web nic tutaj nie ma, to czysta funkcja serwerowa; wygląd wyjścia sprawdzasz zrzutem ekranu dopiero w Story 4.7.

---

### Story 4.3: Magazyn plików i wgrywanie grafik

Jako operator, chcę wgrać do kampanii grafikę, żeby mail miał materiał wizualny klienta.

**Pokrywa:** FR33 | **Rządzą:** AD-1, AD-3, AD-21, AD-32 | **Jakość:** NFR7, NFR9, NFR20, NFR35

**Kryteria akceptacji**

1. **Zakładając** operatora zalogowanego do tenanta T, **kiedy** wgrywa plik PNG o rozmiarze 800 kB, **wtedy** powstaje wiersz w `assets` z `tenant_id` z sesji, sumą kontrolną, typem MIME i rozmiarem, **oraz** use-case zwraca URL, pod którym plik jest dostępny.
2. **Zakładając** plik z rozszerzeniem `.png`, którego zawartość jest plikiem SVG, **kiedy** operator próbuje go wgrać, **wtedy** wgranie zostaje odrzucone z kodem `unsupported_media_type`, **oraz** decyzja opiera się na rozpoznaniu zawartości, nie na rozszerzeniu ani na nagłówku `Content-Type` z żądania.
3. **Zakładając** limit rozmiaru 5 MB, **kiedy** wgrywany plik go przekracza, **wtedy** żądanie kończy się odmową z podaniem limitu, **oraz** na dysku ani w bazie nie zostaje żaden ślad częściowego zapisu.
4. **Zakładając** plik wgrany przez tenanta A, **kiedy** ktoś zna identyfikator tenanta B i próbuje odgadnąć adres pliku, **wtedy** trafienie jest niemożliwe, bo klucz obiektu zawiera losowy segment o entropii co najmniej 128 bitów, **oraz** listowanie zasobów zawsze filtruje po `tenant_id`.
5. **Zakładając** adapter edytora, **kiedy** przeszukać jego kod, **wtedy** nie ma w nim ani jednego wywołania sieciowego wysyłającego plik, **oraz** jedyną drogą jest przekazany z zewnątrz callback `uploadImage`.

**Notatki implementacyjne**

Port `src/domain/ports/file-storage.ts`: `put(tenantId, bytes, contentType): Promise<{ key, url }>`, `remove(tenantId, key)`, `signedUrl(key, ttl)` jeśli adapter tego wymaga. Adapter fazy 1: `src/adapters/storage/local/` (katalog na dysku plus statyczne serwowanie), drugi adapter S3-kompatybilny wchodzi bez zmiany use-case. Use-case `src/usecases/assets/upload-asset.ts`. Tabela `assets(id, tenant_id, storage_key, content_type, byte_size, checksum_sha256, uploaded_by, created_at)`.

Rozpoznanie typu po sygnaturze pliku (magic bytes). Dopuszczone: PNG, JPEG, GIF, WEBP. SVG odrzucone świadomie: to dokument wykonywalny, a nie obrazek, i wpuszczenie go daje XSS w podglądzie w panelu.

Pułapki: nazwa pliku od użytkownika nigdy nie wchodzi do ścieżki na dysku (traversal), do bazy trafia osobno jako etykieta. Klucz obiektu to `tenant/<tenant_id>/<losowy>/<checksum>.<ext>`.

**Testy**

Integracyjny na sandboxie: wgranie, odczyt zwrotny zapisanego wiersza i porównanie sumy kontrolnej z zawartością pliku na dysku (NFR1: dry-run czyta zapisany rekord, nie dane wejściowe), odrzucenie SVG podszywającego się pod PNG, odrzucenie za dużego pliku bez śladu na dysku, test izolacji tenanta na listowaniu. Dla warstwy web: testem sprawdzona odmowa dla złego typu i rozmiaru; zrzutem ekranu sprawdzone, że po wgraniu grafika pojawia się w bibliotece zasobów kampanii.

---

### Story 4.4: Edytor wizualny w panelu operatora

Jako operator, chcę zredagować treść kampanii w edytorze wizualnym, żeby złożyć maila bez pisania HTML.

**Pokrywa:** FR32, FR33 | **Rządzą:** AD-17, AD-32, AD-3, AD-21 | **Jakość:** NFR20, NFR35

**Kryteria akceptacji**

1. **Zakładając** kampanię w stanie `draft`, **kiedy** operator otwiera ekran edycji, **wtedy** montuje się komponent edytora wskazanego konfiguracją `editorId`, **oraz** na ekranie nie ma nazwy konkretnego edytora zaszytej w kodzie strony poza mapą rejestru adapterów.
2. **Zakładając** zmieniony dokument, **kiedy** operator zapisuje, **wtedy** server action waliduje wejście zodem i woła use-case `save-campaign-template`, **oraz** w `campaigns` aktualizują się `template_editor_id`, `template_schema_version` i `template_content`, **oraz** w kodzie strony nie ma ani jednego zapytania SQL (AD-3, AD-18).
3. **Zakładając** kampanię w stanie `sent` albo `sending`, **kiedy** przyjdzie żądanie zapisu treści, **wtedy** wynikiem jest `{ ok: false, error: { code: 'invalid_state_transition' } }`, **oraz** kolumna `template_content` pozostaje bez zmian.
4. **Zakładając** katalog zmiennych tenanta zdefiniowany w domenie, **kiedy** operator wstawia zmienną z listy podpowiedzi, **wtedy** lista pochodzi z `VariableDefinition[]` przekazanych do komponentu, **oraz** nie pochodzi z konfiguracji wewnętrznej edytora.
5. **Zakładając** `capabilities().productBlock === false`, **kiedy** operator otwiera paletę bloków, **wtedy** bloku produktowego tam nie ma, **oraz** interfejs nie pokazuje wyłączonej opcji ani nie rzuca błędu.
6. **Zakładając** wgraną grafikę ze Story 4.3, **kiedy** operator wstawia obraz w edytorze, **wtedy** plik idzie przez callback `uploadImage`, a w dokumencie ląduje zwrócony URL.

**Notatki implementacyjne**

Kontrakt komponentu wg `research-edytor-maili.md` sekcja 8.1: `src/app/_ports/template-editor-ui.ts` z `TemplateEditorProps` (`value`, `onChange`, `variables`, `uploadImage`, `pickProducts`, `brand`, `locale`, `readOnly`). Implementacja `src/app/_editors/maily/MailyEditor.tsx`. Strona `src/app/(operator)/campaigns/[id]/edit/page.tsx`, server action `save-template.action.ts`.

Zapis dokumentu z debouncem po stronie klienta, ale bez cichego nadpisywania: przy równoległej edycji z dwóch kart wygrywa zapis z aktualnym `updated_at`, a przegrany dostaje komunikat, nie ciche zgubienie zmian. Wystarczy porównanie `updated_at` przekazanego z formularza.

Pułapka: kuszące jest policzenie czegokolwiek w treści po stronie strony (na przykład liczby bloków obrazkowych do walidacji). To przykleja moduł kampanii do formatu edytora na stałe. Jeśli taka informacja jest potrzebna, dostarcza ją adapter w `validate()` albo `capabilities()`.

**Testy**

Integracyjny na sandboxie: zapis dokumentu i odczyt zwrotny z bazy z porównaniem struktury, odmowa zapisu w stanie `sent`, wykrycie konfliktu równoległej edycji, test izolacji tenanta na ścieżce zapisu. Dla warstwy web: testem sprawdzone zachowanie server action (walidacja, odmowa w złym stanie, konflikt); zrzutem ekranu sprawdzone, że edytor się montuje, paleta bloków nie ma bloku produktowego, a wstawiona grafika i podpowiedź zmiennych działają.

---

### Story 4.5: Odbiorcy kampanii jako zbiór list i segmentów z wykluczeniami

Jako operator, chcę wskazać odbiorców jako zestaw list i segmentów z wykluczeniami, żeby wysłać do właściwych ludzi i zobaczyć skalę przed decyzją.

**Pokrywa:** FR34 | **Rządzą:** AD-25, AD-9, AD-2, AD-3, AD-27 | **Jakość:** NFR9, NFR21, NFR35

**Kryteria akceptacji**

1. **Zakładając** kampanię i istniejące listy oraz segmenty tenanta (Epik 2), **kiedy** operator doda dwa segmenty jako włączenia i jedną listę jako wykluczenie, **wtedy** w `campaign_audience` powstają trzy wiersze z `mode` odpowiednio `include`, `include` i `exclude`, **oraz** próba dodania segmentu innego tenanta kończy się `not_found`.
2. **Zakładając** profil należący do obu włączonych segmentów, **kiedy** system liczy szacowaną liczebność, **wtedy** liczy go raz, **oraz** wynik jest liczbą unikalnych profili, nie sumą liczebności składników.
3. **Zakładając** profil obecny w segmencie włączonym i na liście wykluczonej, **kiedy** system liczy szacowaną liczebność, **wtedy** ten profil nie jest liczony.
4. **Zakładając** profil obecny na globalnej liście wykluczeń albo na liście wykluczeń tenanta albo bez ważnej zgody, **kiedy** system liczy szacowaną liczebność, **wtedy** nie jest liczony, **oraz** ekran pokazuje rozbicie: ilu odpadło przez wykluczenia, ilu przez brak zgody.
5. **Zakładając** wyliczoną liczebność, **kiedy** operator ją widzi, **wtedy** obok liczby jest data i godzina wyliczenia oraz zdanie mówiące wprost, że jest to szacunek na ten moment, a wiążące sprawdzenie odbywa się bezpośrednio przed wysyłką (AD-25).
6. **Zakładając** tenanta z 200 tysiącami profili, **kiedy** operator prosi o liczebność, **wtedy** wynik wraca poniżej 5 sekund (NFR21).
7. **Zakładając** kampanię bez ani jednego włączenia, **kiedy** operator próbuje zgłosić ją do akceptacji, **wtedy** przejście jest odrzucone z powodem `empty_audience`.

**Notatki implementacyjne**

Tabela `campaign_audience(id, tenant_id, campaign_id, kind text check (kind in ('list','segment')), ref_id uuid, mode text check (mode in ('include','exclude')), created_at)` plus unikalność `(campaign_id, kind, ref_id, mode)`. Szacunek trzymany na kampanii: `estimated_recipients integer`, `estimated_at timestamptz`.

Use-case `src/usecases/campaigns/set-campaign-audience.ts` i `estimate-campaign-audience.ts`. Zapytanie liczące w `src/adapters/db/audience-repo.ts` jednym `SELECT count(distinct p.id)` z `EXCEPT` na wykluczeniach, nie pętlą po składnikach.

**Tu nie materializujemy listy odbiorców.** Zbiór jest kandydatem, decyzją jest dopiero `canSendTo` w transakcji wysyłki po stronie Epiku 3 (AD-25). Między akceptacją klienta a startem wysyłki mijają dni, w tym czasie ludzie się wypisują.

Pułapki: żadne zapytanie bez predykatu `tenant_id` (AD-2). Wykluczenia sprawdzane na obu poziomach, globalnym i tenanta (AD-27), bo FR28 wymaga obu naraz. Adres normalizowany tak samo jak w `profiles_tenant_email_lower_idx`, inaczej wykluczenie z inną wielkością liter nie zadziała.

**Testy**

Integracyjny na sandboxie: profil w dwóch segmentach liczony raz, profil w wykluczeniu odjęty, profil na globalnej liście wykluczeń odjęty, profil bez zgody odjęty, rozbicie powodów zgodne z liczbami, test izolacji tenanta przy dodawaniu cudzego segmentu, pomiar czasu na zbiorze 200 tysięcy profili wygenerowanym w teście. Dla warstwy web: testem sprawdzona odmowa zgłoszenia kampanii z pustym zbiorem; zrzutem ekranu sprawdzony ekran odbiorców z liczbą, datą wyliczenia i zdaniem o szacunku.

---

### Story 4.6: Parametry śledzenia doklejane do linków kampanii

Jako klient sklepu, chcę widzieć ruch z maili w swojej analityce, żeby móc porównać kanał z innymi źródłami.

**Pokrywa:** FR38 | **Rządzą:** AD-32, AD-3, AD-2 | **Jakość:** NFR35

**Kryteria akceptacji**

1. **Zakładając** tenanta z domyślnym zestawem parametrów i kampanię bez nadpisania, **kiedy** renderowana jest treść, **wtedy** każdy link zewnętrzny ma dopisane parametry z konfiguracji tenanta, **oraz** wartości niedozwolone w URL są zakodowane procentowo, łącznie z polskimi znakami.
2. **Zakładając** link, który ma już własny query string i fragment (`?ref=x#sekcja`), **kiedy** doklejane są parametry, **wtedy** istniejące parametry i fragment pozostają nienaruszone, **oraz** parametry śledzenia trafiają przed fragment, nie za niego.
3. **Zakładając** link, który ma już parametr o tej samej nazwie, **kiedy** doklejane są parametry, **wtedy** wartość nie jest dublowana, a zastosowana reguła (zachowaj istniejącą albo nadpisz) jest jawna w konfiguracji i pokryta testem.
4. **Zakładając** treść zawierającą `mailto:`, `tel:`, kotwicę `#dol`, link wypisania i link do podglądu w przeglądarce, **kiedy** renderowana jest treść, **wtedy** żaden z nich nie dostaje parametrów śledzenia.
5. **Zakładając** ten sam dokument, **kiedy** renderować go dwukrotnie, **wtedy** linki są identyczne, a parametry nie zostają dopisane po raz drugi.
6. **Zakładając** treść z komentarzem warunkowym Outlooka i URL-em w atrybucie `style`, **kiedy** renderowana jest treść, **wtedy** dopisanie parametrów nie psuje tych fragmentów, **oraz** test źródłowy potwierdza, że w łańcuchu przekształceń nie ma operacji na gotowym HTML.
7. **Zakładając** kampanię, której nazwa zmieniła się po wysyłce, **kiedy** odczytać parametry z linków w wysłanej wiadomości, **wtedy** niosą one wartość zamrożoną w chwili renderowania, **oraz** raport klienta nie rozjeżdża się przez zmianę nazwy.

**Notatki implementacyjne**

Doklejanie parametrów to jeden z ogniw łańcucha przekształceń linku, a nie osobna operacja na HTML. `src/domain/campaign/link-transformers.ts` definiuje `type LinkTransformer = (url: URL, ctx: LinkContext) => URL`, use-case składa tablicę i podaje ją jako `rewriteLink` w `RenderInput`. Dzięki temu Epik 5 dokłada owijanie w link śledzony jako kolejny transformer, bez dotykania adaptera edytora.

Konfiguracja: `tenant_link_params(tenant_id pk, params jsonb, updated_at)` plus nadpisanie na kampanii `link_params jsonb`. Wartości mogą zawierać podstawienia: `{{campaign_slug}}`, `{{campaign_id}}`, `{{sent_date}}`. Slug kampanii wyliczany raz przy pierwszym zgłoszeniu do akceptacji i zamrażany w kolumnie `slug`, żeby zmiana nazwy nie rozjechała raportów w analityce klienta.

Pułapki: URL z placeholderem zmiennej w środku (`https://sklep.pl/{{kod}}`) nie jest poprawnym URL-em dla parsera, więc transformer musi go rozpoznać i przepuścić bez zmian albo zadziałać po podstawieniu wartości, ale nigdy nie może go rozwalić. Link wypisania i link podglądu w przeglądarce mają być oznaczone w dokumencie rolą, a nie rozpoznawane po treści adresu.

**Testy**

Integracyjny na sandboxie plus testy jednostkowe transformera na tablicy przypadków: czysty URL, URL z query, URL z fragmentem, URL z kolizją nazwy parametru, `mailto:`, `tel:`, kotwica, link wypisania, URL z placeholderem, URL z polskimi znakami w wartości parametru, dwukrotne renderowanie. Test na całym wyjściu rendererza sprawdzający komplet w `RenderOutput.links`. Test źródłowy: brak operacji tekstowych na HTML w ścieżce przekształcania linków. Dla warstwy web: zrzutem ekranu sprawdzony ekran konfiguracji parametrów z podglądem przykładowego linku po przekształceniu.

---

### Story 4.7: Podgląd na komputer i telefon oraz wysyłka testowa

Jako operator, chcę zobaczyć maila w dwóch szerokościach i wysłać go na własny adres, żeby wykryć błąd zanim zobaczy go dziesięć tysięcy osób.

**Pokrywa:** FR35 | **Rządzą:** AD-32, AD-25, AD-9, AD-3 | **Jakość:** NFR20, NFR32, NFR35

**Kryteria akceptacji**

1. **Zakładając** kampanię z treścią, **kiedy** operator otwiera podgląd i przełącza się między widokiem komputera a telefonu, **wtedy** obie ramki dostają ten sam, jeden raz wyrenderowany HTML, **oraz** różnica polega wyłącznie na szerokości ramki (1280 px i 375 px), co potwierdza asercja porównująca ciąg HTML podany do obu ramek.
2. **Zakładając** podgląd, **kiedy** sprawdzić wyjście, **wtedy** nie ma w nim piksela otwarcia, **oraz** poza pikselem wyjście jest identyczne z tym, które powstaje przy `mode: 'send'`.
3. **Zakładając** kampanię ze zmiennymi w treści, **kiedy** operator ogląda podgląd, **wtedy** zmienne mają podstawione wartości przykładowe podane przez tę samą warstwę, która podaje wartości przy wysyłce, **oraz** nieznana zmienna daje widoczne ostrzeżenie w `RenderOutput.warnings`, a nie pustą dziurę w treści.
4. **Zakładając** adres testowy podany przez operatora, **kiedy** zleca wysyłkę testową, **wtedy** adres przechodzi przez sprawdzenie obu list wykluczeń (globalnej i tenanta), **oraz** adres z globalnej listy wykluczeń jest odrzucany z jawnym powodem, także wtedy gdy operator upiera się, że to jego własna skrzynka.
5. **Zakładając** wysłany test, **kiedy** sprawdzić dane, **wtedy** powstał wiersz w `campaign_test_sends` z adresem, aktorem i czasem, **oraz** stan kampanii nie zmienił się, **oraz** nie powstał żaden rekord, który mógłby wejść do atrybucji.
6. **Zakładając** limit pięciu testów na godzinę na kampanię, **kiedy** operator zleca szósty, **wtedy** dostaje odmowę z podaniem, kiedy limit się odnowi.
7. **Zakładając** kampanię bez zweryfikowanej domeny wysyłkowej, **kiedy** operator zleca test, **wtedy** system odmawia i podaje ten powód wprost (FR45), a nie wyszarza przycisk bez wyjaśnienia.

**Notatki implementacyjne**

Use-case `src/usecases/campaigns/preview-campaign.ts` i `send-test-campaign.ts`. Oba wołają dokładnie tę samą funkcję renderującą co ścieżka wysyłki, różniącą się polem `mode` (`preview` / `test` / `send`). To jest reguła R8 z portu edytora i najważniejsza rzecz w tej story: druga ścieżka podglądu oznacza, że operator akceptuje co innego, niż dostaje odbiorca.

Wysyłka testowa kończy się na zleceniu: use-case rezerwuje wysyłkę i oddaje ją torowi wysyłkowemu z Epiku 3 przez port `EmailProvider`, z `idempotencyKey` równym identyfikatorowi rekordu testu. Wiadomość testowa nie idzie do tabeli `messages` jako wiadomość kampanijna, bo unikalność `(tenant_id, source_type, source_id, profile_id)` z AD-26 opiera się o profil, a adres testowy profilem być nie musi. Jeśli zapadnie decyzja, że jednak idzie, musi mieć własny `source_type` i flagę `is_test`, inaczej jedna testowa wysyłka zablokuje odbiorcy wiadomość właściwą.

W trybie `test` żaden transformer tworzący artefakty atrybucyjne nie jest rejestrowany, więc kliknięcie w mailu testowym nie zafałszuje raportu.

Ramki podglądu: `<iframe srcdoc>` z `sandbox`, żeby treść maila nie wykonała skryptu w panelu.

**Testy**

Integracyjny na sandboxie: identyczność HTML dla obu szerokości, brak piksela w podglądzie i obecność przy `send`, odmowa testu na adres z globalnej listy wykluczeń, odmowa po przekroczeniu limitu, odmowa przy niezweryfikowanej domenie, brak zmiany stanu kampanii i brak rekordów atrybucyjnych po teście. Dla warstwy web: testem sprawdzone odmowy i limit; zrzutem ekranu sprawdzone oba widoki podglądu obok siebie i komunikat odmowy z powodem.

---

### Story 4.8: Zgłoszenie kampanii do akceptacji i powiadomienie klienta

Jako operator, chcę zgłosić gotową kampanię do akceptacji, żeby klient zobaczył ją zanim cokolwiek wyjdzie.

**Pokrywa:** FR39 | **Rządzą:** AD-3, AD-17, AD-21, AD-13 | **Jakość:** NFR10, NFR35, NFR38

**Kryteria akceptacji**

1. **Zakładając** kampanię z treścią, tematem, nadawcą i niepustym zbiorem odbiorców, **kiedy** operator zgłasza ją do akceptacji, **wtedy** stan przechodzi na `pending_approval`, powstaje wiersz w `campaign_approvals` z terminem ważności ustawionym na 7 dni od chwili zgłoszenia, **oraz** wpis w `campaign_state_events` z jawnym `occurred_at`.
2. **Zakładając** kampanię bez tematu albo bez odbiorców, **kiedy** operator zgłasza ją do akceptacji, **wtedy** zgłoszenie jest odrzucone z listą brakujących elementów, a nie pojedynczym komunikatem „uzupełnij dane".
3. **Zakładając** tenanta z użytkownikami w roli `owner`, **kiedy** kampania zostaje zgłoszona, **wtedy** każdy z nich dostaje maila zawierającego nazwę kampanii, temat, planowany termin i link do widoku akceptacji, **oraz** treść maila niesie początek wersji tekstowej kampanii jako podgląd, a pełny podgląd jest pod linkiem.
4. **Zakładając** powiadomienie o akceptacji, **kiedy** sprawdzić, z jakiej domeny wyszło, **wtedy** wyszło z domeny MidRev, a nie z domeny wysyłkowej tenanta, **oraz** wysłanie powiadomienia nie jest blokowane przez brak weryfikacji domeny tenanta ani przez plan warmupu (FR45, FR46).
5. **Zakładając** wysłane powiadomienie, **kiedy** sprawdzić dane, **wtedy** powstał wiersz w `campaign_notifications` z adresem, rodzajem, identyfikatorem u dostawcy i czasem, **oraz** w logu aplikacji nie ma ani adresu e-mail, ani tokenu (konwencja logów, AD-13).
6. **Zakładając** kampanię już zgłoszoną, **kiedy** operator zgłasza ją ponownie po poprawkach, **wtedy** poprzedni token przestaje działać, powstaje nowy, **oraz** stary link zwraca stronę „ten link jest nieaktualny" zamiast błędu serwera.
7. **Zakładając** operatora z uprawnieniem do akceptacji (macierz uprawnień z PRD), **kiedy** akceptuje kampanię z poziomu panelu, **wtedy** przechodzi to przez ten sam use-case co decyzja klienta, tylko z innym aktorem, **oraz** w `campaign_state_events` widać, kto zdecydował.

**Notatki implementacyjne**

Tabele: `campaign_approvals(id, tenant_id, campaign_id, requested_at, requested_by, token_hash text not null, token_expires_at timestamptz not null, used_at, decision text, decided_at, decided_by text, comment text, revoked_at)` oraz `campaign_notifications(id, tenant_id, campaign_id, recipient_email, kind, provider_message_id, sent_at)`.

Use-case: `src/usecases/campaigns/request-approval.ts` i `decide-campaign-approval.ts`. Drugi przyjmuje aktora, którym może być użytkownik z sesji albo posiadacz ważnego tokenu, i to jest jedyne miejsce zmieniające stan akceptacji (AD-3).

Powiadomienie do klienta nie jest wiadomością kampanijną. Idzie przez port `EmailProvider` z konta i domeny MidRev, z własnym `source_type`. Nie wchodzi do `messages`, bo tam unikalność opiera się o `profile_id`, a odbiorcą jest użytkownik tenanta, nie profil odbiorcy.

Token: 32 losowe bajty, w bazie tylko `sha256`, w linku postać bezpieczna dla URL. Nie da się go odzyskać z bazy, ponowne wysłanie tego samego linku wymaga wygenerowania nowego zgłoszenia.

**Testy**

Integracyjny na sandboxie: zgłoszenie tworzy rekord z terminem 7 dni, odmowa przy brakach z pełną listą braków, unieważnienie poprzedniego tokenu przy ponownym zgłoszeniu, wpis w `campaign_notifications`, brak tokenu i adresu w logu, akceptacja przez operatora przechodząca tym samym use-case, test izolacji tenanta. Dla warstwy web: testem sprawdzona odmowa zgłoszenia niekompletnej kampanii; zrzutem ekranu sprawdzony ekran kampanii w stanie oczekiwania na akceptację oraz treść maila powiadomienia w kliencie pocztowym.

---

### Story 4.9: Akceptacja albo uwagi klienta bez logowania

Jako klient sklepu, chcę zaakceptować kampanię albo zgłosić uwagi z linka w mailu, żeby nie zakładać konta i nie szukać hasła.

**Pokrywa:** FR40 | **Rządzą:** AD-3, AD-17, AD-13 | **Jakość:** NFR10, NFR20, NFR32, NFR33, NFR35

**Kryteria akceptacji**

1. **Zakładając** ważny token, **kiedy** klient otwiera link, **wtedy** widzi nazwę kampanii, temat, planowany termin, pełny podgląd treści i dwa przyciski, **oraz** nie ma po drodze żadnego ekranu logowania.
2. **Zakładając** ważny token, **kiedy** klient klika „akceptuję", **wtedy** stan kampanii przechodzi na `approved`, w `campaign_approvals` ustawiają się `used_at`, `decision` i `decided_at`, powstaje wpis w `campaign_state_events` z aktorem typu `client_token`, **oraz** operator dostaje powiadomienie.
3. **Zakładając** ważny token, **kiedy** klient wybiera „zgłoś uwagi" i wpisuje tekst do 2000 znaków, **wtedy** stan przechodzi na `changes_requested`, uwagi są widoczne w panelu operatora, zaplanowany termin zostaje anulowany, **oraz** operator dostaje powiadomienie z treścią uwag.
4. **Zakładając** token użyty do podjęcia decyzji, **kiedy** ten sam link zostanie otwarty ponownie, **wtedy** strona pokazuje, jaka decyzja i kiedy zapadła, bez przycisków, **oraz** żądanie zapisu tym tokenem zwraca 410 i nie zmienia stanu (NFR10: token jednorazowy).
5. **Zakładając** token wystawiony 7 dni i 1 minutę temu, **kiedy** klient otwiera link, **wtedy** strona mówi, że link wygasł i co zrobić (poprosić operatora o nowy), **oraz** kampania pozostaje w `pending_approval`, a nie przechodzi w żaden stan końcowy.
6. **Zakładając** ważny token kampanii X, **kiedy** ktoś podmieni w adresie identyfikator na kampanię Y, **wtedy** nie ma czego podmieniać, bo adres niesie wyłącznie token, a identyfikator kampanii pochodzi z rekordu tokenu, **oraz** token nie otwiera dostępu do panelu, raportu ani innej kampanii (NFR10: zakres jednej kampanii).
7. **Zakładając** kampanię z terminem, który już minął, **kiedy** klient akceptuje po tym terminie, **wtedy** kampania przechodzi na `approved` z adnotacją, że termin minął, **oraz** system nie wysyła jej automatycznie, **oraz** operator dostaje powiadomienie z prośbą o ustawienie nowego terminu.
8. **Zakładając** endpoint tokenowy, **kiedy** z jednego adresu IP przyjdzie 21 żądań w minucie, **wtedy** kolejne są odrzucane, **oraz** porównanie tokenu z bazą odbywa się w stałym czasie na sumie kontrolnej, a token nigdy nie trafia do logu ani do adresu odsyłacza.
9. **Zakładając** telefon o szerokości 360 px, **kiedy** klient otwiera widok akceptacji, **wtedy** strona nie przewija się poziomo, przyciski mieszczą się w kciuk, a podgląd maila skaluje się do szerokości ekranu (NFR32).
10. **Zakładając** dowolny stan widoku (oczekuje, zaakceptowana, zgłoszono uwagi, wygasła), **kiedy** stan jest pokazywany, **wtedy** niesie tekst i znak graficzny, a nie sam kolor (NFR33).

**Notatki implementacyjne**

Trasa `src/app/(klient)/akceptacja/[token]/page.tsx` plus server action `decide.action.ts`, oba jako cienkie opakowanie `decide-campaign-approval` z Story 4.8 (AD-17). Widok stoi poza sesją, więc tenant pochodzi z rekordu tokenu, nie z sesji i nie z żądania. To jedyny dopuszczalny wyjątek od AD-21 i musi być w kodzie opisany komentarzem, żeby nie stał się wzorcem do kopiowania.

Zapytanie po tokenie: `where token_hash = $1 and revoked_at is null` i dopiero potem sprawdzenie `token_expires_at` oraz `used_at` w kodzie, żeby rozróżnić „wygasł" od „już użyty" i pokazać właściwy komunikat.

Podgląd treści renderowany tą samą ścieżką co wysyłka, z `mode: 'preview'`, w ramce z `sandbox`. Klient nie może dostać podglądu z pikselem otwarcia, bo wtedy statystyka otwarć kampanii ruszy przed wysyłką.

Kryterium 7 jest decyzją, nie skutkiem ubocznym: cicha wysyłka o północy dwa dni po terminie jest gorsza niż brak wysyłki. Z tego samego powodu akceptacja nigdy nie przestawia sama terminu.

**Testy**

Integracyjny na sandboxie: akceptacja, zgłoszenie uwag, ponowne użycie tokenu (410, brak zmiany stanu), token po 7 dniach (odmowa, kampania nadal `pending_approval`), akceptacja po minionym terminie (stan `approved`, zero zleceń wysyłki, powiadomienie operatora), token unieważniony ponownym zgłoszeniem, brak dostępu do innej kampanii tym samym tokenem, brak tokenu w logu. Dla warstwy web: testem sprawdzone kody odpowiedzi (200, 410, 429) i to, że akcja bez ważnego tokenu nie zmienia stanu; zrzutem ekranu w przeglądarce sprawdzony widok na 360 px i 1280 px oraz cztery stany widoku w wersji czarno-białej, żeby udowodnić, że stan czyta się bez koloru.

---

### Story 4.10: Harmonogram i wysyłka natychmiastowa

Jako operator, chcę zaplanować wysyłkę na konkretny moment albo puścić ją od razu, żeby trafić w porę uzgodnioną z klientem.

**Pokrywa:** FR36 | **Rządzą:** AD-3, AD-5, AD-17, AD-25, AD-31, AD-10 | **Jakość:** NFR15, NFR35

**Kryteria akceptacji**

1. **Zakładając** kampanię w stanie `approved`, **kiedy** operator planuje wysyłkę na 3 września o 10:00 w strefie tenanta, **wtedy** `scheduled_at` zapisuje się w UTC, `schedule_timezone` przechowuje nazwę strefy, stan przechodzi na `scheduled`, **oraz** w kolejce powstaje zadanie w tej samej transakcji co zmiana stanu.
2. **Zakładając** kampanię w stanie `approved`, **kiedy** operator wybiera wysyłkę natychmiastową, **wtedy** stan przechodzi na `scheduled` z terminem równym chwili obecnej i zadaniem gotowym do zajęcia, **oraz** interfejs mówi, że wysyłka została zlecona, a nie że została dostarczona.
3. **Zakładając** kampanię z `approval_required = true` bez akceptacji, **kiedy** operator próbuje zaplanować albo wysłać natychmiast, **wtedy** operacja jest odrzucona z kodem `approval_missing` i zdaniem wyjaśniającym, **oraz** żadne zadanie w kolejce nie powstaje.
4. **Zakładając** tenanta bez zweryfikowanej domeny wysyłkowej, **kiedy** operator planuje wysyłkę, **wtedy** operacja jest odrzucona z powodem wskazującym domenę (FR45).
5. **Zakładając** termin w przeszłości, **kiedy** operator go poda, **wtedy** operacja jest odrzucona, **oraz** komunikat podaje aktualny czas w strefie tenanta, żeby było widać, o co poszło.
6. **Zakładając** operatora klikającego „wyślij" dwa razy w ciągu sekundy, **kiedy** oba żądania dojdą, **wtedy** powstaje dokładnie jedno aktywne zadanie wysyłki dla tej kampanii, co wymusza częściowy indeks unikalny, a nie sprawdzenie w kodzie.
7. **Zakładając** transakcję zlecającą wysyłkę, **kiedy** prześledzić jej kod, **wtedy** nie ma w niej żadnego wywołania sieciowego (AD-31), **oraz** use-case kończy się na zleceniu: materializacja odbiorców, `canSendTo` i wywołanie dostawcy należą do silnika z Epiku 3.

**Notatki implementacyjne**

Use-case `src/usecases/campaigns/schedule-campaign.ts` (wysyłka natychmiastowa to ten sam use-case z terminem `now()`, nie druga ścieżka). Zadanie w tabeli `jobs` typu `campaign.dispatch` z `run_after = scheduled_at` i ładunkiem `{ campaignId }`, bez kopiowania treści kampanii do ładunku, bo treść może się jeszcze zmienić.

Częściowy indeks unikalny: `create unique index on jobs ((payload->>'campaignId')) where job_type = 'campaign.dispatch' and state in ('pending','running')`, albo równoważna kolumna dedykowana. To jest zabezpieczenie przed podwójnym kliknięciem, którego kod aplikacji nie da rady zagwarantować.

Strefa czasowa: klient i operator myślą lokalnie, baza trzyma UTC (AD-10). Zapisujemy jedno i drugie, bo sama chwila w UTC nie wystarcza, żeby po zmianie czasu pokazać właściwą godzinę w interfejsie.

Bramka akceptacji sprawdzana tu jest bramką miękką, ustawianą w chwili zlecania. Bramką twardą, sprawdzaną tuż przed wysyłką, jest `canSendTo` i sprawdzenie stanu kampanii po stronie workera (AD-25). Obie są potrzebne, bo między zleceniem a startem mijają godziny.

**Testy**

Integracyjny na sandboxie: zaplanowanie zapisuje UTC i strefę, natychmiastowa daje zadanie gotowe do zajęcia, odmowa bez akceptacji, odmowa bez zweryfikowanej domeny, odmowa dla terminu w przeszłości, dwa równoległe zlecenia dają jedno zadanie (test z dwoma połączeniami, nie z pętlą), brak wywołań sieciowych w transakcji zlecającej. Dla warstwy web: testem sprawdzone kody odmów; zrzutem ekranu sprawdzony wybór terminu ze strefą tenanta i komunikat mówiący „zlecone", nie „wysłane".

---

### Story 4.11: Odwołanie kampanii zaplanowanej i wstrzymanie w trakcie wysyłki

Jako operator, chcę odwołać zaplanowaną kampanię i wstrzymać tę, która już leci, żeby zatrzymać błąd, zanim dojdzie do wszystkich.

**Pokrywa:** FR37 | **Rządzą:** AD-3, AD-22, AD-23, AD-25, AD-26 | **Jakość:** NFR15, NFR16, NFR33, NFR35

**Kryteria akceptacji**

1. **Zakładając** kampanię w stanie `scheduled`, **kiedy** operator ją odwołuje, **wtedy** stan przechodzi na `cancelled`, zadanie `campaign.dispatch` zostaje oznaczone jako anulowane, **oraz** po upływie zaplanowanego terminu nie powstaje ani jedna wiadomość.
2. **Zakładając** kampanię w stanie `sending`, **kiedy** operator ją wstrzymuje, **wtedy** stan przechodzi na `paused` ze znacznikiem `paused_at`, **oraz** liczba wiadomości, które przeszły `queued → sending` z `occurred_at` późniejszym niż `paused_at` powiększonym o 5 sekund, wynosi zero.
3. **Zakładając** wstrzymaną kampanię, **kiedy** operator patrzy na ekran, **wtedy** widzi rozbicie liczbowe: ile poszło, ile czeka, ile odpadło, **oraz** zdanie mówiące wprost, że wiadomości już przekazanych dostawcy nie da się cofnąć.
4. **Zakładając** kampanię w stanie `paused`, **kiedy** operator ją wznawia, **wtedy** stan wraca do `sending`, **oraz** żaden odbiorca, który już dostał wiadomość, nie dostaje jej drugi raz, co wymusza unikalność `(tenant_id, source_type, source_id, profile_id)` z AD-26, a nie sprawdzenie w kodzie workera.
5. **Zakładając** kampanię w stanie `paused`, **kiedy** operator ją odwołuje, **wtedy** stan przechodzi na `cancelled`, a wiadomości czekające w kolejce nie zostaną wysłane nigdy, także po restarcie procesu.
6. **Zakładając** kampanię w stanie `sent`, **kiedy** operator próbuje ją odwołać, **wtedy** operacja jest odrzucona z kodem `invalid_state_transition` i zdaniem wyjaśniającym, że wysłanego maila nie da się odwołać.

**Notatki implementacyjne**

Use-case `src/usecases/campaigns/cancel-campaign.ts`, `pause-campaign.ts`, `resume-campaign.ts`. Egzekucja należy do workera z Epiku 3, ta story dostarcza mu bramkę: funkcję `assertCampaignDispatchable(tenantId, campaignId)` wołaną przez workera w tej samej transakcji, w której zajmuje partię i w której robi przejście `queued → sending` (AD-25). To nie jest druga ścieżka wysyłki, tylko jedno sprawdzenie w dwóch miejscach, w których worker już i tak trzyma transakcję.

Pięć sekund tolerancji z kryterium 2 to jawnie przyjęty czas dolotu wstrzymania do partii już zajętej. Jeśli okaże się większy, zmienia się liczba w teście i w komunikacie dla operatora, ale nie sposób pomiaru.

Ekran ma pokazywać liczby, nie pasek postępu bez wartości: „poszło 1240, wstrzymano 8760" to informacja, po której da się podjąć decyzję. Stan kampanii oznaczony słowem i ikoną, nie samym kolorem (NFR33).

Pułapka: anulowanie zadania w kolejce przez `DELETE` gubi ślad. Zadanie oznaczamy jako anulowane z powodem, a partycja i tak zniknie z `DROP PARTITION` (AD-31).

**Testy**

Integracyjny na sandboxie z workerem uruchomionym w teście: odwołanie przed terminem daje zero wiadomości po terminie, wstrzymanie w trakcie daje zero przejść `queued → sending` po znaczniku plus tolerancja, wznowienie nie duplikuje (podwójne uruchomienie workera na tej samej kampanii, asercja na unikalności w bazie, nie na liczniku w kodzie), odwołanie po wstrzymaniu, odmowa dla stanu `sent`. Dla warstwy web: testem sprawdzone odmowy i kody; zrzutem ekranu sprawdzony ekran wstrzymanej kampanii z rozbiciem liczbowym i zdaniem o nieodwracalności.

---

### Story 4.12: Brak akceptacji o zaplanowanej porze wstrzymuje wysyłkę

Jako operator, chcę, żeby kampania bez akceptacji nie wyszła po cichu i żebym się o tym dowiedział, bo cisza w tym miejscu kosztuje relację z klientem.

**Pokrywa:** FR41 | **Rządzą:** AD-3, AD-5, AD-25 | **Jakość:** NFR35, NFR38

**Kryteria akceptacji**

1. **Zakładając** kampanię w stanie `scheduled` z `approval_required = true` i bez akceptacji, **kiedy** nadejdzie zaplanowany termin, **wtedy** stan przechodzi na `blocked_no_approval`, **oraz** liczba utworzonych wiadomości wynosi zero, **oraz** zadanie `campaign.dispatch` kończy się bez błędu, nie przez wyjątek.
2. **Zakładając** zablokowaną kampanię, **kiedy** blokada zapada, **wtedy** operator dostaje alert kanałem alertowym zawierający nazwę kampanii, tenanta, planowany termin, powód i jedno zdanie, co z tym zrobić (NFR38), **oraz** ten sam fakt jest widoczny na ekranie kampanii, a nie tylko w kanale.
3. **Zakładając** kampanię zaplanowaną na termin odległy o więcej niż 24 godziny i nadal bez akceptacji, **kiedy** do terminu zostaje 24 godziny, **wtedy** klient dostaje jedno przypomnienie z tym samym linkiem, o ile token jest nadal ważny, **oraz** operator widzi w panelu, że przypomnienie poszło.
4. **Zakładając** zablokowaną kampanię, **kiedy** zadanie sprawdzające uruchomi się ponownie, **wtedy** nie powstaje drugi alert ani drugie przypomnienie, co wymusza unikalność `(campaign_id, kind)` na tabeli powiadomień, a nie warunek w kodzie.
5. **Zakładając** kampanię zablokowaną z powodu braku akceptacji, **kiedy** klient akceptuje ją później, **wtedy** kampania przechodzi na `approved`, ale nie zostaje wysłana automatycznie, **oraz** operator musi ustawić nowy termin (spójne ze Story 4.9, kryterium 7).
6. **Zakładając** kampanię z `approval_required = false`, **kiedy** nadejdzie termin, **wtedy** wysyłka jest zlecana normalnie, **oraz** ten wyjątek jest ustawiany świadomie na poziomie kampanii, a nie domyślnie.

**Notatki implementacyjne**

Handler `src/jobs/campaign-dispatch.ts` w części bramkującej: przed przekazaniem kampanii silnikowi sprawdza stan akceptacji, weryfikację domeny i stan kampanii (`cancelled`, `paused`). Sprawdzenie idzie przez ten sam `assertCampaignDispatchable` co w Story 4.11, żeby nie powstała druga lista warunków, która z czasem rozjedzie się z pierwszą.

Przypomnienie 24 godziny przed terminem to osobny, idempotentny job `campaign.approval-reminder`, planowany w chwili zgłoszenia do akceptacji, nie skanowanie całej tabeli co minutę.

Kanał alertowy zgodnie z konwencją spine'u: strukturalny JSON z `tenant_id` i `correlation_id`, wysyłka na kanał techniczny. `console.error` nie jest alertem, tego błędu projekt już raz doświadczył.

**Testy**

Integracyjny na sandboxie z przesuniętym zegarem: termin mija bez akceptacji, stan przechodzi na `blocked_no_approval`, zero wiadomości, jeden alert; ponowne uruchomienie joba nie tworzy drugiego alertu; przypomnienie wychodzi raz na 24 godziny przed terminem; akceptacja po blokadzie nie zleca wysyłki; kampania z `approval_required = false` przechodzi dalej. Dla warstwy web: testem sprawdzone, że ekran kampanii pokazuje powód blokady; zrzutem ekranu sprawdzony wygląd tego ekranu i treść alertu w kanale technicznym.
