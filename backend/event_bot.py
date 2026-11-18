import base64
import hashlib
import json
import re
import time
import zlib
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import HTTPException
from pydantic import ValidationError
from telebot.types import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup, WebAppInfo

from .auth import digest, issue_link, live_link, revoke_editor
from .events import EventDirectory
from .models import Guest, ProgramBlock, Settings, Task
from .planner import apply_record, program_view


class EventBot:
    def __init__(self, store, url):
        self.events = EventDirectory(store)
        self.url = url
        self.username = ''

    @staticmethod
    def role(connection, user_id, owner=False):
        member = connection.execute('SELECT role FROM members WHERE user_id = ?', (user_id,)).fetchone()
        if not member or (owner and member['role'] != 'owner'):
            raise HTTPException(403, 'У вас нет доступа к этому действию.')
        return member['role']

    @staticmethod
    def reply(user_id, text, keyboard=None):
        return {'chat_id': int(user_id), 'text': text, 'reply_markup': keyboard}

    def catalog(self, user_id):
        events = self.events.list(user_id)
        keyboard = InlineKeyboardMarkup()
        if button := self.snapshot_button('Открыть «Вместе»', 'catalog', {'bot': self.username, 'events': events[:25]}):
            keyboard.add(button)
        for event in events[:25]:
            keyboard.add(InlineKeyboardButton(event['name'][:56], callback_data='open:' + event['id']))
        keyboard.add(InlineKeyboardButton('Создать мероприятие', callback_data='new'))
        text = 'Мои мероприятия. Выберите план.' if events else 'Мои мероприятия. Создайте первый план свадьбы.'
        return self.reply(user_id, text, keyboard)

    def form_url(self, kind, event_id=None):
        address = urlsplit(self.url)
        params = dict(parse_qsl(address.query))
        params['telegram'] = kind
        if event_id:
            params['event'] = event_id
        return urlunsplit(address._replace(query=urlencode(params), fragment=''))

    def new_button(self, user_id):
        keyboard = ReplyKeyboardMarkup(resize_keyboard=True)
        keyboard.add(KeyboardButton('Создать мероприятие', web_app=WebAppInfo(self.form_url('create'))))
        return self.reply(user_id, 'Нажмите «Создать мероприятие» в нижней клавиатуре.', keyboard)

    def edit_buttons(self, user_id, event_id):
        with self.events.get(event_id).connect() as connection:
            self.role(connection, user_id)
        keyboard = ReplyKeyboardMarkup(resize_keyboard=True)
        for kind, label in [('block', 'Добавить событие'), ('guest', 'Добавить гостя'), ('task', 'Добавить задачу')]:
            keyboard.add(KeyboardButton(label, web_app=WebAppInfo(self.form_url(kind, event_id))))
        return self.reply(user_id, 'Выберите форму в нижней клавиатуре.', keyboard)

    def snapshot_button(self, label, kind, data):
        payload = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
        encoded = base64.urlsafe_b64encode(zlib.compress(payload)).decode().rstrip('=')
        if len(encoded) > 2600:
            return None
        url = urlunsplit(urlsplit(self.url)._replace(fragment=kind + '=' + encoded))
        return InlineKeyboardButton(label, web_app=WebAppInfo(url))

    def view(self, user_id, event_id, viewer_token=None):
        event = self.events.get(event_id)
        with event.connect() as connection:
            if viewer_token:
                link = live_link(connection, digest(viewer_token), int(time.time()))
                if not link or link['kind'] != 'team':
                    raise HTTPException(403, 'Ссылка недействительна или была отозвана.')
                role = 'viewer'
            else:
                role = self.role(connection, user_id)
            revision, data = event.read(connection)
            program = program_view(data)
        settings = program['settings']
        lines = [settings['name']]
        lines.extend(settings[key] for key in ('date', 'venue') if settings[key])
        lines.append('')
        lines.extend(f"{block['start'][:5]}{' +1' if block['nextDay'] else ''}  {block['title']}"
                     for block in program['blocks'])
        if not program['blocks']:
            lines.append('Программа пока пуста.')
        keyboard = InlineKeyboardMarkup()
        if button := self.snapshot_button('Открыть программу', 'program', {'revision': revision, **program}):
            keyboard.add(button)
        if role != 'viewer':
            self.events.select(user_id, event_id)
            keyboard.add(InlineKeyboardButton('Добавить в план', callback_data='forms:' + event_id))
            if role == 'owner':
                keyboard.add(InlineKeyboardButton('Ссылка для гостей', callback_data='share:' + event_id),
                             InlineKeyboardButton('Отозвать ссылку', callback_data='unlink:' + event_id))
                keyboard.add(InlineKeyboardButton('Добавить редактора', callback_data='edit:' + event_id),
                             InlineKeyboardButton('Редакторы', callback_data='roles:' + event_id))
            keyboard.add(InlineKeyboardButton('Мои мероприятия', callback_data='catalog'))
        return self.reply(user_id, '\n'.join(lines)[:3900], keyboard if keyboard.keyboard else None)

    def create(self, user_id, message_id, settings):
        unique = hashlib.sha256(f'telegram-event:{user_id}:{message_id}'.encode()).digest()[:16]
        event_id = base64.urlsafe_b64encode(unique).decode().rstrip('=')
        self.events.create(user_id, settings, event_id)
        return self.view(user_id, event_id)

    def invite(self, user_id, event_id, kind):
        event = self.events.get(event_id)
        with event.connect(write=True) as connection:
            self.role(connection, user_id, owner=True)
            token = issue_link(connection, kind)
        mode = 'edit' if kind == 'editor' else 'view'
        label = 'Одноразовое приглашение редактора' if kind == 'editor' else 'Ссылка на актуальную программу'
        return self.reply(user_id, f'{label}:\nhttps://t.me/{self.username}?start={mode}_{event_id}_{token}')

    def editors(self, user_id, event_id):
        with self.events.get(event_id).connect() as connection:
            self.role(connection, user_id, owner=True)
            editors = [row['user_id'] for row in connection.execute("SELECT user_id FROM members WHERE role = 'editor'")]
        keyboard = InlineKeyboardMarkup()
        for editor in editors[:40]:
            keyboard.add(InlineKeyboardButton('Убрать ' + editor, callback_data=f'remove:{event_id}.{editor}'))
        keyboard.add(InlineKeyboardButton('Отозвать приглашения', callback_data='uninvite:' + event_id))
        keyboard.add(InlineKeyboardButton('К мероприятию', callback_data='open:' + event_id))
        return self.reply(user_id, 'Редакторы мероприятия' if editors else 'Редакторов пока нет.', keyboard)

    def change(self, user_id, message_id, collection, record, event_id=None):
        event_id = event_id or self.events.selected(user_id)
        store = self.events.get(event_id)
        with store.connect(write=True) as connection:
            self.role(connection, user_id)
            revision, data = store.read(connection)
            item = record.model_dump(mode='json')
            item['id'] = hashlib.sha256(f'{user_id}:{message_id}'.encode()).hexdigest()[:32]
            apply_record(data, collection, item)
            store.save(connection, revision, data)
        if collection == 'blocks':
            return self.view(user_id, event_id)
        return self.reply(user_id, 'Добавлено в общий план.')

    def message(self, message):
        if not message or message.chat.type != 'private' or not message.from_user:
            return None
        user_id = str(message.from_user.id)
        try:
            return self.handle(user_id, message)
        except HTTPException as error:
            return self.reply(user_id, error.detail)
        except (ValidationError, ValueError, TypeError, KeyError):
            return self.reply(user_id, 'Проверьте название, дату или время и повторите.')

    def handle(self, user_id, message):
        if message.web_app_data:
            data = json.loads(message.web_app_data.data)
            if not isinstance(data, dict):
                raise ValueError()
            if data.get('type') == 'create_event':
                return self.create(user_id, message.message_id, Settings.model_validate(data['settings']))
            if data.get('type') == 'add_record':
                collection, model = {'block': ('blocks', ProgramBlock), 'guest': ('guests', Guest),
                                     'task': ('tasks', Task)}[data['collection']]
                event_id = data['eventId']
                if not isinstance(event_id, str) or not event_id:
                    raise ValueError()
                return self.change(user_id, message.message_id, collection, model.model_validate(data['record']), event_id)
            return None
        text = (message.text or '').strip()
        if not text:
            return None
        command, _, argument = text.partition(' ')
        command = command.split('@')[0]
        if command == '/start':
            if argument == 'new':
                return self.new_button(user_id)
            opening = re.fullmatch(r'open_([A-Za-z0-9_-]{22})', argument)
            if opening:
                return self.view(user_id, opening[1])
            link = re.fullmatch(r'(edit|view)_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{32})', argument)
            if not link:
                return self.catalog(user_id)
            mode, event_id, token = link.groups()
            if mode == 'view':
                return self.view(user_id, event_id, viewer_token=token)
            with self.events.get(event_id).connect(write=True) as connection:
                self.events.grant_editor(connection, user_id, token)
            return self.view(user_id, event_id)
        if command == '/events':
            return self.catalog(user_id)
        if command == '/new':
            return self.create(user_id, message.message_id, Settings(name=argument)) if argument else self.new_button(user_id)
        if command == '/guest':
            return self.change(user_id, message.message_id, 'guests', Guest(name=argument))
        if command in ('/block', '/task'):
            when, _, title = argument.partition(' ')
            if command == '/block':
                return self.change(user_id, message.message_id, 'blocks', ProgramBlock(title=title, start=when, duration=30))
            return self.change(user_id, message.message_id, 'tasks', Task(name=title, due=when))
        return None

    def callback(self, query):
        if not query.message or query.message.chat.type != 'private' or query.message.chat.id != query.from_user.id:
            return None
        user_id = str(query.from_user.id)
        action, _, event_id = (query.data or '').partition(':')
        try:
            if action == 'catalog':
                return self.catalog(user_id)
            if action == 'new':
                return self.new_button(user_id)
            if action == 'open':
                return self.view(user_id, event_id)
            if action == 'forms':
                return self.edit_buttons(user_id, event_id)
            if action == 'edit':
                return self.invite(user_id, event_id, 'editor')
            if action == 'share':
                return self.invite(user_id, event_id, 'team')
            if action == 'roles':
                return self.editors(user_id, event_id)
            if action in ('unlink', 'uninvite'):
                with self.events.get(event_id).connect(write=True) as connection:
                    self.role(connection, user_id, owner=True)
                    kind = 'team' if action == 'unlink' else 'editor'
                    connection.execute('UPDATE links SET revoked = 1 WHERE kind = ?', (kind,))
                return self.reply(user_id, 'Доступ по ссылке отозван.')
            if action == 'remove':
                event_id, _, editor_id = event_id.partition('.')
                with self.events.get(event_id).connect(write=True) as connection:
                    self.role(connection, user_id, owner=True)
                    revoke_editor(connection, editor_id)
                return self.editors(user_id, event_id)
        except HTTPException as error:
            return self.reply(user_id, error.detail)
        return None
