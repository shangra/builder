# Куда положить и как пользоваться

Нужен Node.js 18+ на машине, где запускаете коробку.

## 1. Куда класть

Положите этот проект **в корень аналитики** (`SREDA.Analytic`) — рядом с `workspace/`, где лежат модули. В `box.config.json` поле `"root": "workspace"`.

Пример:

```
SREDA.Analytic\
  package.json
  box.config.json
  .env.example
  bin\
  src\
  workspace\
    frontend-adm\
    sreda-pivot\
    sreda-analytics-migrations\
    sreda-analytics-spreadsheet-frontend\
    logs\
```

Как перенести: скопируйте из `builder-s` файлы `package.json`, `box.config.json`, `.env.example` и папки `bin`, `src` в корень `SREDA.Analytic`. Если в корне аналитики уже есть свой `src/fs.js` — не затирайте его; лаунчер использует `src/fs-utils.js`.

Если лаунчер оставляете отдельно (как сейчас в `PhpstormProjects\builder-s`), модули не копируйте — при запуске указывайте `--root` на папку `workspace`. Удобнее положить лаунчер внутрь `SREDA.Analytic`.

## 2. Проверить состав

Откройте `box.config.json`. Поле `path` у каждого модуля — имя папки относительно `workspace`.

Сейчас:

| id | папка | что делает при старте |
| --- | --- | --- |
| migrations | `workspace/sreda-analytics-migrations` | один раз `npm start` |
| pivot | `workspace/sreda-pivot` | сервис, порт 3391 |
| spreadsheet | `workspace/sreda-analytics-spreadsheet-frontend` | `npm run start-win`, порт 3380 |
| admin | `workspace/frontend-adm` | `npm run startw`, порт 3372 |

- добавить модуль — новый объект в `modules`
- убрать из поставки — `"enabled": false` или удалить блок
- папка называется иначе — поправьте `path`

Проверка, что папки видны:

```bash
node bin/sreda-builder.js list
```

Если лаунчер не в корне модулей:

```bash
node bin/sreda-builder.js list --root C:\Users\23882308\Desktop\project
```

В списке должно быть `deps ok`. Если `нет каталога` — неверный `--root` или `path`. Если `нет node_modules` — сначала шаг 3.

## 3. Зависимости (один раз)

Если модули уже выкачаны **и** в каждом есть `node_modules` — этот шаг пропустите.

Иначе из корня коробки одна команда:

```bash
npm install
```

Она ставит зависимости во всех модулях:

- migrations и pivot — `npm install`
- spreadsheet и admin — `npm i --legacy-peer-deps`

## 3a. Конфиги модулей (.env)

Скопируйте `.env.example` в `.env` в корне коробки и заполните базу и порты. Затем:

```bash
npm run env
```

Команда запишет `.env` в модули:

- pivot — полный шаблон
- spreadsheet (аналитика) — база из общего `.env`, `ESB_HOST` на пивот
- migrations — как пивот, CORS только на ESB
- admin — порт 3372, бэкенд пивота, без MDM

`LICENSE_KEY` в пивоте пока всегда пустой.

## 3b. Миграции базы

После `npm install` и генерации `.env`:

```bash
npm run db
```

В `workspace/sreda-analytics-migrations` выполняется `npm run db`. После успеха в консоли появится запрос `введите лицензионный ключ` — введённое значение запишется в `workspace/sreda-pivot/.env` как `LICENSE_KEY`.

## 4. Запуск всей коробки

Из корня:

```bash
npm start
```

Поднимаются:

- pivot — `npm start`
- аналитика — `npm run start-win`
- админка — `npm run startw`

Миграции при старте не гоняются (их уже сделал `npm run db`). Остановка — `Ctrl+C`. Логи — `logs\`.

После старта открывается оболочка лаунчера: http://127.0.0.1:9090

В `box.config.json`:

```json
"ui": {
  "mode": "launcher",
  "apps": [
    { "id": "analytics", "title": "Аналитика", "module": "spreadsheet" },
    { "id": "admin", "title": "Админка", "module": "admin" }
  ]
}
```

- `"mode": "launcher"` — приложения внутри оболочки (переключение без новой вкладки)
- `"mode": "browser"` — аналитика и админка открываются в браузере
- разово: `node bin/sreda-builder.js start --ui browser`
- только оболочка, без модулей: `node bin/sreda-builder.js ui`

Оболочка написана на React (`launcher-ui/`). После правок UI: `npm run ui:build`. В коробку отдаётся уже собранный `launcher-ui/dist`.

Только часть модулей:

```bash
node bin/sreda-builder.js start --only pivot,spreadsheet
```

## 5. Что отдать заказчику

Один каталог: лаунчер + `box.config.json` + папки модулей (уже с `node_modules`, если коробка собрана). Инструкция заказчику: из корня выполните `npm start`.
