import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from .models import COLLECTIONS, Settings


def empty_plan():
    return {
        'settings': Settings().model_dump(mode='json'),
        'floor': None,
        **{name: [] for name in COLLECTIONS},
    }


def sample_plan():
    plan = empty_plan()
    due = (date.today() + timedelta(days=2)).isoformat()
    plan['settings'].update(name='Саша и Женя', date='2027-07-17', venue='Усадьба «Липы»', banquetPrice=5500)
    plan['artists'] = [
        dict(id='duet', name='Лея и Марк', role='Акустический дуэт', contact='', fee=65000,
             sound='Два вокальных микрофона, DI для гитары и монитор у сцены.'),
        dict(id='dj', name='DJ Север', role='DJ-сет', contact='', fee=45000,
             sound='Пульт и свободный стереоканал.'),
        dict(id='photo', name='Алина Морозова', category='photo', role='Фотограф', contact='', fee=42000,
             sound='Встретиться у главного входа за 15 минут до съёмки.'),
    ]
    plan['blocks'] = [
        dict(id='check', title='Саундчек дуэта', kind='soundcheck', start='15:30', duration=30,
             responsible='Звукорежиссёр', artistId='duet', tracks=[], notes='Проверить уровни вокала и гитары.'),
        dict(id='welcome', title='Сбор гостей', kind='welcome', start='16:30', duration=30,
             responsible='Координатор', artistId=None, tracks=[], notes='Тихая фоновая музыка на террасе.'),
        dict(id='ceremony', title='Выездная церемония', kind='ceremony', start='17:00', duration=25,
             responsible='Ведущий', artistId=None, tracks=[], notes='Гости занимают места за пять минут до начала.'),
        dict(id='portrait', title='Фотографии с семьёй и друзьями', kind='photo', start='17:30', duration=25,
             responsible='', artistId='photo', tracks=[], notes='Собраться у арки после церемонии.'),
        dict(id='dinner', title='Начало банкета', kind='dinner', start='18:00', duration=15,
             responsible='Координатор', artistId=None, tracks=[], notes='Показать гостям карту рассадки.'),
        dict(id='dance', title='Первый танец', kind='dance', start='18:15', duration=5,
             responsible='Ведущий', artistId=None, tracks=[], notes='Запустить трек после сигнала ведущего.'),
        dict(id='live', title='Акустический сет', kind='live', start='18:30', duration=45,
             responsible='', artistId='duet', tracks=[], notes='Дуэт выходит после первого тоста.'),
        dict(id='cake', title='Вынос торта', kind='cake', start='19:45', duration=15,
             responsible='Ведущий', artistId=None, tracks=[], notes='Фотограф готов у танцпола.'),
        dict(id='party', title='Танцы и DJ-сет', kind='dj', start='20:00', duration=120,
             responsible='', artistId='dj', tracks=[], notes='Открыть танцпол после торта.'),
    ]
    plan['objects'] = [
        dict(id='a', name='Стол 1', kind='round', capacity=6, x=.25, y=.43, width=.14, height=.22, rotation=0),
        dict(id='b', name='Стол 2', kind='round', capacity=6, x=.74, y=.43, width=.14, height=.22, rotation=0),
        dict(id='c', name='Стол 3', kind='rectangle', capacity=8, x=.26, y=.74, width=.19, height=.16, rotation=0),
        dict(id='d', name='Стол 4', kind='rectangle', capacity=8, x=.73, y=.74, width=.19, height=.16, rotation=0),
        dict(id='stage', name='Сцена', kind='stage', capacity=0, x=.5, y=.16, width=.31, height=.16, rotation=0),
        dict(id='floor', name='Танцпол', kind='dance', capacity=0, x=.5, y=.52, width=.22, height=.34, rotation=0),
        dict(id='door', name='Вход', kind='entrance', capacity=0, x=.5, y=.9, width=.15, height=.09, rotation=0),
    ]
    people = [
        ('Анна Волкова', 'Волковы', 'confirmed', 'a'), ('Михаил Волков', 'Волковы', 'confirmed', 'a'),
        ('Нина Орлова', 'Орловы', 'confirmed', 'b'), ('Лев Орлов', 'Орловы', 'waiting', None),
        ('Ольга Соколова', '', 'confirmed', 'c'), ('Тимур Ахметов', '', 'waiting', None),
        ('Елизавета Лебедева', '', 'confirmed', 'd'), ('Даниил Ким', '', 'confirmed', None),
    ]
    plan['guests'] = [dict(id=f'g{i}', name=name, family=family, status=status, tableId=table)
                      for i, (name, family, status, table) in enumerate(people, 1)]
    plan['expenses'] = [dict(id='decor', name='Флористика', amount=24000)]
    plan['payments'] = [
        dict(id='deposit', name='Предоплата дуэту', source='artist:duet', amount=15000, due=None, paid=True),
        dict(id='p1', name='Предоплата диджею', source='artist:dj', amount=12000, due=due, paid=False),
    ]
    plan['tasks'] = [
        dict(id='t1', name='Согласовать звуковой райдер с площадкой', due=due, done=False),
        dict(id='t2', name='Уточнить меню для банкета', due=due, done=False),
        dict(id='t3', name='Подтвердить дату и площадку', due=due, done=True),
    ]
    return plan


class Store:
    def __init__(self, path: Path, demo: bool, sample: bool, owner_id: str | None = None):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS plan (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    revision INTEGER NOT NULL, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS floor_image (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    media_type TEXT NOT NULL, data BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS links (
                    digest TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER, revoked INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS members (
                    user_id TEXT PRIMARY KEY, role TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    digest TEXT PRIMARY KEY, user_id TEXT NOT NULL, team_link TEXT, expires INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS subscriptions (
                    user_id TEXT PRIMARY KEY, chat_id TEXT, enabled INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS reminders (
                    id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL, due TEXT NOT NULL,
                    message TEXT NOT NULL, created TEXT NOT NULL, status TEXT NOT NULL,
                    UNIQUE (user_id, source, due)
                );
                CREATE TABLE IF NOT EXISTS bot_state (
                    name TEXT PRIMARY KEY, value INTEGER NOT NULL
                );
            ''')
            connection.execute('INSERT OR IGNORE INTO plan VALUES (1, 0, ?)',
                               (json.dumps(sample_plan() if sample else empty_plan(), ensure_ascii=False),))
            if demo:
                connection.execute("INSERT OR IGNORE INTO members VALUES ('demo-owner', 'owner')")
            elif owner := owner_id or os.environ.get('TELEGRAM_OWNER_ID'):
                connection.execute("DELETE FROM members WHERE role = 'owner' AND user_id <> ?", (owner,))
                connection.execute("INSERT INTO members VALUES (?, 'owner') ON CONFLICT(user_id) DO UPDATE SET role = 'owner'", (owner,))

    @contextmanager
    def connect(self, write=False):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            if write:
                connection.execute('BEGIN IMMEDIATE')
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def read(connection):
        row = connection.execute('SELECT revision, data FROM plan WHERE id = 1').fetchone()
        return row['revision'], json.loads(row['data'])

    @staticmethod
    def save(connection, revision, plan):
        connection.execute('UPDATE plan SET revision = ?, data = ? WHERE id = 1',
                           (revision + 1, json.dumps(plan, ensure_ascii=False)))
