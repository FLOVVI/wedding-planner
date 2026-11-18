import hashlib
import hmac
import json
import re
import secrets
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

from fastapi import HTTPException


@dataclass(frozen=True)
class Identity:
    user_id: str
    role: str


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def verify_telegram(init_data: str, bot_token: str, now: int | None = None):
    try:
        items = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True, max_num_fields=32,
                          encoding='utf-8', errors='strict')
        fields = dict(items)
        provided = fields.pop('hash')
        if len(items) != len(fields) + 1 or not re.fullmatch(r'[a-f0-9]{64}', provided):
            raise ValueError()
        check = '\n'.join(f'{key}={value}' for key, value in sorted(fields.items()))
        secret = hmac.digest(b'WebAppData', bot_token.encode(), 'sha256')
        expected = hmac.new(secret, check.encode(), 'sha256').hexdigest()
        current = int(time.time()) if now is None else now
        if not hmac.compare_digest(expected, provided) or not -30 <= current - int(fields['auth_date']) <= 300:
            raise ValueError()
        user_id = json.loads(fields['user'])['id']
        if type(user_id) is not int or user_id <= 0:
            raise ValueError()
        return str(user_id), fields.get('start_param')
    except (KeyError, TypeError, ValueError):
        raise HTTPException(401, 'Откройте приложение заново из Telegram') from None


def live_link(connection, link_digest, now):
    return connection.execute(
        'SELECT kind FROM links WHERE digest = ? AND revoked = 0 AND (expires IS NULL OR expires > ?)',
        (link_digest, now),
    ).fetchone()


def log_in(connection, user_id: str, invite: str | None):
    now = int(time.time())
    member = connection.execute('SELECT role FROM members WHERE user_id = ?', (user_id,)).fetchone()
    link_digest = None
    if member:
        role = member['role']
    elif invite and re.fullmatch(r'[A-Za-z0-9_-]{20,64}', invite):
        invite_digest = digest(invite)
        link = live_link(connection, invite_digest, now)
        if not link:
            raise HTTPException(403, 'Ссылка истекла или была отозвана')
        if link['kind'] in ('partner', 'editor'):
            if link['kind'] == 'partner' and connection.execute("SELECT 1 FROM members WHERE role = 'editor'").fetchone():
                raise HTTPException(409, 'Второй участник уже присоединился')
            role = 'editor'
            connection.execute('INSERT INTO members VALUES (?, ?)', (user_id, role))
            connection.execute('UPDATE links SET revoked = 1 WHERE digest = ?', (invite_digest,))
        else:
            role = 'team'
            link_digest = invite_digest
    else:
        raise HTTPException(403, 'Попросите у организаторов ссылку на приложение')

    token = secrets.token_urlsafe(32)
    connection.execute('DELETE FROM sessions WHERE expires <= ?', (now,))
    connection.execute('INSERT INTO sessions VALUES (?, ?, ?, ?)', (digest(token), user_id, link_digest, now + 16 * 3600))
    return {'token': token, 'role': role}


def authenticate(connection, header: str | None) -> Identity:
    if not header or not re.fullmatch(r'Bearer [A-Za-z0-9_-]{43}', header):
        raise HTTPException(401, 'Войдите, чтобы открыть план')
    now = int(time.time())
    session = connection.execute(
        'SELECT user_id, team_link FROM sessions WHERE digest = ? AND expires > ?', (digest(header[7:]), now),
    ).fetchone()
    if session:
        if session['team_link']:
            if live_link(connection, session['team_link'], now):
                return Identity(session['user_id'], 'team')
        else:
            member = connection.execute('SELECT role FROM members WHERE user_id = ?', (session['user_id'],)).fetchone()
            if member:
                return Identity(session['user_id'], member['role'])
    raise HTTPException(401, 'Сессия закончилась или ссылка отозвана')


def issue_link(connection, kind):
    now = int(time.time())
    if kind == 'partner' and connection.execute("SELECT 1 FROM members WHERE role = 'editor'").fetchone():
        raise HTTPException(409, 'Второй участник уже присоединился')
    token = secrets.token_urlsafe(24)
    if kind != 'editor':
        connection.execute('UPDATE links SET revoked = 1 WHERE kind = ?', (kind,))
    connection.execute('INSERT INTO links (digest, kind, expires) VALUES (?, ?, ?)',
                       (digest(token), kind, now + 86400 if kind in ('partner', 'editor') else None))
    return token


def revoke_editor(connection, user_id):
    result = connection.execute("DELETE FROM members WHERE user_id = ? AND role = 'editor'", (user_id,))
    if not result.rowcount:
        raise HTTPException(404, 'Редактор не найден')
    connection.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
    connection.execute('DELETE FROM subscriptions WHERE user_id = ?', (user_id,))
