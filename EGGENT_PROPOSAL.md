# Eggent: Предложение по размещению и мультиюзер-системе

## 1. Что такое Eggent

Eggent — это self-hosted AI-воркспейс с локальным хранением данных. Приложение объединяет возможности ChatGPT-подобного интерфейса с продвинутыми инструментами: проектной организацией, семантической памятью, выполнением кода, автоматизацией задач и интеграциями.

### Ключевые возможности

| Возможность | Описание |
|-------------|----------|
| **Чат с AI** | Разговорный интерфейс с поддержкой стриминга, Markdown-рендеринг, история сообщений |
| **Проекты** | Изолированные рабочие пространства со своими инструкциями, навыками, памятью и базой знаний |
| **RAG / Knowledge** | Загрузка документов (PDF, DOCX, XLSX, TXT, MD, изображения через OCR) → разбивка на чанки → эмбеддинги → семантический поиск |
| **Семантическая память** | Векторная база (cosine similarity) с областями: main, fragments, solutions, instruments |
| **Выполнение кода** | Python 3, Node.js, терминал — с таймаутом 180 сек и лимитом вывода |
| **MCP-серверы** | Подключение внешних инструментов через Model Context Protocol (STDIO и HTTP) |
| **Cron-автоматизация** | Планирование задач: расписание cron, интервалы, абсолютное время. Глобально и per-project |
| **Telegram-бот** | Общение с AI через Telegram, отправка файлов, access-коды для авторизации |
| **Agent Skills** | 35+ встроенных навыков (GitHub, Discord, iMessage, Excalidraw и др.) |
| **Внешнее API** | Приём сообщений от внешних систем через токен-аутентификацию |

### Технический стек

- **Framework:** Next.js 15.5.4, React 19.1.2, TypeScript
- **AI SDK:** Vercel AI SDK 6.0 — единый интерфейс для OpenAI, Anthropic, Google, OpenRouter, Ollama
- **MCP:** @modelcontextprotocol/sdk 1.26.0
- **Документы:** pdfjs-dist (PDF), mammoth (DOCX), xlsx (Excel), tesseract.js (OCR)
- **UI:** TailwindCSS 4, Radix UI (Shadcn), Lucide Icons
- **State:** Zustand 5 (клиент), file-based JSON (сервер)
- **Docker:** Node 22 (bookworm-slim), multi-stage build, Python 3 venv
- **Хранение:** Файловая система (`./data/`) — чаты, проекты, память, настройки

---

## 2. Текущая архитектура

### Хранение данных

Все данные хранятся в JSON-файлах на диске:

```
data/
├── chats/              # Чаты: {chatId}.json
├── projects/           # Проекты: {projectId}/.meta/ (skills, knowledge, MCP)
├── memory/             # Векторные эмбеддинги: {projectId}/vectors.json
├── settings/           # Глобальные настройки, Telegram, API-токены
├── external-sessions/  # Сессии API-клиентов и Telegram
└── cron/               # Cron-задачи и логи
```

### Аутентификация (текущая)

**Однопользовательская система:**
- Один логин/пароль (`admin/admin` по умолчанию)
- Пароль хешируется bcrypt (`src/lib/auth/password.ts`)
- Сессия: HMAC-SHA256 токен в HTTP-only cookie (`eggent_auth`), TTL 7 дней
- При первом входе — принудительная смена пароля (`mustChangeCredentials`)
- Нет ролей, нет разделения данных между пользователями

### Telegram-интеграция (текущая)

- Webhook на `/api/integrations/telegram`
- Access-коды формата `EG-XXXXXX` с TTL
- Allowlist пользователей по Telegram ID
- Per-user сессии (activeProject, activeChat)
- Поддержка файлов: документы, изображения, аудио, видео (до 30 МБ)

### Хорошая основа для расширения

В текущем коде уже реализованы механизмы, которые можно переиспользовать:
- `password.ts` — хеширование/верификация паролей
- `session.ts` — генерация/проверка токенов с кастомным payload
- `mustChangeCredentials` — флоу принудительной смены пароля
- `telegram-integration-store.ts` — access-коды, сессии, allowlist
- `external-session-store.ts` — per-client state management

