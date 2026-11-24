# lv24-diagram

MCP-сервер «архитектура как код»: рендер и линт Mermaid, ER-схемы **по живой** базе PostgreSQL,
скан архитектуры репозитория, общий редактор draw.io и синхронизация с
[lv24-brain](https://github.com/LevapVeeskela/lv24-brain).

Один сервер вместо трёх (mermaid + dbhub + drawio) плюс то, чего им не хватало: проверка
читаемости, извлечение схемы из БД, разбор compose/nginx и идемпотентная запись в brain.

## Установка

```bash
node -v                 # >= 22.5
npm i -g lv24-diagram
lv24-diagram version
```

Для PNG-рендера нужен Chromium. Если его нет:

```bash
npm i -g lv24-diagram --allow-scripts=lv24-diagram
```

## Настройка

```bash
cd <репозиторий> && lv24-diagram init     # создаст diagram.config.json
```

```jsonc
{
  "docs": { "dir": "docs/architecture" },
  "database": {
    "kind": "postgres",
    "host": "127.0.0.1",
    "port": 5432,
    "database": "app",
    "user": "readonly_user",
    "password": "${APP_DB_PASSWORD}",   // подстановка из окружения
    "passwordFile": "C:/Users/me/.config/lv24-diagram/db-password", // опционально, важнее password
    "schemas": ["public"]
  },
  "drawio": { "url": "http://127.0.0.1:3214/mcp", "editorUrl": "http://127.0.0.1:3214/" },
  "brain": { "enabled": true }
}
```

Порядок поиска конфига: `--config`, `$DIAGRAM_CONFIG`, `./diagram.config.json`,
`~/.config/lv24-diagram/config.json`. Отсутствующая переменная окружения — ошибка, а не тихий
пропуск.

Секреты: `password` принимает `${ENV_VAR}`, но уже запущенному MCP-хосту новую переменную
окружения не подсунуть. Тогда используйте `passwordFile` — путь к файлу, доступному только вам.
Относительный путь считается от каталога конфига; файл читается и обрезается при загрузке и
важнее `password`. Нет файла или он пустой — явная ошибка с путём, без содержимого. Файл держите
вне репозиториев, ACL — только текущий пользователь.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `diagram_render` | Mermaid → SVG + PNG (картинка возвращается блоком `image`) |
| `diagram_lint` | Бюджет читаемости: узлы, глубина, циклы, подписи рёбер и длина подписей |
| `diagram_save` | `NN-slug.{mmd,svg,png}` + строка в `README.md` + запись в brain |
| `schema_tables` | Таблицы/вьюхи с оценкой строк |
| `schema_columns` | Колонки, типы, nullability, PK/UK |
| `schema_query` | Один read-only `SELECT`/`WITH` с лимитом строк |
| `schema_er` | Mermaid `erDiagram` по живой схеме, опционально рендер и сохранение |
| `arch_scan` | Compose + nginx + пакеты → сервисы, связи, «неизвестное» |
| `arch_diagram` | Представление `container` / `context` / `deploy` |
| `drawio_status` | Состояние общего draw.io и подключённые документы |
| `drawio_import_mermaid` | Mermaid → нативные ячейки draw.io |
| `drawio_export` | Страница → PNG / SVG / XML по абсолютному пути |
| `brain_context` | Цель, следующий шаг и активные пункты проекта из brain |
| `brain_publish` | Идемпотентная заметка-дайджест по сохранённому набору схем |

CLI: `mcp`, `serve`, `doctor`, `render`, `scan`, `brain`, `drawio`, `init`, `version`.

## HTTP-режим (diagram-api)

`lv24-diagram serve` запускает опциональный HTTP-сервис: рендерит Mermaid в PNG и отдаёт картинку
по публичному UUID-URL (используется столом диаграмм city AI). Команда `mcp` на stdio не меняется.

```bash
export DIAGRAM_API_TOKEN="..."      # обязателен, пустой не принимается
lv24-diagram serve \
  --http-port 3793 \
  --host 127.0.0.1 \
  --redis-url redis://127.0.0.1:6379 \
  --token-env DIAGRAM_API_TOKEN
```

| Маршрут | Авторизация | Что делает |
|---|---|---|
| `GET /health` | нет | `{status, chromium, storage, queue}` |
| `POST /v1/render` | `x-lv24-diagram-token` | Mermaid → PNG, хранение на час |
| `GET /v1/diagrams/{uuid}.png` | нет | `image/png`, `Cache-Control: public, max-age=3600, immutable` |
| `GET /docs-json` | нет | OpenAPI 3 JSON |
| `GET /docs` | нет | Swagger UI |

```bash
curl -s -X POST http://127.0.0.1:3793/v1/render \
  -H "x-lv24-diagram-token: $DIAGRAM_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mermaid":"flowchart LR\n  A[User] --> B[API]","theme":"default","title":"Request flow"}'
# {"id":"…","width":522,"height":84,"bytes":5725,"mermaid":"…"}
```

Тело запроса: `mermaid` 10–4000 символов, `theme` `default|base|dark|forest|neutral`,
опциональный `title` 1–80. Лимиты: **40 узлов** (жёсткий бюджет линтера), Mermaid
`securityLevel: strict`; директивы `click` и блоки `%%{init}%%` отклоняются с 400
`DIAGRAM_INVALID` и `findings[]`. Одновременно выполняется **1** рендер, очередь — **4**,
таймаут — **10 с**, длинная сторона PNG — не более **2400 px** (уменьшается после рендера).
Переполненная очередь — 429 `DIAGRAM_BUSY`; ошибка рендера, таймаут или отсутствие Chromium —
503 `DIAGRAM_UNAVAILABLE`.

PNG лежат в Redis по ключу `diagram:v1:png:<uuid>` с TTL **3600 с**. Память как fallback
намеренно не используется: если Redis недоступен, `POST /v1/render` и `GET …png` отвечают
503 `STORAGE_UNAVAILABLE`, а `/health` показывает `storage: "down"`. Токен берётся из переменной
окружения, имя которой задаёт `--token-env`; пустое или отсутствующее значение останавливает
процесс до открытия порта.

По умолчанию сервис слушает `127.0.0.1`. В контейнере биндите интерфейс контейнера и публикуйте
порт только во внутренней Docker-сети — никогда на публичном интерфейсе хоста. Логи идут в stderr
и не содержат ни токена, ни текста диаграмм.

## draw.io

Один общий HTTP-сервер на машину: порт **3214**, WebSocket **3337**. Два экземпляра конфликтуют
за порт расширения.

```bash
lv24-diagram drawio start     # 127.0.0.1:3214, редактор там же
```

Откройте `http://127.0.0.1:3214/` один раз — страница подключит документ. Без открытого редактора
инструменты отвечают `No connected Draw.io documents` — это норма, а не поломка. Вкладку лучше
держать видимой: Chrome отправляет фоновые вкладки в bfcache и рвёт WebSocket.

## Синхронизация с brain

- `brain_context` вызывает `brain open . --json` и отдаёт `goal`, `next_action`, `active`.
- `diagram_save`, `schema_er`, `arch_diagram` публикуют дайджест, если не передан
  `publish_to_brain: false`.
- Повторная публикация с тем же хешем содержимого пропускается; id заметки и хеш лежат в
  `docs/architecture/.diagrams.json`.
- В заметку попадают только имена, количества и пути. `redactSecrets` вырезает `user:pass@`,
  `password=`, `token=` до записи.
- Если brain недоступен, схема всё равно сохраняется — синхронизация не блокирует работу.

## Безопасность

- Всё локально: stdio, draw.io только на `127.0.0.1`.
- База — read-only: сессия переводится в read-only, пользователь должен быть `SELECT`-only.
  SQL-гард — **ограничитель, а не граница прав**.
- Секретов нет в конфигах, заметках и схемах: только `${ENV}` или `passwordFile` вне репозитория
  с ограниченным ACL. Ошибки показывают путь, но никогда — содержимое.
- `arch_scan` не читает содержимое `.env*` и пропускает скрытые каталоги.

## Разработка

```bash
npm install
npm run build
npm test          # node:test, 49 тестов
node dist/src/cli.js doctor
```

Правила репозитория — [AGENTS.md](AGENTS.md), решения — [docs/design.md](docs/design.md).

## Лицензия

Apache-2.0.
