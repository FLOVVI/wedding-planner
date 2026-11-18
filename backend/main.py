import asyncio
import io
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError

from .auth import authenticate, issue_link, log_in, verify_telegram
from .models import COLLECTIONS, DemoLogin, Settings, Simulation, Subscription, TelegramLogin
from .notifications import TelegramBot, collect, subscribe
from .planner import apply_record, calculate_budget, lookup, program_view, remove_record
from .store import Store

ROOT = Path(__file__).resolve().parents[1]
MAX_IMAGE = 6 * 1024 * 1024
LinkKind = Literal['partner', 'team']


def validation_message(errors):
    first = errors[0]
    if first.get('type') == 'value_error':
        return first['msg'].removeprefix('Value error, ')
    return 'Проверьте обязательные поля, даты и числовые значения.'


def require_role(connection, request, *roles):
    identity = authenticate(connection, request.headers.get('authorization'))
    if roles and identity.role not in roles:
        raise HTTPException(403, 'Недостаточно прав для этого действия')
    return identity


def guard_revision(actual, requested):
    if actual != requested:
        raise HTTPException(409, 'План уже изменился. Обновите данные и повторите действие.')


def validate_image(raw):
    try:
        with Image.open(io.BytesIO(raw), formats=['PNG', 'JPEG']) as decoded:
            if decoded.width * decoded.height > 20_000_000:
                raise HTTPException(422, 'Размер схемы превышает 20 мегапикселей')
            format_name = decoded.format
            image = ImageOps.exif_transpose(decoded)
            image.thumbnail((2400, 2400))
            clean = image.convert('RGBA' if format_name == 'PNG' else 'RGB')
            clean.info.clear()
            output = io.BytesIO()
            clean.save(output, format=format_name, optimize=True)
            if len(output.getbuffer()) > MAX_IMAGE:
                raise HTTPException(422, 'Схема после обработки превышает 6 МБ')
            media = 'image/png' if format_name == 'PNG' else 'image/jpeg'
            return media, output.getvalue(), clean.width / clean.height
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(422, 'Выберите исправный файл PNG или JPEG') from None