---

## 3. Идея: Размещение на Railway

### Зачем

Хочу сделать Eggent доступным через интернет для 2-5 доверенных пользователей (семья, друзья) — с одним набором API-ключей.

### Почему Railway, а не Vercel

| Критерий | Vercel | Railway |
|----------|--------|---------|
| Архитектура | Serverless (Lambda) | Docker-контейнер |
| Долгие процессы | Макс. 60-300 сек | Без ограничений |
| Выполнение кода | Нет (read-only filesystem) | Python, Node.js, терминал |
| MCP-серверы (STDIO) | Невозможно | Полная поддержка |
| Cron с агентом | Ограничено | Полная поддержка |
| Persistent Volume | Нет | До 100 ГБ ($0.25/ГБ/мес) |
| HTTPS | Автоматический | Автоматический |
| Стоимость | $0 (Hobby) — $20/мес (Pro) | ~$5-20/мес |

**Вывод:** Vercel не подходит для Eggent, потому что приложение требует долгие процессы (code execution, cron, MCP) и персистентное файловое хранилище.

### Что нужно для деплоя

1. **Railway проект** с подключенным Git-репозиторием
2. **Persistent Volume** → `/app/data` (5-10 ГБ достаточно для 2-5 пользователей)
3. **Environment variables:**
   - `OPENROUTER_API_KEY` — ключ для AI-моделей
   - `OPENAI_API_KEY` — ключ для эмбеддингов (text-embedding-3-large)
   - `EGGENT_AUTH_SECRET` — секрет для подписи сессий
   - `APP_BIND_HOST=0.0.0.0` — слушать на всех интерфейсах
4. **Dockerfile** уже готов — multi-stage build, Node 22, всё необходимое

### Безопасность Dockerfile

Единственное изменение: убрать строку с passwordless sudo для пользователя `node`:

```dockerfile
# УБРАТЬ эту строку:
RUN echo "node ALL=(root) NOPASSWD: ALL" > /etc/sudoers.d/eggent-node
```

Для локальной разработки это удобно (AI может устанавливать пакеты через sudo), но для публичного деплоя — потенциальная уязвимость.

### Стоимость Railway

| Компонент | $/мес |
|-----------|-------|
| Контейнер (1 vCPU, 1 ГБ RAM) | $5-15 |
| Persistent Volume (5-10 ГБ) | $1.25-2.50 |
| **Итого Railway** | **~$6-17** |

---

## 4. Идея: Мультиюзер-система

### Зачем

Сейчас Eggent — однопользовательский. Если несколько человек используют один экземпляр, все видят все чаты и проекты, нет разделения прав. Нужна система, где:

- Каждый пользователь видит **только свои** чаты и проекты
- Admin управляет пользователями и видит статистику
- Permissions контролируют доступ к возможностям (code execution, image gen и т.д.)
- Telegram-бот изолирует данные per-user

### Модель данных пользователей

Новый файл: `data/settings/users.json`

```json
{
  "users": [
    {
      "id": "usr_abc123",
      "username": "kirill",
      "displayName": "Kirill",
      "passwordHash": "scrypt$...",
      "role": "admin",
      "mustChangePassword": false,
      "permissions": {
        "chat": true,
        "projects": true,
        "knowledge": true,
        "codeExecution": true,
        "webSearch": true,
        "fileUpload": true,
        "imageGeneration": true,
        "telegram": true
      },
      "quotas": {
        "dailyMessageLimit": 0,
        "monthlyTokenLimit": 0
      },
      "telegramUserId": null,
      "createdAt": "2026-02-27T...",
      "lastLoginAt": null
    }
  ]
}
```

**Роли:**
- `admin` — полный доступ + управление пользователями + API Keys + статистика
- `user` — доступ только к разрешённым возможностям, свои чаты/проекты

