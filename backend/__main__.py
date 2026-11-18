import argparse
import os

import uvicorn

from .main import create_app

parser = argparse.ArgumentParser(description='Вместе — свадебный планировщик')
parser.add_argument('--demo', action='store_true', help='Локальный режим с тестовым входом')
parser.add_argument('--empty', action='store_true', help='Создать новый локальный план без примера')
parser.add_argument('--db', help='Путь к SQLite')
parser.add_argument('--events', action='store_true', help='Личные кабинеты и отдельные мероприятия')
parser.add_argument('--api-only', action='store_true', help='Запустить API, если бот уже работает отдельно')
parser.add_argument('--host', default='127.0.0.1')
parser.add_argument('--port', type=int, default=8000)
args = parser.parse_args()
if args.demo and args.host not in ('127.0.0.1', '::1'):
    parser.error('--demo разрешён только на локальном адресе')
if not args.demo:
    required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_MINI_APP_URL']
    if not args.events:
        required.append('TELEGRAM_OWNER_ID')
    if missing := [key for key in required if not os.environ.get(key)]:
        parser.error('Укажите конфигурацию Telegram: ' + ', '.join(missing))
    if (not args.events and not os.environ['TELEGRAM_OWNER_ID'].isdigit()) or not os.environ['TELEGRAM_MINI_APP_URL'].startswith('https://'):
        parser.error('Нужны числовой Telegram ID организатора и HTTPS-адрес Mini App')

uvicorn.run(create_app(demo=args.demo, sample=not args.empty, database=args.db, events=args.events, api_only=args.api_only),
            host=args.host, port=args.port,
            access_log=args.demo, proxy_headers=not args.demo)
