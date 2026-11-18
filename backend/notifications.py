import asyncio
import logging
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from aiohttp import ClientError
from telebot import types
from telebot.async_telebot import AsyncTeleBot
from telebot.asyncio_helper import ApiException

from .planner import lookup
from .store import Store

logger = logging.getLogger(__name__)


def delivery_window(due: date, now: datetime):
    zone = now.tzinfo
    start = datetime.combine(due - timedelta(days=1), time(10), zone)
    end = datetime.combine(due + timedelta(days=1), time.min, zone)
    return start <= now < end


def collect(store: Store, at: datetime | None, simulate: bool):
    with store.connect(write=True) as connection:
        _, plan = store.read(connection)
        zone = ZoneInfo(plan['settings']['timezone'])
        now = datetime.now(zone) if at is None else at.astimezone(zone)
        subscribers = connection.execute('''
            SELECT s.user_id FROM subscriptions s
            JOIN members m ON m.user_id = s.user_id WHERE s.enabled = 1 AND s.chat_id IS NOT NULL
        ''').fetchall()
        created = []
        candidates = [
            ('task', task, f"Задача «{task['name']}»") for task in plan['tasks'] if not task['done']
        ] + [
            ('payment', payment, f"Платёж «{payment['name']}» — {payment['amount']:,} ₽".replace(',', '\u202f'))
            for payment in plan['payments'] if payment['due'] and not payment['paid'] and payment['amount'] > 0
        ]
        for kind, item, label in candidates:
            due = date.fromisoformat(item['due'])
            if not delivery_window(due, now):
                continue
            when = 'сегодня' if now.date() == due else 'завтра'
            message = f'{label}. Срок {when}, {due:%d.%m.%Y}.'
            for subscriber in subscribers:
                result = connection.execute('''
                    INSERT OR IGNORE INTO reminders (user_id, source, due, message, created, status)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (subscriber['user_id'], f"{kind}:{item['id']}", item['due'], message, now.isoformat(),
                      'simulated' if simulate else 'pending'))
                if result.rowcount:
                    created.append(result.lastrowid)
        return created


def claim_delivery(store: Store, at: datetime | None = None):
    with store.connect(write=True) as connection:
        _, plan = store.read(connection)
        zone = ZoneInfo(plan['settings']['timezone'])
        now = datetime.now(zone) if at is None else at.astimezone(zone)
        jobs = connection.execute('''
            SELECT r.*, s.chat_id FROM reminders r
            LEFT JOIN members m ON m.user_id = r.user_id
            LEFT JOIN subscriptions s ON s.user_id = m.user_id AND s.enabled = 1
            WHERE r.status = 'pending' ORDER BY r.id
        ''').fetchall()
        for job in jobs:
            kind, item_id = job['source'].split(':', 1)
            task = kind == 'task'
            item = lookup(plan['tasks' if task else 'payments'], item_id)
            active = (item and item['due'] == job['due'] and not item['done' if task else 'paid']
                      and (task or item['amount'] > 0))
            if not (job['chat_id'] and active and delivery_window(date.fromisoformat(job['due']), now)):
                connection.execute("UPDATE reminders SET status = 'cancelled' WHERE id = ?", (job['id'],))
                continue
            connection.execute("UPDATE reminders SET status = 'sending' WHERE id = ?", (job['id'],))
            return job['id'], job['chat_id'], job['message']
        return None


def subscribe(connection, user_id, chat_id, enabled):
    connection.execute('''
        INSERT INTO subscriptions VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, enabled = excluded.enabled
    ''', (user_id, chat_id, int(enabled)))


class TelegramBot:
    def __init__(self, store: Store, token: str, mini_app_url: str):
        self.store = store
        self.client = AsyncTeleBot(token)
        self.mini_app_url = mini_app_url

    async def send(self, **reply):
        try:
            await self.client.send_message(**reply)
            return True
        except (ApiException, ClientError, TimeoutError):
            logger.warning('Telegram did not confirm message delivery')
            return False

    async def run(self):
        try:
            async with asyncio.TaskGroup() as tasks:
                tasks.create_task(self.poll())
                tasks.create_task(self.reminder_loop())
        finally:
            await self.client.close_session()

    async def reminder_loop(self):
        with self.store.connect(write=True) as connection:
            connection.execute("UPDATE reminders SET status = 'unknown' WHERE status = 'sending'")
        while True:
            collect(self.store, None, simulate=False)
            while delivery := claim_delivery(self.store):
                identifier, chat_id, message = delivery
                sent = await self.send(chat_id=chat_id, text=message)
                with self.store.connect(write=True) as connection:
                    connection.execute('UPDATE reminders SET status = ? WHERE id = ?',
                                       ('sent' if sent else 'unknown', identifier))
            await asyncio.sleep(30)

    async def poll(self):
        with self.store.connect() as connection:
            row = connection.execute("SELECT value FROM bot_state WHERE name = 'offset'").fetchone()
            offset = row['value'] if row else 0
        while True:
            try:
                updates = await self.client.get_updates(offset=offset, timeout=20, request_timeout=30,
                                                        allowed_updates=['message'])
            except (ApiException, ClientError, TimeoutError):
                logger.warning('Telegram polling did not succeed, retrying')
                await asyncio.sleep(5)
                continue
            for update in updates:
                with self.store.connect(write=True) as connection:
                    reply = self.handle_message(connection, update.message)
                    offset = update.update_id + 1
                    connection.execute("INSERT OR REPLACE INTO bot_state VALUES ('offset', ?)", (offset,))
                if reply:
                    await self.send(**reply)

    def handle_message(self, connection, message):
        if not message or message.chat.type != 'private' or not message.from_user:
            return None
        words = (message.text or '').split(maxsplit=1)
        command = words[0].split('@')[0] if words else ''
        if command not in ('/start', '/id', '/reminders', '/stop'):
            return None
        user_id = str(message.from_user.id)
        chat_id = message.chat.id
        if command == '/id':
            return {'chat_id': chat_id, 'text': f'Ваш Telegram ID: {user_id}'}
        member = connection.execute('SELECT 1 FROM members WHERE user_id = ?', (user_id,)).fetchone()
        if command == '/stop' and member:
            subscribe(connection, user_id, chat_id, False)
            return {'chat_id': chat_id, 'text': 'Напоминания отключены.'}
        if command == '/reminders' and member:
            subscribe(connection, user_id, chat_id, True)
            return {'chat_id': chat_id, 'text': 'Напоминания о задачах и платежах включены.'}
        if command == '/start' and member:
            connection.execute('INSERT OR IGNORE INTO subscriptions VALUES (?, ?, 0)', (user_id, chat_id))
        keyboard = types.InlineKeyboardMarkup()
        keyboard.add(types.InlineKeyboardButton('Открыть «Вместе»', web_app=types.WebAppInfo(self.mini_app_url)))
        return {
            'chat_id': chat_id,
            'text': 'Откройте «Вместе». Чтобы включить напоминания, отправьте /reminders.' if member
                    else 'Свадебный планировщик «Вместе».',
            'reply_markup': keyboard,
        }
