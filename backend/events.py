import re
import secrets
import time
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import digest, live_link, log_in, verify_telegram
from .models import Settings, TelegramLogin
from .planner import program_view
from .store import Store


class OpenEvent(BaseModel):
    invite: str | None = Field(default=None, max_length=64)


def bearer(request, length):
    value = request.headers.get('authorization', '')
    if not re.fullmatch(r'Bearer [A-Za-z0-9_-]{' + str(length) + '}', value):
        return None
    return digest(value[7:])


class EventDirectory:
    def __init__(self, ledger: Store, child_factory=None):
        self.ledger = ledger
        self.child_factory = child_factory
        self.directory = ledger.path.parent / (ledger.path.stem + '-events')
        with ledger.connect() as connection:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account_sessions (
                    digest TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bot_selection (
                    user_id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id)
                );
            ''')

    @lru_cache(maxsize=96)
    def store(self, event_id, owner_id):
        return Store(self.directory / (event_id + '.sqlite3'), demo=False, sample=False, owner_id=owner_id)

    def get(self, event_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{22}', event_id):
            raise HTTPException(404, 'Мероприятие не найдено')
        with self.ledger.connect() as connection:
            event = connection.execute('SELECT owner_id FROM events WHERE id = ?', (event_id,)).fetchone()
        if event is None:
            raise HTTPException(404, 'Мероприятие не найдено')
        return self.store(event_id, event['owner_id'])

    def sign_in(self, user_id):
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self.ledger.connect(write=True) as connection:
            connection.execute('DELETE FROM account_sessions WHERE expires <= ?', (now,))
            connection.execute('INSERT INTO account_sessions VALUES (?, ?, ?)', (digest(token), user_id, now + 16 * 3600))
        return {'token': token}

    def account(self, request):
        with self.ledger.connect() as connection:
            row = connection.execute(
                'SELECT user_id FROM account_sessions WHERE digest = ? AND expires > ?',
                (bearer(request, 43), int(time.time())),
            ).fetchone()
        if row is None:
            raise HTTPException(401, 'Откройте приложение из Telegram')
        return row['user_id']

    def list(self, user_id):
        with self.ledger.connect() as connection:
            events = connection.execute('SELECT id, owner_id FROM events ORDER BY rowid DESC').fetchall()
        result = []
        for event in events:
            store = self.store(event['id'], event['owner_id'])
            with store.connect() as connection:
                membership = connection.execute('SELECT role FROM members WHERE user_id = ?', (user_id,)).fetchone()
                if membership:
                    _, plan = store.read(connection)
                    name, date = (plan['settings'][key] for key in ('name', 'date'))
                    result.append({'id': event['id'], 'name': name, 'date': date, 'role': membership['role']})
        return result

    def create(self, user_id, settings, event_id=None):
        event_id = event_id or secrets.token_urlsafe(16)
        with self.ledger.connect(write=True) as connection:
            existing = connection.execute('SELECT owner_id FROM events WHERE id = ?', (event_id,)).fetchone()
            if not existing:
                event = self.store(event_id, user_id)
                with event.connect(write=True) as event_connection:
                    revision, plan = event.read(event_connection)
                    plan['settings'] = settings.model_dump(mode='json')
                    event.save(event_connection, revision, plan)
                connection.execute('INSERT INTO events VALUES (?, ?)', (event_id, user_id))
            elif existing['owner_id'] != user_id:
                raise HTTPException(409, 'Не удалось создать мероприятие')
        return {'id': event_id}

    def select(self, user_id, event_id):
        with self.ledger.connect(write=True) as connection:
            connection.execute('INSERT OR REPLACE INTO bot_selection VALUES (?, ?)', (user_id, event_id))

    def selected(self, user_id):
        with self.ledger.connect() as connection:
            row = connection.execute('SELECT event_id FROM bot_selection WHERE user_id = ?', (user_id,)).fetchone()
        if not row:
            raise HTTPException(403, 'Сначала выберите мероприятие через /events')
        return row['event_id']

    @staticmethod
    def grant_editor(connection, user_id, invite):
        current = connection.execute('SELECT role FROM members WHERE user_id = ?', (user_id,)).fetchone()
        if current:
            return
        link = live_link(connection, digest(invite), int(time.time()))
        if not link or link['kind'] != 'editor':
            raise HTTPException(403, 'Приглашение уже использовано или было отозвано')
        connection.execute("INSERT INTO members VALUES (?, 'editor')", (user_id,))
        connection.execute('UPDATE links SET revoked = 1 WHERE digest = ?', (digest(invite),))

    def router(self, bot_token):
        router = APIRouter(prefix='/api/events')

        @router.post('/login')
        def login(body: TelegramLogin):
            user_id, _invite = verify_telegram(body.initData, bot_token)
            return self.sign_in(user_id)

        @router.get('')
        def events(request: Request):
            return self.list(self.account(request))

        @router.post('')
        def create_event(body: Settings, request: Request):
            return self.create(self.account(request), body)

        @router.post('/{event_id}/open')
        def open_event(event_id: str, body: OpenEvent, request: Request):
            user_id = self.account(request)
            event = self.get(event_id)
            with event.connect(write=True) as connection:
                if body.invite:
                    self.grant_editor(connection, user_id, body.invite)
                return log_in(connection, user_id, None)

        @router.get('/{event_id}/program')
        def read_program(event_id: str, request: Request):
            event = self.get(event_id)
            with event.connect() as connection:
                link = live_link(connection, bearer(request, 32), int(time.time()))
                if not link or link['kind'] != 'team':
                    raise HTTPException(403, 'Ссылка недействительна или была отозвана')
                revision, plan = event.read(connection)
                return {'revision': revision, **program_view(plan)}

        return router

    @lru_cache(maxsize=96)
    def child(self, event_id):
        return self.child_factory(self.get(event_id))

    async def __call__(self, scope, receive, send):
        try:
            child = self.child(scope['path_params']['event_id'])
        except HTTPException as error:
            await JSONResponse({'detail': error.detail}, error.status_code)(scope, receive, send)
            return
        await child(scope, receive, send)
