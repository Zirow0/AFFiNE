# Форк AFFiNE: власний хостинг без AFFiNE Cloud

Робочі нотатки форку. Мета: прибрати залежність від хмарного сервісу AFFiNE,
зосередитися на self-hosted і зробити зручне підключення власних AI-провайдерів.

Цільові платформи: **сервер**, **web** (+ мобільна web-версія, яку сервер
роздає разом із web), **адмін-панель**, **desktop Linux x64**.

## 1. Середовище

Скрипт `scripts/selfhost-dev/setup.sh` готує все одним запуском. Його можна
запускати й частинами: `deps`, `services`, `native`, `migrate`, `frontend`,
`desktop`.

| Що         | Версія / примітка              |
| ---------- | ------------------------------ |
| Node.js    | 22.x (`>=22.12 <23`)           |
| Yarn       | 4.18 через corepack            |
| Rust       | 1.97.1 (`rust-toolchain.toml`) |
| PostgreSQL | 16 + розширення **pgvector**   |
| Redis      | будь-який 7.x                  |

Перевірено в цьому середовищі (4 CPU, 16 ГБ RAM):

| Крок                   | Команда                                                                                            | Час    |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| Залежності             | `yarn install` (+ `node node_modules/electron/install.js`)                                         | ~2 хв  |
| Server native (Rust)   | `yarn affine @affine/server-native build`                                                          | ~20 хв |
| Frontend native (Rust) | `yarn affine @affine/native build`                                                                 | ~7 хв  |
| Міграції БД            | `yarn prisma migrate deploy && yarn data-migration run` у `packages/backend/server`                | <1 хв  |
| Admin                  | `BUILD_TYPE=stable yarn affine bundle -p @affine/admin`                                            | ~15 с  |
| Web                    | `BUILD_TYPE=stable yarn affine bundle -p @affine/web`                                              | ~5 хв  |
| Mobile web             | `BUILD_TYPE=stable yarn affine bundle -p @affine/mobile`                                           | ~5 хв  |
| Desktop Linux          | `yarn affine @affine/electron build && … generate-assets && … package --platform=linux --arch=x64` | ~5 хв  |
| Запуск сервера         | `cd packages/backend/server && yarn r ./src/index.ts` → http://localhost:3010                      |        |

### Підводні камені

1. **`yarn affine server init` зависає.** Він викликає `prisma migrate dev`,
   а та чекає інтерактивного вводу. Використовуйте `prisma migrate deploy`.
2. **Режим selfhosted задається файлом конфігурації.** Сервер вмикає його,
   якщо знаходить `~/.affine/config/config.json` або
   `packages/backend/server/config.json` з `"deployment": {"type": "selfhosted"}`.
   Змінна `DEPLOYMENT_TYPE` у dev-режимі працює лише як резервний варіант
   (`src/env.ts`).
3. **`AFFINE_PRO_PUBLIC_KEY`.** Self-hosted сервер не стартує без публічного
   ключа ліцензії, вбудованого в `@affine/server-native` під час компіляції
   (`packages/backend/native/src/lib.rs`, `base/helpers/crypto.ts`). Для
   розробки скрипт підставляє тестовий ключ із
   `.github/workflows/build-test.yml`. **Це одне з перших місць, яке треба
   переробити у форку** (див. розділ 2).
4. **Серверу потрібні всі три фронтенди.** Сервер падає, якщо немає
   `static/mobile/assets-manifest.json`. Каталог `packages/backend/server/static`
   має містити web (корінь), `mobile/` і `admin/`.
5. **Linux перегенеровує NAPI-обгортки.** Збірка `@affine/native` на Linux
   переписує `packages/frontend/native/index.{js,d.ts}` без macOS-символів.
   Ці зміни не можна комітити (скрипт сам їх відкочує).