def create_app(*, demo=False, sample=True, database=None):
    bot_token = '' if demo else os.environ.get('TELEGRAM_BOT_TOKEN', '')
    bot_username = os.environ.get('TELEGRAM_BOT_USERNAME', '').lstrip('@')
    mini_app_url = os.environ.get('TELEGRAM_MINI_APP_URL', '')
    store = Store(Path(database or ROOT / 'data' / ('demo.sqlite3' if demo else 'wedding.sqlite3')), demo, demo and sample)
    bot = TelegramBot(store, bot_token, mini_app_url) if bot_token and mini_app_url else None

    @asynccontextmanager
    async def lifespan(_app):
        jobs = [asyncio.create_task(bot.poll()), asyncio.create_task(bot.reminder_loop())] if bot else []
        try:
            yield
        finally:
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)

    app = FastAPI(title='Вместе', lifespan=lifespan)

    if not demo and mini_app_url:
        frontend = urlsplit(mini_app_url)
        if frontend.scheme == 'https' and frontend.hostname:
            app.add_middleware(
                CORSMiddleware,
                allow_origins=[f'{frontend.scheme}://{frontend.netloc}'],
                allow_methods=['GET', 'POST', 'PUT', 'DELETE'],
                allow_headers=['Authorization', 'Content-Type'],
            )

    @app.middleware('http')
    async def protect_api(request, call_next):
        if demo:
            peer = request.client.host if request.client else ''
            host = request.headers.get('host', '')
            loopback = peer in ('127.0.0.1', '::1') and re.fullmatch(r'(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?', host)
            if not loopback and (peer, host) != ('testclient', 'testserver'):
                return JSONResponse({'detail': 'Локальный режим доступен с этого устройства'}, status_code=403)
        response = await call_next(request)
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    @app.exception_handler(RequestValidationError)
    async def bad_input(_request, error):
        return JSONResponse({'detail': validation_message(error.errors())}, 422)

    @app.exception_handler(ValidationError)
    async def bad_record(_request, error):
        return JSONResponse({'detail': validation_message(error.errors())}, 422)

    @app.get('/api/config')
    def config():
        return {'demo': demo, 'botUsername': bot_username}

    @app.post('/api/session/demo')
    def demo_login(body: DemoLogin):
        if not demo:
            raise HTTPException(404)
        with store.connect(write=True) as connection:
            return log_in(connection, f'demo-{body.user}', body.invite)

    @app.post('/api/session/telegram')
    def telegram_login(body: TelegramLogin):
        if not bot_token:
            raise HTTPException(503, 'Подключение Telegram ещё не настроено')
        user_id, invite = verify_telegram(body.initData, bot_token)
        with store.connect(write=True) as connection:
            return log_in(connection, user_id, invite)

    @app.get('/api/session')
    def session(request: Request):
        with store.connect() as connection:
            identity = require_role(connection, request)
            return {'role': identity.role, 'userId': identity.user_id}

    @app.get('/api/program')
    def program(request: Request):
        with store.connect() as connection:
            require_role(connection, request)
            revision, plan = store.read(connection)
            return {'revision': revision, **program_view(plan)}

    @app.get('/api/plan')
    def full_plan(request: Request):
        with store.connect() as connection:
            require_role(connection, request, 'owner', 'editor')
            revision, plan = store.read(connection)
            return {'revision': revision, **plan, 'budget': calculate_budget(plan), 'program': program_view(plan)['blocks']}

    @app.put('/api/settings')
    def save_settings(body: Settings, revision: int, request: Request):
        with store.connect(write=True) as connection:
            require_role(connection, request, 'owner', 'editor')
            actual, plan = store.read(connection)
            guard_revision(actual, revision)
            plan['settings'] = body.model_dump(mode='json')
            store.save(connection, actual, plan)
            return {'revision': actual + 1}

    @app.post('/api/items/{collection}')
    @app.put('/api/items/{collection}/{item_id}')
    def save_item(collection: str, body: dict, revision: int, request: Request, item_id: str | None = None):
        with store.connect(write=True) as connection:
            require_role(connection, request, 'owner', 'editor')
            if collection not in COLLECTIONS:
                raise HTTPException(404)
            actual, plan = store.read(connection)
            guard_revision(actual, revision)
            if item_id is not None and not lookup(plan[collection], item_id):
                raise HTTPException(404, 'Запись уже удалена')
            item = COLLECTIONS[collection].model_validate(body).model_dump(mode='json')
            item['id'] = item_id or uuid4().hex
            apply_record(plan, collection, item)
            store.save(connection, actual, plan)
            return {'id': item['id'], 'revision': actual + 1}

    @app.delete('/api/items/{collection}/{item_id}')
    def delete_item(collection: str, item_id: str, revision: int, request: Request):
        with store.connect(write=True) as connection:
            require_role(connection, request, 'owner', 'editor')
            if collection not in COLLECTIONS:
                raise HTTPException(404)
            actual, plan = store.read(connection)
            guard_revision(actual, revision)
            item = lookup(plan[collection], item_id)
            if not item:
                raise HTTPException(404, 'Запись уже удалена')
            remove_record(plan, collection, item)
            store.save(connection, actual, plan)
            return {'revision': actual + 1}

    @app.get('/api/floor')
    def get_floor(request: Request):
        with store.connect() as connection:
            require_role(connection, request, 'owner', 'editor')
            row = connection.execute('SELECT media_type, data FROM floor_image WHERE id = 1').fetchone()
            if not row:
                raise HTTPException(404)
            return Response(row['data'], media_type=row['media_type'])

    @app.put('/api/floor')
    async def put_floor(revision: int, request: Request, filename: Annotated[str, Query(max_length=160)] = 'Схема'):
        with store.connect() as connection:
            require_role(connection, request, 'owner', 'editor')
        contents = bytearray()
        async for chunk in request.stream():
            if len(contents) + len(chunk) > MAX_IMAGE:
                raise HTTPException(413, 'Размер файла превышает 6 МБ')
            contents.extend(chunk)
        media, image, ratio = await asyncio.to_thread(validate_image, contents)
        with store.connect(write=True) as connection:
            require_role(connection, request, 'owner', 'editor')
            actual, plan = store.read(connection)
            guard_revision(actual, revision)
            connection.execute('INSERT OR REPLACE INTO floor_image VALUES (1, ?, ?)', (media, sqlite3.Binary(image)))
            plan['floor'] = {'name': filename, 'ratio': ratio, 'version': actual + 1}
            store.save(connection, actual, plan)
            return {'revision': actual + 1}

    @app.delete('/api/floor')
    def delete_floor(revision: int, request: Request):
        with store.connect(write=True) as connection:
            require_role(connection, request, 'owner', 'editor')
            actual, plan = store.read(connection)
            guard_revision(actual, revision)
            connection.execute('DELETE FROM floor_image WHERE id = 1')
            plan['floor'] = None
            store.save(connection, actual, plan)
            return {'revision': actual + 1}

    @app.get('/api/links')
    def links(request: Request):
        with store.connect() as connection:
            require_role(connection, request, 'owner', 'editor')
            team = connection.execute("SELECT 1 FROM links WHERE kind = 'team' AND revoked = 0").fetchone()
            partner = connection.execute("SELECT 1 FROM members WHERE role = 'editor'").fetchone()
            return {'teamActive': bool(team), 'partnerJoined': bool(partner)}

    @app.post('/api/links/{kind}')
    def create_link(kind: LinkKind, request: Request):
        with store.connect(write=True) as connection:
            roles = ('owner',) if kind == 'partner' else ('owner', 'editor')
            require_role(connection, request, *roles)
            return {'token': issue_link(connection, kind)}

    @app.delete('/api/links/{kind}')
    def revoke_link(kind: LinkKind, request: Request):
        with store.connect(write=True) as connection:
            roles = ('owner',) if kind == 'partner' else ('owner', 'editor')
            require_role(connection, request, *roles)
            connection.execute('UPDATE links SET revoked = 1 WHERE kind = ?', (kind,))
            return {'revoked': True}

    @app.get('/api/reminders')
    def reminders(request: Request):
        with store.connect() as connection:
            identity = require_role(connection, request, 'owner', 'editor')
            recipient = connection.execute('SELECT chat_id, enabled FROM subscriptions WHERE user_id = ?',
                                           (identity.user_id,)).fetchone()
            history = connection.execute('''
                SELECT id, message, created, status FROM reminders WHERE user_id = ? ORDER BY id DESC LIMIT 30
            ''', (identity.user_id,)).fetchall()
            return {'connected': bool(demo or recipient and recipient['chat_id']),
                    'enabled': bool(recipient and recipient['enabled']), 'history': [dict(row) for row in history]}

    @app.put('/api/reminders')
    def set_reminders(body: Subscription, request: Request):
        with store.connect(write=True) as connection:
            identity = require_role(connection, request, 'owner', 'editor')
            recipient = connection.execute('SELECT chat_id FROM subscriptions WHERE user_id = ?',
                                           (identity.user_id,)).fetchone()
            if not demo and not (recipient and recipient['chat_id']):
                raise HTTPException(409, 'Сначала отправьте /start боту в личном чате')
            subscribe(connection, identity.user_id, identity.user_id if demo else recipient['chat_id'], body.enabled)
            return {'enabled': body.enabled}

    @app.post('/api/reminders/simulate')
    def simulate(body: Simulation, request: Request):
        if not demo:
            raise HTTPException(404)
        with store.connect() as connection:
            require_role(connection, request, 'owner', 'editor')
            _, plan = store.read(connection)
        at = body.at if body.at.tzinfo else body.at.replace(tzinfo=ZoneInfo(plan['settings']['timezone']))
        return {'created': len(collect(store, at, simulate=True))}

    @app.get('/')
    def index():
        dist = ROOT / 'dist' / 'index.html'
        if not dist.is_file():
            return Response('Сначала соберите интерфейс командой npm run build.', media_type='text/plain', status_code=503)
        return FileResponse(dist, headers={'Cache-Control': 'no-cache'})

    app.mount('/assets', StaticFiles(directory=ROOT / 'dist' / 'assets', check_dir=False), name='assets')
    return app
