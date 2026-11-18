import asyncio
import logging
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import httpx

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
        self.base_url = f'https://api.telegram.org/bot{token}'
        self.mini_app_url = mini_app_url

    async def request(self, client, method, payload):
        try:
            response = await client.post(f'{self.base_url}/{method}', json=payload)
            data = response.json()
            if response.is_success and data.get('ok'):
                return data.get('result')
            logger.warning('Telegram method %s returned HTTP %s', method, response.status_code)
        except (httpx.HTTPError, ValueError):
            logger.warning('Telegram method %s did not return a usable response', method)
        return None

    async def reminder_loop(self):
        with self.store.connect(write=True) as connection:
            connection.execute("UPDATE reminders SET status = 'unknown' WHERE status = 'sending'")
        async with httpx.AsyncClient(timeout=25) as client:
            while True:
                collect(self.store, None, simulate=False)
                while delivery := claim_delivery(self.store):
                    identifier, chat_id, message = delivery
                    response = await self.request(client, 'sendMessage', {'chat_id': chat_id, 'text': message})
                    with self.store.connect(write=True) as connection:
                        connection.execute('UPDATE reminders SET status = ? WHERE id = ?',
                                           ('sent' if response is not None else 'unknown', identifier))
                await asyncio.sleep(30)

    async def poll(self):
        with self.store.connect() as connection:
            row = connection.execute("SELECT value FROM bot_state WHERE name = 'offset'").fetchone()
            offset = row['value'] if row else 0
        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                updates = await self.request(client, 'getUpdates', {
                    'offset': offset, 'timeout': 20, 'allowed_updates': ['message'],
                })
                if updates is None:
                    await asyncio.sleep(5)
                    continue
                for update in updates:
                    with self.store.connect(write=True) as connection:
                        reply = self.handle_message(connection, update.get('message', {}))
                        offset = update['update_id'] + 1
                        connection.execute("INSERT OR REPLACE INTO bot_state VALUES ('offset', ?)", (offset,))
                    if reply:
                        await self.request(client, 'sendMessage', reply)

    def handle_message(self, connection, message):
        if message.get('chat', {}).get('type') != 'private' or 'from' not in message:
            return None
        words = message.get('text', '').split(maxsplit=1)
        command = words[0].split('@')[0] if words else ''
        if command not in ('/start', '/reminders', '/stop'):
            return None
        user_id = str(message['from']['id'])
        chat_id = str(message['chat']['id'])
        member = connection.execute('SELECT 1 FROM members WHERE user_id = ?', (user_id,)).fetchone()
        if command == '/stop' and member:
            subscribe(connection, user_id, chat_id, False)
            return {'chat_id': chat_id, 'text': 'Напоминания отключены.'}
        if command == '/reminders' and member:
            subscribe(connection, user_id, chat_id, True)
            return {'chat_id': chat_id, 'text': 'Напоминания о задачах и платежах включены.'}
        if command == '/start' and member:
            connection.execute('INSERT OR IGNORE INTO subscriptions VALUES (?, ?, 0)', (user_id, chat_id))
        return {
            'chat_id': chat_id,
            'text': 'Откройте свадебный план. Чтобы включить напоминания, отправьте /reminders.' if member
                    else 'Откройте план по приглашению от организаторов.',
            'reply_markup': {'inline_keyboard': [[{
                'text': 'Открыть план', 'web_app': {'url': self.mini_app_url},
            }]]},
        }
