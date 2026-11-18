import argparse
import asyncio
import logging
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from .notifications import TelegramBot
from .store import Store

ROOT = Path(__file__).resolve().parents[1]
PAGES_URL = 'https://flovvi.github.io/wedding-planner/'


def local_settings(path):
    if not path:
        return {}
    content = path.read_text(encoding='utf-8-sig')
    return {key: value.strip().strip('"\'') for key, value in re.findall(
        r'^\s*(WEDDING_BOT_TOKEN|WEDDING_OWNER_ID)\s*=\s*([^\r\n]+)', content, flags=re.M,
    )}


def main():
    parser = argparse.ArgumentParser(description='Запуск Telegram-бота «Вместе» через polling')
    parser.add_argument('--keys', type=Path, help='Файл с WEDDING_BOT_TOKEN и WEDDING_OWNER_ID')
    parser.add_argument('--url', default=PAGES_URL, help='HTTPS-адрес сайта, который открывается из бота')
    parser.add_argument('--db', type=Path, default=ROOT / 'data' / 'wedding.sqlite3')
    args = parser.parse_args()
    try:
        settings = local_settings(args.keys)
    except (OSError, UnicodeError):
        parser.error('Не удалось прочитать файл с настройками')
    token = settings.get('WEDDING_BOT_TOKEN') or os.environ.get('WEDDING_BOT_TOKEN', '').strip()
    owner_id = settings.get('WEDDING_OWNER_ID') or os.environ.get('WEDDING_OWNER_ID', '').strip()
    if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]{30,}', token):
        parser.error('Укажите WEDDING_BOT_TOKEN от отдельного свадебного бота')
    if owner_id and not re.fullmatch(r'[1-9][0-9]*', owner_id):
        parser.error('WEDDING_OWNER_ID должен быть числовым Telegram ID')
    url = urlsplit(args.url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password:
        parser.error('Для сайта требуется HTTPS-адрес')
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    logging.info('Бот запущен. Остановить его можно через Ctrl+C.')
    if not owner_id:
        logging.info('Команда /id в личном чате покажет значение для WEDDING_OWNER_ID.')
    store = Store(args.db, demo=False, sample=False, owner_id=owner_id)
    try:
        asyncio.run(TelegramBot(store, token, args.url).run())
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