6. **Постійний приватний ключ для BYOK.** Коли BYOK увімкнено, сервер вимагає
   стабільний `crypto.privateKey`, яким шифруються збережені ключі провайдерів.
   Без нього отримаєте помилку
   `stable crypto.privateKey is required when persistent BYOK is enabled`.
   Ключ читається з `AFFINE_PRIVATE_KEY` або з `~/.affine/config/private.key`
   (EC prime256v1, PKCS#8 PEM). Скрипт генерує його автоматично. Якщо ключ
   загубити, збережені BYOK-ключі не розшифруються.
7. **Інсталятори desktop.** AppImage, deb і flatpak (`electron make`) потребують
   додаткових системних пакетів (`fakeroot`, `dpkg`, `flatpak-builder`).
   `package` дає робочу розпаковану збірку без них.

## 2. Ліцензія: що важливо знати

- Усе під `packages/backend/**` і `packages/common/native` поширюється за
  **AFFiNE Enterprise Edition License**. Код можна змінювати й запускати для
  розробки й тестування. Для production потрібна підписка AFFiNE EE, а права на
  модифікації залишаються за AFFiNE.
- Решта коду (frontend, blocksuite, `packages/common/*` окрім `native`) має
  ліцензію **MIT**.
- Сторонні Rust-крейти `affine_core`, `llm_adapter` і `llm_runtime` мають
  ліцензію **AGPL-3.0**.

Перед production-розгортанням форка сервера варто окремо вирішити юридичне
питання. Від цього залежить, чи можна взагалі змінювати серверну частину (зокрема
перевірку ліцензії), чи краще обмежитися налаштуваннями.

## 3. Хмара AFFiNE: де вона «зашита»

### Сервер

- `src/app.module.ts`: модулі підключаються умовно. Для selfhosted уже
  вмикаються `SelfhostModule` і `WorkerModule`. `PaymentModule`,
  `LicenseModule`, `CopilotModule`, `CaptchaModule`, `OAuthModule` і
  `CalendarModule` підключаються завжди у flavor `graphql`; їх можна прибрати
  через `useIf(() => !env.selfhosted, …)`.
- `GCloudModule` вмикається лише при `DEPLOYMENT_PLATFORM=gcp`.
- `plugins/payment` і `plugins/license` разом із Rust-частиною
  (`native/src/runtime/backend_runtime/payment/**`, `license*.rs`) реалізують
  Stripe і RevenueCat, плани Pro/Team/AI та ліцензію Self-Host Team.
- Квоти й entitlements (`core/quota`, `native/.../entitlement`) прив'язані до
  планів. Для selfhosted більшість лімітів уже знята, але логіка ліцензії
  Team залишається.
- `core/telemetry`: серверна телеметрія.

### Frontend (web, desktop)

- `packages/frontend/core/src/modules/cloud/constant.ts` (`BUILD_IN_SERVERS`):
  для збірок `stable`, `beta`, `canary` і `internal` у desktop вбудований
  сервер `affine-cloud` з адресами `app.affine.pro`, `insider.affine.pro`,
  `affine.fail` і `apple.getaffineapp.com`. Для web у selfhosted-режимі
  (`environment.isSelfHosted`, файл `selfhost.html`) сервер дорівнює
  `location.origin`.
- `modules/cloud/services/default-server.ts`: «глобальний сервер завжди
  `affine-cloud`». Його використовують близько 21 файлу.
- Там же `getOfficialTelemetryEndpoint`: телеметрію відправляють на сервери
  AFFiNE.
- `tools/utils/src/build-config.ts`: `changelogUrl`, `downloadUrl`,
  `pricingUrl`, `discordUrl`, `requestLicenseUrl` і Sentry DSN.
- `packages/frontend/track`: Sentry і аналітика.
- Desktop: `apps/electron/src/main/updater/*` (автооновлення з GitHub
  toeverything), `application-menu`, `protocol.ts`, `security/redirect-proxy.ts`.
- UI з посиланнями на хмару й тарифи: `modules/paywall`, `desktop/dialogs/setting/general-setting/plans`,
  `components/sign-in/*`, `app-sidebar/views/app-download-button`,
  `open-in-app-card`, `share-footer`, `about`.

### План відключення (пропозиція)

1. Додати build-флаг (наприклад `BUILD_CONFIG.selfhostOnly` або окремий
   `appBuildType`), за яким `BUILD_IN_SERVERS` для desktop не містить
   `affine-cloud`, а адресу сервера задає користувач (є `add-selfhosted.tsx`)
   або вона вшивається під час збирання.
2. Переробити `DefaultServerService`, щоб він не залежав від id `affine-cloud`.
3. Вимкнути телеметрію, Sentry і автооновлення від toeverything (або направити
   на власні адреси).
4. Сховати UI тарифів, оплати, «Download app» і посилань на affine.pro.
5. На сервері не підключати `PaymentModule` і `LicenseModule` для selfhosted
   і прибрати вимогу `AFFINE_PRO_PUBLIC_KEY` (з урахуванням розділу 2).

## 4. AI-провайдери: як влаштовано зараз

Більша частина логіки написана на Rust: `packages/backend/native/src/llm/**`
плюс зовнішні крейти `llm_adapter` і `llm_runtime`. Node-шар
(`packages/backend/server/src/plugins/copilot`) у цій частині тонкий.

Є два механізми.

**A. Керовані профілі сервера** (`copilot.providers.profiles` у config.json).

- Типи: `openai`, `anthropic`, `anthropicVertex`, `gemini`, `geminiVertex`,
  `fal`, `cloudflareWorkersAi` (`providers/types.ts`, `config.ts`).
- Профіль має вигляд `{ id, type, config, models, priority, enabled, middleware }`.
- **В адмін-панелі не редагується.** `admin/src/modules/settings/config.ts`
  показує лише `copilot.enabled` і `byok.*`. Профілі можна задати тільки
  вручну через JSON.

**B. BYOK (власні ключі на рівні робочого простору).**

- Сервер: `plugins/copilot/byok/*` (GraphQL `byokSettings`,
  `createWorkspaceByokProfile`…). Rust: `native/src/llm/byok/*`.
- UI: «Налаштування робочого простору → Integrations → AI BYOK»
  (`core/src/desktop/dialogs/setting/workspace-setting/byok/*`).
- Провайдери: `openai`, `anthropic`, `gemini`, `fal` (жорсткий список у
  `ByokProvider` і `byok/catalog.rs`).
- **OpenAI-сумісний endpoint** (`ByokEndpointKind.openai_compatible`, діалекти
  `responses` і `chat_completions`) доступний **лише в selfhosted**, коли
  `copilot.byok.allowCustomEndpoint = true`. Приватні адреси (localhost, LAN,
  тобто Ollama, LM Studio чи vLLM у локальній мережі) додатково потребують
  `allowPrivateEndpoint`.
- Ключі зберігаються на сервері (зашифровано) або локально в браузері.
- Доступ у selfhosted: дозволено будь-якому робочому простору з власником
  (`affine_core::evaluate_byok_access`, гілка `SelfHosted`). Платний план не
  потрібен.

Мінімальний `config.json`, щоб AI запрацював через BYOK. Перевірено:
`serverConfig.features` містить `Copilot`. Також потрібен `private.key`,
див. підводний камінь 6.

```json
{
  "deployment": { "type": "selfhosted" },
  "copilot": {
    "enabled": true,
    "byok.enabled": true,
    "byok.allowedProviders": ["openai", "anthropic", "gemini", "fal"],
    "byok.allowCustomEndpoint": true,
    "byok.allowPrivateEndpoint": true
  }
}
```

### Що незручно і що можна покращити

1. **Немає налаштування на рівні інстансу.** Кожен робочий простір додає
   ключі окремо. Варто мати «провайдер за замовчуванням для всього сервера»,
   який задає адмін (по суті UI для керованих профілів A).
2. **Адмін-панель не вміє редагувати `providers.profiles`.** Потрібна
   сторінка: список провайдерів, додавання (тип, base URL, ключ, моделі),
   перевірка з'єднання (у BYOK уже є `ByokProbeOperation`) і пріоритети.
3. **OpenAI-сумісні провайдери не виділені окремо.** Зараз це прапорець
   «custom endpoint» усередині OpenAI. Можна зробити окремі пресети (Ollama,
   OpenRouter, DeepSeek, Mistral, LM Studio, vLLM, Azure OpenAI) з готовими
   URL і діалектами.
4. **Каталог моделей фіксований** і береться з `llm_adapter`. Для власних
   endpoint моделі вводять вручну. Можна додати автоматичне отримання списку
   моделей (`GET /v1/models`).
5. **Призначення моделей на сценарії** (чат, embeddings, rerank, зображення,
   транскрипція) зараз визначається capability-матчингом у Rust
   (`llm/route/*`, `core/model_registry.rs`). Потрібен UI, де адмін явно
   вибирає модель для кожного сценарію.
6. **Embeddings і rerank** для пошуку по робочому простору (`workspace-indexer-embedding`)
   потребують окремої моделі. Без неї AI-пошук по документах не працює.

## 5. Перевірка офіційних збірок без інтернету (0.27.4)

Стенд:

- **Сервер:** офіційний образ `ghcr.io/toeverything/affine:stable` (0.27.4) з
  `.docker/selfhost/compose.yml`. Усі контейнери (AFFiNE, Postgres, Redis,
  Ollama) підключені до Docker-мережі `internal: true`, тож виходу в інтернет
  немає. Сервер у логах: `getaddrinfo EAI_AGAIN affine.pro`.
- **Провайдер:** Ollama (`qwen2.5:0.5b`) у тій самій мережі,
  `http://172.30.0.20:11434/v1`.
- **Клієнти:** web із сервера та офіційний desktop
  `affine-0.27.4-stable-linux-x64.zip`.

Результат: AI-чат відповідає через Ollama і в web, і в desktop.

Робочий порядок налаштування:

1. `config.json`: `copilot.enabled`, `copilot.byok.enabled`,
   `allowCustomEndpoint` і `allowPrivateEndpoint` = `true`.
2. **Адмін-панель → Settings → AI BYOK: перемкнути кожен із чотирьох перемикачів
   (вимкнути, зберегти, увімкнути, зберегти).** У 0.27.4 значення з
   `config.json` видно в адмін-панелі та в `appConfig`, але Rust-runtime
   їх не застосовує. Поки значення не збережені через адмін-панель, маємо
   `customEndpointMode: disabled` і помилку чату `copilot_disabled`. Ключі
   через крапку чи вкладені — однаково.
3. Workspace → Settings → Integrations → AI BYOK → Add key: провайдер
   **OpenAI**, Storage **Server**, будь-який API key, увімкнути «Use a custom
   API-compatible endpoint», Endpoint `http://<ollama>:11434/v1`, dialect
   **Chat Completions API**, Add model: ID `qwen2.5:0.5b`, позначити
   **Chat & writing + Actions + Structured output**. Далі Test connection
   (має бути «Connection verified») і Connect.
   - Якщо позначити лише «Chat & writing», чат падає з `no_compatible_target`:
     він вимагає виклику інструментів (Actions).
4. BYOK працює лише в **серверних** робочих просторах. Локальний простір
   спершу треба перенести на сервер або створити новий.

Інші спостереження:

- **Desktop:** після входу на self-hosted сервер меню робочих просторів
  показує сервер, але не показує список його просторів. Сам простір при цьому
  синхронізується і відкривається за прямим посиланням. Потрібно перевірити
  на реальному ПК.
- **Desktop без мережі** постійно звертається до `app.affine.pro`
  (вбудований сервер AFFiNE Cloud). На роботу це не впливає, це лише помилки
  в логах.
- **Сервер** без мережі намагається отримати список релізів з `affine.pro`:
  помилка в логах, на роботу не впливає.
- **Видалення всіх ключів** («Clear all BYOK keys») вимагає ввести текст
  підтвердження.
- **Покриття функцій:** за даними екрана BYOK, транскрипція та індексація
  робочого простору (embeddings) працюють лише з серверним ключем
  Gemini. Чи працюють embeddings через OpenAI-сумісний endpoint (наприклад
  `nomic-embed-text` в Ollama), ще не перевірено.

## 6. MCP-сервер робочого простору (перевірено на 0.27.4)

AFFiNE має вбудований MCP-сервер, щоб зовнішні AI-клієнти (Claude Desktop,
Claude Code, Cursor тощо) могли читати й шукати документи робочого простору.

- **Реалізація:** `packages/backend/server/src/plugins/copilot/mcp/*`.
  Працює лише на сервері, тож тільки для серверних (cloud/self-hosted)
  робочих просторів. Для локальних просторів desktop MCP-сервера немає.
- **Endpoint:** `POST /api/workspaces/<workspaceId>/mcp`. Це stateless
  Streamable HTTP, JSON-RPC 2.0, до 20 повідомлень у пакеті. Протоколи
  `2024-10-07` … `2025-11-25`. Методи: `initialize`, `ping`, `tools/list`,
  `tools/call`.
- **Доступ:** `Authorization: Bearer aff_mcp_v1.<id>.<secret>`. Токен
  створюється в Workspace → Settings → Integrations → MCP Server → Create
  credential і прив'язаний до одного простору. Можна вибрати строк дії
  (30/90/365 днів), токен можна ротувати й відкликати. Діють права
  користувача, який його створив. UI одразу дає готовий JSON для
  `mcpServers`.
- **Вимоги:** має бути ввімкнено AI (`copilot.enabled`), інакше endpoint
  вимкнено.

### Інструменти

| Інструмент             | Аргументи                            | Що робить                                                                                     |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `read_document`        | `docId`                              | Markdown документа (з перевіркою прав `Doc.Read`)                                             |
| `doc_search`           | `query`, `doc_ids?`, `limit?` (1–20) | Пошук фрагментів: ключовий (індексатор) + семантичний (embeddings), з `block_id` для переходу |
| `create_document`      | `title`, `content` (markdown)        | Лише в режимі READ_WRITE                                                                      |
| `update_document`      | `docId`, `content`                   | Оновлює тіло мінімальним диффом, лише READ_WRITE                                              |
| `update_document_meta` | `docId`, `title`                     | Лише READ_WRITE                                                                               |

Інструменти запису доступні лише в dev/canary (`AFFINE_ENV=dev`). На
стабільному self-host можна створити тільки токен «Read only».

### Що знадобилося, щоб пошук запрацював

1. **Без індексатора `doc_search` завжди повертає `SEARCH_UNAVAILABLE`.**
   Офіційний compose 0.27.4 вимикає індексатор
   (`AFFINE_INDEXER_ENABLED=false`).
2. **Вбудованого (`embedded`) індексатора в 0.27.4 ще немає** (з'явився в
   0.27.5). Потрібен Manticore Search (`manticoresearch:9308`) або
   Elasticsearch: окремий контейнер на ~0,9 ГБ.
3. **Налаштування індексатора з `config.json` не застосовуються** (той самий
   баг, що й для AI). Записати через адмін-панель або мутацію
   `updateAppConfig` і перезапустити сервер.
4. **Таблиця `block` у Manticore не створилася з першого разу** (ймовірно,
   Manticore ще стартував). Її довелося створити вручну тим самим DDL, що й
   у сервері. Після цього редагування документа запускає індексацію.
5. **Семантичний пошук** (`retrieval_mode` з векторами) вимагає embeddings.
   Без них відповідь має `degraded_reason: VECTOR_UNAVAILABLE`, і працює
   лише ключовий пошук.

Перевірено: `curl` (JSON-RPC) і офіційний `@modelcontextprotocol/sdk` 1.32.2
(Streamable HTTP): `initialize`, `tools/list`, `doc_search`, `read_document`;
без токена та після відкликання повертається 401.

## 7. Наступні кроки

1. Вирішити питання ліцензії серверної частини (розділ 2).
2. Додати build-флаг «тільки self-host» і прибрати `affine-cloud` з desktop (розділ 3).
3. Додати в адмін-панелі розділ «AI-провайдери» поверх `copilot.providers.profiles`
   з пресетами OpenAI-сумісних сервісів і перевіркою з'єднання (розділ 4).
