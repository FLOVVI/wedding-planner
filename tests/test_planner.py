import hashlib
import hmac
import io
import json
import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import urlencode

from fastapi.testclient import TestClient
from PIL import Image

from backend.main import create_app
from backend.notifications import claim_delivery, collect
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


if __name__ == '__main__':
    unittest.main()
