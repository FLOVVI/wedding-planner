# Вместе

Свадебный планировщик для Telegram Mini App. Обзор собирает готовность гостей и рассадки, смету и ближайшие сроки. В общем плане можно составить программу дня, вести подрядчиков и собрать музыкальные моменты.

## Локальный запуск

Нужны Python 3.11+ и Node.js 20.19+ или 22.12+. Из папки проекта в PowerShell:

```powershell
python -m pip install -r requirements.txt
npm.cmd ci
npm.cmd run build
python -m backend --demo
```

Откройте [127.0.0.1:8000](http://127.0.0.1:8000/). При первом запуске появится свадебный пример. Изменения хранятся в `data/demo.sqlite3` и сохраняются после перезапуска.

Для отдельного пустого плана укажите новый файл базы при запуске:

```powershell
python -m backend --demo --empty --db data/my-wedding.sqlite3
```

- В разделе «Доступ» создайте ссылку для команды или приглашение для второго участника. Кнопка рядом со ссылкой откроет соответствующую роль в отдельной вкладке.
- В разделе «Рассадка» загрузите PNG или JPEG до 6 МБ либо начните с сетки. Нажмите на гостя, затем на стол. Объекты двигаются мышью, пальцем или стрелками клавиатуры.
- В разделе «Задачи» включите напоминания и запустите тестовые часы. Момент проверки можно поменять вручную. Журнал остаётся в локальной базе.

## Проверки

```powershell
python -m unittest discover -s tests -v
npm.cmd run build
```

## Подключение Telegram

### Запуск бота на ПК

Бот использует `pyTelegramBotAPI` и polling. Создайте отдельного бота через `/newbot` в BotFather. Сохраните его токен локально в строке `WEDDING_BOT_TOKEN=…` и запустите:

```powershell
python -m pip install -r requirements.txt
python -m backend.bot --keys "C:\путь\к\keys.txt"
```

`/start` открывает сайт GitHub Pages прямо из Telegram. Пробрасывать порт на компьютере для бота не требуется. Команда `/id` покажет ваш Telegram ID для настройки `WEDDING_OWNER_ID`. По умолчанию используется `data/wedding.sqlite3`.

### Запуск Mini App с общим планом

Когда появится HTTPS-адрес, настройте Main Mini App в BotFather и передайте серверу `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_OWNER_ID` и `TELEGRAM_MINI_APP_URL` через переменные окружения. Соберите интерфейс и запустите `python -m backend` одним процессом за HTTPS-прокси. Этот режим использует отдельную базу `data/wedding.sqlite3` и получает обновления бота через long polling.

Запускайте только один polling-процесс для одного токена. Команда `python -m backend` на сервере запускает и API, и бота.

Партнёр открывает одноразовое приглашение из приложения. Для напоминаний каждый участник открывает личный чат с ботом, отправляет `/start` и включает уведомления в приложении либо командой `/reminders`. Команда `/stop` отключает уведомления.

## Публичный сайт на GitHub Pages

Команда `npm.cmd run build -- --mode pages` собирает открытый сайт проекта. Разместите `dist` в ветке `gh-pages`. Переменная `VITE_BOT_USERNAME` добавляет на сайт кнопку перехода к вашему боту.

На сервере соберите приложение обычной командой `npm.cmd run build`, затем запустите `python -m backend` с конфигурацией Telegram. Укажите HTTPS-адрес сервера в `TELEGRAM_MINI_APP_URL` и в настройках Main Mini App в BotFather.

Если веб-интерфейс самого планировщика нужно разместить на Pages, соберите его с публичным origin API и укажите адрес `github.io` в BotFather и `TELEGRAM_MINI_APP_URL`:

```powershell
$env:VITE_API_ORIGIN = 'https://api.example.com'
npm.cmd run build -- --mode pages
Remove-Item Env:VITE_API_ORIGIN
```

Для публикации из ветки положите рядом с `index.html` пустой файл `.nojekyll`. Для SQLite серверу требуется постоянное хранилище. Переменные Telegram задаются на сервере.

