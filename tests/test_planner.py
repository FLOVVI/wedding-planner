import base64
import hashlib
import hmac
import io
import json
import os
import time
import unittest
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import urlencode

from fastapi.testclient import TestClient
from PIL import Image
from telebot import types

from backend.main import create_app
from backend.event_bot import EventBot
from backend.notifications import TelegramBot, claim_delivery, collect
from backend.store import Store


class PlannerTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / 'planner.db'
        self.api = TestClient(create_app(demo=True, sample=False, database=self.database))
        self.addCleanup(self.api.close)
        self.owner = self.login('owner')

    def login(self, user, invite=None):
        response = self.api.post('/api/session/demo', json={'user': user, 'invite': invite})
        self.assertEqual(response.status_code, 200, response.text)
        return {'Authorization': 'Bearer ' + response.json()['token']}

    def plan(self, headers=None):
        response = self.api.get('/api/plan', headers=headers or self.owner)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def add(self, collection, item):
        response = self.api.post(f'/api/items/{collection}', headers=self.owner,
                                 params={'revision': self.plan()['revision']}, json=item)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['id']

    def update(self, collection, identifier, item, headers=None, revision=None):
        return self.api.put(f'/api/items/{collection}/{identifier}', headers=headers or self.owner,
                            params={'revision': self.plan()['revision'] if revision is None else revision},
                            json=item)

    def make_link(self, kind):
        response = self.api.post(f'/api/links/{kind}', headers=self.owner)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['token']

    def test_music_budget_and_team_projection(self):
        artist = self.add('artists', {'name': 'Квартет', 'fee': 65000, 'contact': 'Личный телефон',
                                      'sound': 'Два монитора'})
        self.add('blocks', {'title': 'Саундчек', 'kind': 'soundcheck', 'start': '23:55', 'duration': 20,
                            'artistId': artist})
        self.add('blocks', {'title': 'Выступление', 'kind': 'live', 'start': '00:10', 'nextDay': True,
                            'duration': 30, 'artistId': artist, 'tracks': ['https://example.com/track'],
                            'notes': 'Выход по сигналу'})
        self.add('payments', {'name': 'Предоплата', 'source': f'artist:{artist}', 'amount': 15000, 'paid': True})
        totals = self.plan()['budget']
        self.assertEqual((totals['total'], totals['paid'], totals['remaining']), (65000, 15000, 50000))
        token = self.make_link('team')
        team = self.login('team', token)
        program = self.api.get('/api/program', headers=team).json()
        self.assertEqual([block['title'] for block in program['blocks']], ['Саундчек', 'Выступление'])
        self.assertTrue(all(block['conflict'] for block in program['blocks']))
        self.assertEqual(program['blocks'][1]['artistSound'], 'Два монитора')
        self.assertEqual(program['blocks'][1]['tracks'], ['https://example.com/track'])
        self.assertNotIn('Личный телефон', str(program))
        self.assertNotIn('banquetPrice', program['settings'])
        self.assertEqual(self.api.get('/api/plan', headers=team).status_code, 403)
        self.assertEqual(self.api.get('/api/floor', headers=team).status_code, 403)
        self.assertEqual(self.api.post('/api/items/guests?revision=0', headers=team, json={}).status_code, 403)
        self.api.delete('/api/links/team', headers=self.owner).raise_for_status()
        self.assertEqual(self.api.get('/api/program', headers=team).status_code, 401)
        self.assertEqual(self.api.post('/api/session/demo', json={'user': 'team', 'invite': token}).status_code, 403)

    def test_two_editors_cannot_double_book_last_place(self):
        invite = self.make_link('partner')
        partner = self.login('partner', invite)
        self.assertEqual(self.api.post('/api/session/demo', json={'user': 'visitor', 'invite': invite}).status_code, 403)
        table = self.add('objects', {'name': 'Стол', 'kind': 'round', 'capacity': 1})
        first = self.add('guests', {'name': 'Анна'})
        second = self.add('guests', {'name': 'Алексей'})
        revision = self.plan()['revision']

        with ThreadPoolExecutor(max_workers=2) as executor:
            updates = [
                executor.submit(self.update, 'guests', first, {'name': 'Анна', 'tableId': table}, self.owner, revision),
                executor.submit(self.update, 'guests', second, {'name': 'Алексей', 'tableId': table}, partner, revision),
            ]
            self.assertEqual(sorted(update.result().status_code for update in updates), [200, 409])
        guests = self.plan(partner)['guests']
        seated = next(guest for guest in guests if guest['tableId'])
        unseated = next(guest for guest in guests if not guest['tableId'])
        self.assertEqual(self.update('guests', unseated['id'], {**unseated, 'tableId': table}).status_code, 409)
        self.update('guests', seated['id'], {**seated, 'status': 'declined'}).raise_for_status()
        self.assertEqual(self.plan()['budget']['expected'], 1)
        self.update('guests', unseated['id'], {**unseated, 'tableId': table}).raise_for_status()

    def test_wedding_timeline_shares_non_music_events_and_protects_contract_details(self):
        photographer = self.add('artists', {'name': 'Фотограф', 'category': 'photo', 'fee': 30000,
                                            'contact': 'Личный номер', 'sound': 'Встретиться у входа'})
        for title, kind, start in [
            ('Церемония', 'ceremony', '15:00'), ('Фотосъёмка', 'photo', '15:30'), ('Торт', 'cake', '20:00'),
        ]:
            self.add('blocks', {'title': title, 'kind': kind, 'start': start, 'duration': 25,
                                'artistId': photographer if kind == 'photo' else None})
        full = self.plan()
        self.assertEqual(full['artists'][0]['category'], 'photo')
        self.assertEqual(full['budget']['total'], 30000)
        team = self.login('team', self.make_link('team'))
        published = self.api.get('/api/program', headers=team).json()['blocks']
        self.assertEqual([block['kind'] for block in published], ['ceremony', 'photo', 'cake'])
        self.assertEqual(published[1]['artistSound'], 'Встретиться у входа')
        self.assertNotIn('Личный номер', str(published))

    def test_image_replacement_preserves_coordinates_and_assignments(self):
        table = self.add('objects', {'name': 'Стол', 'kind': 'rectangle', 'capacity': 4, 'x': .3, 'rotation': 22})
        self.add('guests', {'name': 'Анна', 'family': 'Волковы', 'tableId': table})
        for format_name, size in [('PNG', (320, 200)), ('JPEG', (600, 300))]:
            image = io.BytesIO()
            Image.new('RGB', size, color='white').save(image, format=format_name)
            response = self.api.put('/api/floor', headers=self.owner, content=image.getvalue(),
                                    params={'revision': self.plan()['revision'], 'filename': f'Scheme.{format_name.lower()}'})
            self.assertEqual(response.status_code, 200, response.text)
            floor = self.api.get('/api/floor', headers=self.owner)
            self.assertEqual(Image.open(io.BytesIO(floor.content)).size, size)
        plan = self.plan()
        self.assertEqual((plan['floor']['ratio'], plan['objects'][0]['x'], plan['objects'][0]['rotation']), (2, .3, 22))
        self.assertEqual(plan['guests'][0]['tableId'], table)
        bad = self.api.put('/api/floor', headers=self.owner, content=b'<svg/>', params={'revision': plan['revision']})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(self.plan()['floor']['ratio'], 2)

    def test_reminders_are_persistent_and_skip_closed_items(self):
        self.add('tasks', {'name': 'Уточнить меню', 'due': '2027-07-12'})
        self.add('tasks', {'name': 'Готовая задача', 'due': '2027-07-12', 'done': True})
        self.add('payments', {'name': 'Остаток', 'due': '2027-07-12', 'source': 'banquet', 'amount': 9000})
        self.add('payments', {'name': 'Оплаченный платёж', 'due': '2027-07-12', 'source': 'banquet',
                              'amount': 3000, 'paid': True})
        self.api.put('/api/reminders', headers=self.owner, json={'enabled': True}).raise_for_status()

        def simulate(client, value):
            return client.post('/api/reminders/simulate', headers=self.owner, json={'at': value}).json()['created']

        self.assertEqual(simulate(self.api, '2027-07-11T09:59'), 0)
        self.assertEqual(simulate(self.api, '2027-07-11T10:00'), 2)
        with TestClient(create_app(demo=True, sample=False, database=self.database)) as restarted:
            self.assertEqual(simulate(restarted, '2027-07-11T10:00'), 0)
            messages = [item['message'] for item in restarted.get('/api/reminders', headers=self.owner).json()['history']]
            self.assertEqual(len(messages), 2)
            self.assertTrue(any('Остаток' in message for message in messages))
            self.assertTrue(any('Уточнить меню' in message for message in messages))

    def test_real_queue_keeps_unattempted_jobs_after_restart(self):
        due = '2027-07-12'
        task = self.add('tasks', {'name': 'Закрытая после постановки в очередь', 'due': due})
        self.add('tasks', {'name': 'Первая отправка', 'due': due})
        self.add('tasks', {'name': 'Следующая отправка', 'due': due})
        self.api.put('/api/reminders', headers=self.owner, json={'enabled': True}).raise_for_status()
        now = datetime.fromisoformat('2027-07-11T10:00+03:00')
        store = Store(self.database, demo=True, sample=False)
        self.assertEqual(len(collect(store, now, simulate=False)), 3)
        self.update('tasks', task, {'name': 'Закрытая задача', 'due': due, 'done': True}).raise_for_status()
        self.assertIn('Первая отправка', claim_delivery(store, now)[2])
        reopened = Store(self.database, demo=True, sample=False)
        self.assertIn('Следующая отправка', claim_delivery(reopened, now)[2])
        self.assertIsNone(claim_delivery(reopened, now))

    def test_telegram_login_requires_valid_signed_identity(self):
        bot_token = 'test-only-token'
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': bot_token, 'TELEGRAM_OWNER_ID': '321',
                                     'TELEGRAM_MINI_APP_URL': ''}):
            telegram_app = create_app(database=self.database.with_name('telegram.db'))
        with TestClient(telegram_app) as client:
            fields = {'user': json.dumps({'id': 321}), 'auth_date': str(int(time.time()))}
            check = '\n'.join(f'{key}={value}' for key, value in sorted(fields.items()))
            secret = hmac.digest(b'WebAppData', bot_token.encode(), 'sha256')
            fields['hash'] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
            good = client.post('/api/session/telegram', json={'initData': urlencode(fields)})
            self.assertEqual(good.status_code, 200, good.text)
            self.assertEqual(good.json()['role'], 'owner')
            fields['user'] = json.dumps({'id': 999})
            self.assertEqual(client.post('/api/session/telegram', json={'initData': urlencode(fields)}).status_code, 401)
            self.assertEqual(client.post('/api/session/demo', json={'user': 'owner'}).status_code, 404)

    def test_pages_api_accepts_only_configured_frontend_origin(self):
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': '', 'TELEGRAM_MINI_APP_URL': 'https://example.github.io/wedding/'}):
            app = create_app(database=self.database.with_name('pages.db'))
        with TestClient(app) as client:
            headers = {
                'Access-Control-Request-Method': 'PUT',
                'Access-Control-Request-Headers': 'authorization, content-type',
            }
            allowed = client.options('/api/floor', headers={**headers, 'Origin': 'https://example.github.io'})
            self.assertEqual(allowed.headers.get('Access-Control-Allow-Origin'), 'https://example.github.io')
            denied = client.options('/api/floor', headers={**headers, 'Origin': 'https://other.example'})
            self.assertEqual(denied.status_code, 400)
            self.assertNotIn('Access-Control-Allow-Origin', denied.headers)

    def test_polling_bot_opens_pages_and_subscribes_only_members(self):
        store = Store(self.database.with_name('bot.db'), demo=False, sample=False, owner_id='13579')
        url = 'https://example.github.io/wedding/'
        bot = TelegramBot(store, '12345:' + 'x' * 32, url)

        def message(user, text):
            return types.Message.de_json({
                'message_id': 1, 'date': int(time.time()), 'text': text,
                'chat': {'id': user, 'type': 'private'},
                'from': {'id': user, 'is_bot': False, 'first_name': 'Example'},
            })

        with store.connect(write=True) as connection:
            reply = bot.handle_message(connection, message(13579, '/start'))
            self.assertEqual(reply['reply_markup'].to_dict()['inline_keyboard'][0][0]['web_app']['url'], url)
            bot.handle_message(connection, message(24680, '/reminders'))
            bot.handle_message(connection, message(13579, '/reminders'))
            subscribers = connection.execute('SELECT user_id FROM subscriptions WHERE enabled = 1').fetchall()
            self.assertEqual([row['user_id'] for row in subscribers], ['13579'])

            event_id, invitation = 'a' * 22, 'b' * 32
            reply = bot.handle_message(connection, message(24680, f'/start edit_{event_id}_{invitation}'))
            button = reply['reply_markup'].to_dict()['inline_keyboard'][0][0]
            self.assertEqual(button['web_app']['url'], f'{url}?join={event_id}.{invitation}')

    def test_bot_forms_and_editor_links_use_the_same_durable_event(self):
        path = self.database.with_name('bot-forms.db')
        url = 'https://example.github.io/wedding/'
        bot = EventBot(Store(path, demo=False, sample=False), url)
        bot.username = 'example_bot'

        def message(user_id, message_id, *, text=None, form=None):
            data = {'message_id': message_id, 'date': int(time.time()),
                    'chat': {'id': user_id, 'type': 'private'},
                    'from': {'id': user_id, 'is_bot': False, 'first_name': 'Example'}}
            if form:
                data['web_app_data'] = {'button_text': 'Сохранить', 'data': json.dumps(form)}
            else:
                data['text'] = text
            return types.Message.de_json(data)

        creation = message(111, 1, form={'type': 'create_event', 'settings': {'name': 'Свадьба пары'}})
        self.assertIn('Свадьба пары', bot.message(creation)['text'])
        bot.message(creation)
        event, = bot.events.list('111')
        event_id = event['id']
        first = bot.invite('111', event_id, 'editor')['text'].split('?start=')[-1]
        second = bot.invite('111', event_id, 'editor')['text'].split('?start=')[-1]
        for user, invite in [(222, first), (333, second)]:
            self.assertIn('Свадьба пары', bot.message(message(user, 2, text='/start ' + invite))['text'])
            self.assertEqual(bot.events.list(str(user))[0]['role'], 'editor')
        update = {'type': 'add_record', 'eventId': event_id, 'collection': 'block',
                  'record': {'title': 'Церемония из формы', 'start': '17:00', 'duration': 30}}
        self.assertIn('нет доступа', bot.message(message(444, 3, form=update))['text'])
        self.assertIn('Церемония из формы', bot.message(message(333, 3, form=update))['text'])
        viewer = bot.invite('111', event_id, 'team')['text'].split('?start=')[-1]

        reopened = EventBot(Store(path, demo=False, sample=False), url)
        guest_view = reopened.message(message(444, 4, text='/start ' + viewer))
        self.assertIn('Церемония из формы', guest_view['text'])
        button = guest_view['reply_markup'].to_dict()['inline_keyboard'][0][0]['web_app']['url']
        payload = button.split('#program=')[-1]
        program = json.loads(zlib.decompress(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4))))
        self.assertEqual(program['blocks'][0]['title'], 'Церемония из формы')
        self.assertNotIn('banquetPrice', program['settings'])
        self.assertEqual(reopened.events.list('444'), [])

    def test_event_catalog_isolates_owners_and_accepts_multiple_editors(self):
        token = 'test-only-token'
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': token, 'TELEGRAM_MINI_APP_URL': 'https://example.github.io/wedding/'}):
            app = create_app(events=True, api_only=True, database=self.database.with_name('catalog.db'))
            with TestClient(app) as client:
                def sign_in(telegram_id):
                    fields = {'user': json.dumps({'id': telegram_id}), 'auth_date': str(int(time.time()))}
                    check = '\n'.join(f'{key}={value}' for key, value in sorted(fields.items()))
                    secret = hmac.digest(b'WebAppData', token.encode(), 'sha256')
                    fields['hash'] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
                    result = client.post('/api/events/login', json={'initData': urlencode(fields)})
                    return {'Authorization': 'Bearer ' + result.raise_for_status().json()['token']}

                owner, editor_one, editor_two, outsider = [sign_in(user_id) for user_id in (100, 300, 400, 500)]
                event_id = client.post('/api/events', headers=owner, json={'name': 'План пары'}).raise_for_status().json()['id']
                other_id = client.post('/api/events', headers=outsider, json={'name': 'Другой план'}).raise_for_status().json()['id']
                self.assertEqual([item['id'] for item in client.get('/api/events', headers=owner).json()], [event_id])
                self.assertEqual(client.post(f'/api/events/{other_id}/open', headers=owner, json={}).status_code, 403)
                self.assertEqual(client.post(f'/api/events/{event_id}/open', headers=outsider, json={}).status_code, 403)

                def open_event(headers, invite=None):
                    result = client.post(f'/api/events/{event_id}/open', headers=headers, json={'invite': invite})
                    return {'Authorization': 'Bearer ' + result.raise_for_status().json()['token']}

                owner_plan = open_event(owner)
                prefix = f'/events/{event_id}/api'
                first_link = client.post(prefix + '/links/editor', headers=owner_plan).raise_for_status().json()['token']
                second_link = client.post(prefix + '/links/editor', headers=owner_plan).raise_for_status().json()['token']
                reader = client.post(prefix + '/links/team', headers=owner_plan).raise_for_status().json()['token']
                editor_one_plan = open_event(editor_one, first_link)
                editor_two_plan = open_event(editor_two, second_link)
                self.assertEqual(client.post(f'/api/events/{event_id}/open', headers=outsider, json={'invite': first_link}).status_code, 403)
                self.assertEqual(client.post(f'/api/events/{event_id}/open', headers=outsider, json={'invite': reader}).status_code, 403)
                self.assertEqual(client.post(prefix + '/links/editor', headers=editor_two_plan).status_code, 403)
                self.assertEqual(client.get(f'/events/{other_id}/api/plan', headers=owner_plan).status_code, 401)
                self.assertEqual(client.get('/api/events', headers=editor_two).json()[0]['role'], 'editor')

                revision = client.get(prefix + '/plan', headers=editor_one_plan).raise_for_status().json()['revision']
                client.post(prefix + f'/items/blocks?revision={revision}', headers=editor_two_plan,
                            json={'title': 'Церемония', 'start': '18:00', 'duration': 40}).raise_for_status()
                program_path = f'/api/events/{event_id}/program'
                reader_headers = {'Authorization': 'Bearer ' + reader}
                view = client.get(program_path, headers=reader_headers).raise_for_status().json()
                self.assertEqual(view['blocks'][0]['title'], 'Церемония')
                self.assertNotIn('banquetPrice', view['settings'])
                self.assertEqual(client.get(prefix + '/plan', headers=reader_headers).status_code, 401)
                client.delete(prefix + '/editors/300', headers=owner_plan).raise_for_status()
                self.assertEqual(client.get(prefix + '/plan', headers=editor_one_plan).status_code, 401)
                self.assertEqual(client.get(prefix + '/plan', headers=editor_two_plan).status_code, 200)
                self.assertEqual(client.get('/api/events', headers=editor_one).json(), [])
                client.delete(prefix + '/links/team', headers=owner_plan).raise_for_status()
                self.assertEqual(client.get(program_path, headers=reader_headers).status_code, 403)


if __name__ == '__main__':
    unittest.main()