**Permissions** (admin назначает при создании пользователя):
- `chat` — общение с AI
- `projects` — создание проектов
- `knowledge` — загрузка документов в RAG
- `codeExecution` — выполнение кода (Python/Node/терминал)
- `webSearch` — поиск в интернете
- `fileUpload` — загрузка файлов
- `imageGeneration` — генерация изображений
- `telegram` — доступ через Telegram-бота

**Quotas** (0 = без лимита):
- `dailyMessageLimit` — максимум сообщений в день
- `monthlyTokenLimit` — максимум токенов в месяц

### Создание пользователей

```
Admin → Settings → Users → "Add User"
  → username, displayName, временный пароль, role, permissions
  → Сохраняется с mustChangePassword: true
  → Admin передаёт логин/пароль (устно, мессенджер)
  → Пользователь входит → форма «Установите постоянный пароль»
  → После смены → mustChangePassword: false → полный доступ
```

Механизм `mustChangeCredentials` уже реализован в `session.ts` и `middleware.ts` — нужно только привязать его к `mustChangePassword` в users-store.

### Изоляция данных

**Сессии:** в JWT-токен добавляются `uid` (userId) и `r` (role). Middleware прокидывает их в headers для всех API-routes.

**Чаты:** поле `userId` в каждом чате. User видит только свои, admin — все.

**Проекты:** поле `ownerId` в метаданных. User видит свои + общие (без ownerId). Admin видит все.

**Память/RAG:** уже привязана к проектам → если проекты изолированы, память изолирована автоматически.

### Видимость настроек по роли

| Раздел Settings | admin | user |
|----------------|-------|------|
| API Keys | Полный доступ | Скрыт |
| Models | Полный доступ | Только выбор модели в чате |
| Users | CRUD всех пользователей | Только свой профиль |
| Telegram | Настройка бота | Привязка своего аккаунта |
| Usage / Stats | Полный | Скрыт |

### Telegram: per-user изоляция

**Текущая система** — access-коды и allowlist — дополняется привязкой к Eggent-аккаунту:

```
Admin: Settings → Users → Marina → "Generate Telegram Code"
       → access-код привязан к userId Marina
Marina в TG: /start → /code EG-A1B2C3
       → система привязывает её Telegram ID к Eggent-аккаунту
       → "Привет, Marina!"
```

После привязки:
- Каждый видит **только свои** чаты через Telegram
- `/new` создаёт чат для своего аккаунта
- Файлы привязываются к пользователю
- Permissions и quotas применяются

### Статистика использования (Admin Dashboard)

Файл: `data/stats/usage.json` — ежедневная статистика по пользователям и моделям:

```json
{
  "daily": {
    "2026-02-27": {
      "usr_abc": {
        "messages": 42,
        "tokensIn": 15000,
        "tokensOut": 45000,
        "cost": 0.85,
        "byModel": {
          "claude-opus-4-6": { "messages": 5, "cost": 0.65 },
          "claude-sonnet-4-6": { "messages": 35, "cost": 0.15 }
        }
      }
    }
  }
}
```

Сбор: после каждого ответа AI → userId + модель + токены (из response) + стоимость по прайсу.

UI: вкладка "Usage" в Settings (admin) — таблица по пользователям, моделям, дням.

### API для мультиюзера

```
# Управление пользователями (admin)
GET    /api/auth/users              — список
POST   /api/auth/users              — создать
PUT    /api/auth/users/[id]         — обновить
DELETE /api/auth/users/[id]         — удалить
POST   /api/auth/users/[id]/telegram-code — TG-код

# Профиль (любой пользователь)
GET    /api/auth/profile            — свой профиль
PUT    /api/auth/profile            — обновить displayName / пароль

# Статистика (admin)
GET    /api/admin/stats?period=day|week|month&userId=...
```

---

## 5. Рекомендуемый стек моделей (OpenRouter)

Все модели подключаются через один OpenRouter API-ключ.

