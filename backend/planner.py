from fastapi import HTTPException

TABLE_KINDS = {'round', 'rectangle'}


def lookup(items, item_id):
    return next((item for item in items if item['id'] == item_id), None)


def valid_source(plan, source):
    if source == 'banquet':
        return True
    kind, _, item_id = source.partition(':')
    collection = {'artist': 'artists', 'expense': 'expenses'}.get(kind)
    return bool(collection and lookup(plan[collection], item_id))


def apply_record(plan, collection, item):
    item_id = item['id']
    existing = lookup(plan[collection], item_id)
    if collection == 'guests':
        if item['status'] == 'declined':
            item['tableId'] = None
        if item['tableId']:
            table = lookup(plan['objects'], item['tableId'])
            if not table or table['kind'] not in TABLE_KINDS:
                raise HTTPException(422, 'Выберите существующий стол')
            occupied = sum(guest['tableId'] == table['id'] and guest['id'] != item_id for guest in plan['guests'])
            if occupied >= table['capacity']:
                raise HTTPException(409, 'За этим столом больше нет мест')
    elif collection == 'objects':
        if item['kind'] in TABLE_KINDS and item['capacity'] < 1:
            raise HTTPException(422, 'За столом должно быть хотя бы одно место')
        if item['kind'] not in TABLE_KINDS:
            item['capacity'] = 0
        occupied = sum(guest['tableId'] == item_id for guest in plan['guests'])
        if item['capacity'] < occupied:
            raise HTTPException(409, 'Сначала пересадите гостей, для которых не хватит мест')
    elif collection == 'blocks' and item['artistId'] and not lookup(plan['artists'], item['artistId']):
        raise HTTPException(422, 'Выберите существующего артиста')
    elif collection == 'payments' and not valid_source(plan, item['source']):
        raise HTTPException(422, 'Выберите существующую статью сметы')

    if existing:
        existing.update(item)
    else:
        plan[collection].append(item)


def remove_record(plan, collection, item):
    item_id = item['id']
    if collection == 'objects':
        for guest in plan['guests']:
            if guest['tableId'] == item_id:
                guest['tableId'] = None
    elif collection in ('artists', 'expenses'):
        source = f"{'artist' if collection == 'artists' else 'expense'}:{item_id}"
        if any(payment['source'] == source for payment in plan['payments']):
            raise HTTPException(409, 'Сначала измените или удалите платежи по этой статье')
        if collection == 'artists':
            for block in plan['blocks']:
                if block['artistId'] == item_id:
                    block['artistId'] = None
    plan[collection].remove(item)


def calculate_budget(plan):
    confirmed = sum(guest['status'] == 'confirmed' for guest in plan['guests'])
    expected = sum(guest['status'] != 'declined' for guest in plan['guests'])
    price = plan['settings']['banquetPrice']
    fixed = sum(artist['fee'] for artist in plan['artists']) + sum(item['amount'] for item in plan['expenses'])
    paid = sum(payment['amount'] for payment in plan['payments'] if payment['paid'])
    return dict(confirmed=confirmed, expected=expected, confirmedBanquet=confirmed * price,
                expectedBanquet=expected * price, total=fixed + expected * price,
                paid=paid, remaining=fixed + expected * price - paid)


def start_minute(block):
    hour, minute = map(int, block['start'][:5].split(':'))
    return hour * 60 + minute + (1440 if block.get('nextDay') else 0)


def program_view(plan):
    sorted_blocks = sorted(plan['blocks'], key=start_minute)
    conflicts = set()
    for index, block in enumerate(sorted_blocks):
        end = start_minute(block) + block['duration']
        for following in sorted_blocks[index + 1:]:
            if start_minute(following) >= end:
                break
            conflicts.update((block['id'], following['id']))

    def public_block(block):
        artist = lookup(plan['artists'], block['artistId']) or {}
        fields = ('id', 'title', 'kind', 'start', 'duration', 'responsible', 'tracks', 'notes')
        return {**{key: block[key] for key in fields}, 'nextDay': block.get('nextDay', False),
                'artistName': artist.get('name', ''), 'artistSound': artist.get('sound', ''),
                'conflict': block['id'] in conflicts}

    settings = plan['settings']
    return {'settings': {key: settings[key] for key in ('name', 'date', 'venue', 'timezone')},
            'blocks': [public_block(block) for block in sorted_blocks]}