| Роль | Модель | Цена (in/out за 1M tokens) | Когда использовать |
|------|--------|---------------------------|-------------------|
| **Chat (основная)** | `anthropic/claude-opus-4-6` | $5 / $25 | Сложный анализ, агентные цепочки, длинный контекст |
| **Utility (быстрая)** | `anthropic/claude-sonnet-4-6` | $3 / $15 | 80% задач: быстрые ответы, код, повседневное |
| **Мультимедиа** | `google/gemini-3.1-pro` | $2 / $12 | Аудио (до 8.4ч), видео (до 1ч), генерация изображений |
| **Embeddings** | `openai/text-embedding-3-large` | ~$0.13 | RAG, knowledge base, семантическая память |

На уровне проекта можно задать другую модель — медиа-проект на Gemini, кодинг на Opus.

---

## 6. Итоговая оценка стоимости

| Компонент | $/мес |
|-----------|-------|
| Railway (контейнер + volume) | $6-17 |
| Opus 4.6 (сложные задачи) | ~$20-60 |
| Sonnet 4.6 (повседневные) | ~$5-15 |
| Gemini 3.1 Pro (медиа) | ~$5-20 |
| Embeddings (text-embedding-3-large) | ~$1-5 |
| **Итого** | **~$37-117** |

*При активном использовании 2-5 пользователями. Основные расходы — API моделей, Railway — минимум.*

---

## 7. Список файлов для изменения (21 файл)

| Файл | Действие | Описание |
|------|----------|----------|
| `Dockerfile` | Изменить | Убрать passwordless sudo |
| | | |
| **Хранилища** | | |
| `src/lib/storage/users-store.ts` | Создать | CRUD пользователей, roles, permissions |
| `src/lib/storage/usage-store.ts` | Создать | Статистика по пользователям/моделям |
| `src/lib/storage/chat-store.ts` | Изменить | Добавить userId в чатах |
| `src/lib/storage/project-store.ts` | Изменить | Добавить ownerId в проектах |
| `src/lib/storage/settings-store.ts` | Изменить | Убрать auth, ограничить по роли |
| `src/lib/storage/telegram-integration-store.ts` | Изменить | Access-коды с targetUserId |
| | | |
| **Авторизация** | | |
| `src/lib/auth/session.ts` | Изменить | Добавить uid + role в токен |
| `middleware.ts` | Изменить | userId/role → headers + проверка permissions |
| | | |
| **API** | | |
| `src/app/api/auth/login/route.ts` | Изменить | Логин по users-store |
| `src/app/api/auth/credentials/route.ts` | Изменить | Смена пароля через users-store |
| `src/app/api/auth/users/route.ts` | Создать | GET/POST пользователей (admin) |
| `src/app/api/auth/users/[id]/route.ts` | Создать | PUT/DELETE пользователя (admin) |
| `src/app/api/auth/users/[id]/telegram-code/route.ts` | Создать | TG-код для пользователя |
| `src/app/api/auth/profile/route.ts` | Создать | Профиль пользователя |
| `src/app/api/admin/stats/route.ts` | Создать | Статистика (admin) |
| `src/app/api/integrations/telegram/route.ts` | Изменить | TG userId → Eggent userId |
| | | |
| **UI** | | |
| `src/components/settings/users-*.tsx` | Создать | Управление пользователями (admin) |
| `src/components/settings/usage-*.tsx` | Создать | Статистика (admin) |
| `src/components/auth/change-password.tsx` | Создать | Форма смены временного пароля |

---

## Резюме

Eggent — мощный AI-воркспейс с отличной архитектурой. Для превращения его в мультиюзерный сервис, доступный через интернет, нужно:

1. **Railway** для деплоя (Docker + persistent volume + HTTPS)
2. **Users-store** с ролями (admin/user), permissions и quotas
3. **Изоляция данных** — чаты и проекты привязаны к userId
4. **Telegram per-user** — через расширение существующих access-кодов
5. **Admin dashboard** — статистика использования по пользователям и моделям

Все изменения совместимы с текущей архитектурой и не требуют миграции на базу данных — file-based хранение достаточно для 2-5 пользователей.
