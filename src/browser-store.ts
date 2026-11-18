import { ApiError } from './api-error';
import {
  blockLabels, isTable, objectLabels, statusLabels,
  type Artist, type Block, type Budget, type Collection, type FloorObject, type Guest,
  type Payment, type Plan, type ProgramBlock, type Settings, type Task,
} from './types';

type SavedPlan = Omit<Plan, 'budget' | 'program'>;
type State = { plan: SavedPlan; image?: Blob };
type Catalog = { events: Record<string, State> };
type RecordItem = SavedPlan[Collection][number];
const collections: ReadonlySet<string> = new Set<Collection>([
  'artists', 'blocks', 'guests', 'objects', 'expenses', 'payments', 'tasks',
]);
const imageLimit = 6 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;

function emptyState(): State {
  return {
    plan: {
      revision: 0,
      settings: { name: 'Наша свадьба', date: null, venue: '', timezone: 'Europe/Moscow', banquetPrice: 0 },
      floor: null, artists: [], blocks: [], guests: [], objects: [], expenses: [], payments: [], tasks: [],
    },
  };
}

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vmeste-wedding-planner', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('wedding');
    request.onsuccess = () => {
      const connection = request.result;
      connection.onversionchange = () => {
        connection.close();
        database = undefined;
      };
      resolve(connection);
    };
    request.onerror = () => reject(new ApiError(503, 'Браузер не смог открыть хранилище плана'));
  }).catch(reason => {
    database = undefined;
    throw reason;
  });
  return database;
}

async function withStore<T>(mode: IDBTransactionMode, action: (catalog: Catalog) => T) {
  const connection = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = connection.transaction('wedding', mode);
    const store = transaction.objectStore('wedding');
    const request = store.get('catalog');
    let value: T;
    request.onsuccess = () => {
      const catalog = (request.result ?? { events: {} }) as Catalog;
      try {
        value = action(catalog);
        if (mode === 'readwrite') store.put(catalog, 'catalog');
      } catch (reason) {
        reject(reason);
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = transaction.onabort = () => reject(new ApiError(503, 'Браузер не смог сохранить данные плана'));
  });
}

function minutes(block: Block) {
  const [hour, minute] = block.start.split(':').map(Number);
  return hour * 60 + minute + (block.nextDay ? 1440 : 0);
}

function program(plan: SavedPlan): ProgramBlock[] {
  const blocks = [...plan.blocks].sort((a, b) => minutes(a) - minutes(b));
  const conflicts = new Set<string>();
  blocks.forEach((block, index) => {
    const end = minutes(block) + block.duration;
    for (let next = index + 1; next < blocks.length && minutes(blocks[next]) < end; next += 1) {
      conflicts.add(block.id);
      conflicts.add(blocks[next].id);
    }
  });
  return blocks.map(({ artistId, ...block }) => {
    const contractor = plan.artists.find(artist => artist.id === artistId);
    return { ...block, artistName: contractor?.name ?? '', artistSound: contractor?.sound ?? '', conflict: conflicts.has(block.id) };
  });
}

function budget(plan: SavedPlan): Budget {
  const confirmed = plan.guests.filter(guest => guest.status === 'confirmed').length;
  const expected = plan.guests.filter(guest => guest.status !== 'declined').length;
  const confirmedBanquet = confirmed * plan.settings.banquetPrice;
  const expectedBanquet = expected * plan.settings.banquetPrice;
  const total = expectedBanquet + plan.artists.reduce((sum, artist) => sum + artist.fee, 0) +
    plan.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const paid = plan.payments.reduce((sum, payment) => sum + (payment.paid ? payment.amount : 0), 0);
  return { confirmed, expected, confirmedBanquet, expectedBanquet, total, paid, remaining: total - paid };
}

function invalid(message = 'Проверьте обязательные поля, даты и числовые значения'): never {
  throw new ApiError(422, message);
}

function amount(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) invalid();
}

function dateValue(value: string | null) {
  if (value === null) return;
  const date = new Date(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid();
}

function requiredName(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 140) invalid('Введите название или имя');
  return value.trim();
}

function saveSettings(plan: SavedPlan, settings: Settings) {
  settings.name = requiredName(settings.name);
  amount(settings.banquetPrice);
  dateValue(settings.date);
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: settings.timezone });
  } catch {
    invalid('Укажите часовой пояс, например Europe/Moscow');
  }
  plan.settings = settings;
}

function checkGuest(plan: SavedPlan, guest: Guest) {
  if (!Object.hasOwn(statusLabels, guest.status)) invalid();
  if (guest.status === 'declined') guest.tableId = null;
  if (!guest.tableId) return;
  const table = plan.objects.find(item => item.id === guest.tableId);
  if (!table || !isTable(table)) invalid('Выберите существующий стол');
  const occupied = plan.guests.filter(item => item.tableId === table.id && item.id !== guest.id).length;
  if (occupied >= table.capacity) throw new ApiError(409, 'За этим столом больше нет мест');
}

function checkObject(plan: SavedPlan, object: FloorObject) {
  if (!Object.hasOwn(objectLabels, object.kind)) invalid();
  const limits = [[object.x, 0, 1], [object.y, 0, 1], [object.width, .025, .7], [object.height, .025, .7], [object.rotation, -180, 180]];
  if (limits.some(([value, min, max]) => !Number.isFinite(value) || value < min || value > max)) invalid();
  if (!isTable(object)) object.capacity = 0;
  else if (!Number.isInteger(object.capacity) || object.capacity < 1 || object.capacity > 200) invalid('Укажите вместимость стола от 1 до 200');
  if (plan.guests.filter(guest => guest.tableId === object.id).length > object.capacity) {
    throw new ApiError(409, 'Сначала пересадите гостей, для которых не хватит мест');
  }
}

function checkBlock(plan: SavedPlan, block: Block) {
  if (!Object.hasOwn(blockLabels, block.kind) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(block.start) ||
      !Number.isInteger(block.duration) || block.duration < 1 || block.duration > 720) invalid();
  if (block.artistId && !plan.artists.some(artist => artist.id === block.artistId)) invalid('Выберите существующего подрядчика');
  if (!Array.isArray(block.tracks) || block.tracks.length > 15) invalid('Можно указать до 15 треков');
  block.tracks = block.tracks.map(value => {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch { /* The URL is invalid. */ }
    return invalid('Укажите ссылку на трек, начинающуюся с https:// или http://');
  });
}

function checkPayment(plan: SavedPlan, payment: Payment) {
  amount(payment.amount);
  dateValue(payment.due);
  const sources = [
    'banquet',
    ...plan.artists.map(record => 'artist:' + record.id),
    ...plan.expenses.map(record => 'expense:' + record.id),
  ];
  if (!sources.includes(payment.source)) invalid('Выберите существующую статью сметы');
}

function saveItem(plan: SavedPlan, collection: Collection, item: RecordItem, id?: string) {
  const records: RecordItem[] = plan[collection];
  const index = id ? records.findIndex(record => record.id === id) : -1;
  if (id && index < 0) throw new ApiError(404, 'Запись уже удалена');
  item.id = id ?? crypto.randomUUID();
  if (collection === 'blocks') {
    const block = item as Block;
    block.title = requiredName(block.title);
    checkBlock(plan, block);
  } else if ('name' in item) {
    item.name = requiredName(item.name);
    if (collection === 'guests') checkGuest(plan, item as Guest);
    if (collection === 'objects') checkObject(plan, item as FloorObject);
    if (collection === 'payments') checkPayment(plan, item as Payment);
    if (collection === 'expenses' && 'amount' in item) amount(item.amount);
    if (collection === 'artists') amount((item as Artist).fee);
    if (collection === 'tasks') dateValue((item as Task).due);
  }
  if (index < 0) records.push(item);
  else records[index] = item;
  return item.id;
}

function removeItem(plan: SavedPlan, collection: Collection, id: string) {
  const records: RecordItem[] = plan[collection];
  const index = records.findIndex(record => record.id === id);
  if (index < 0) throw new ApiError(404, 'Запись уже удалена');
  if (collection === 'objects') {
    for (const guest of plan.guests) if (guest.tableId === id) guest.tableId = null;
  }
  if (collection === 'artists' || collection === 'expenses') {
    const source = (collection === 'artists' ? 'artist:' : 'expense:') + id;
    if (plan.payments.some(payment => payment.source === source)) {
      throw new ApiError(409, 'Сначала измените или удалите платежи по этой статье');
    }
    if (collection === 'artists') {
      for (const block of plan.blocks) if (block.artistId === id) block.artistId = null;
    }
  }
  records.splice(index, 1);
}

async function prepareFloor(input: Blob) {
  if (input.size > imageLimit) throw new ApiError(413, 'Размер файла превышает 6 МБ');
  const bytes = new Uint8Array(await input.slice(0, 8).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) invalid('Выберите исправный файл PNG или JPEG');
  const mediaType = png ? 'image/png' : 'image/jpeg';
  const url = URL.createObjectURL(input.slice(0, input.size, mediaType));
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
  } catch {
    invalid('Выберите исправный файл PNG или JPEG');
  } finally {
    URL.revokeObjectURL(url);
  }
  if (image.naturalWidth * image.naturalHeight > 20_000_000) invalid('Размер схемы превышает 20 мегапикселей');
  const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) invalid('Браузер не смог обработать схему площадки');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mediaType, .9));
  if (!blob || blob.size > imageLimit) invalid('Схема после обработки превышает 6 МБ');
  return { blob, ratio: canvas.width / canvas.height };
}

function eventState(catalog: Catalog, eventId?: string) {
  if (!eventId || !Object.hasOwn(catalog.events, eventId)) throw new ApiError(404, 'Мероприятие не найдено');
  return catalog.events[eventId];
}

export function browserFloor(eventId?: string) {
  return withStore('readonly', catalog => {
    const { image } = eventState(catalog, eventId);
    if (!image) throw new ApiError(404, 'Не удалось открыть схему');
    return image;
  });
}

function readBody<T>(init?: RequestInit): T {
  if (typeof init?.body !== 'string') invalid();
  try { return JSON.parse(init.body) as T; }
  catch { return invalid(); }
}

export async function browserApi<T>(path: string, init?: RequestInit, eventId?: string): Promise<T> {
  const url = new URL(path, location.origin);
  const method = init?.method ?? 'GET';
  if (url.pathname === '/config' && method === 'GET') {
    return { demo: false, offline: true, events: true, botUsername: '' } as T;
  }
  if (url.pathname === '/events' && method === 'GET') {
    return withStore('readonly', ({ events }) => Object.entries(events).map(([id, { plan }]) => ({
      id, name: plan.settings.name, date: plan.settings.date, role: 'owner',
    })).reverse() as T);
  }
  if (url.pathname === '/events' && method === 'POST') {
    return withStore('readwrite', ({ events }) => {
      const id = crypto.randomUUID();
      const state = emptyState();
      saveSettings(state.plan, readBody<Settings>(init));
      events[id] = state;
      return { id } as T;
    });
  }
  const opening = /^\/events\/([a-zA-Z0-9-]+)\/open$/.exec(url.pathname);
  if (opening && method === 'POST') {
    return withStore('readonly', catalog => {
      eventState(catalog, opening[1]);
      return { token: '', role: 'owner' } as T;
    });
  }
  if (url.pathname === '/plan' && method === 'GET') {
    return withStore('readonly', catalog => {
      const { plan } = eventState(catalog, eventId);
      return { ...plan, program: program(plan), budget: budget(plan) } as T;
    });
  }
  const floor = url.pathname === '/floor';
  const item = /^\/items\/([a-z]+)(?:\/([a-zA-Z0-9-]+))?$/.exec(url.pathname);
  const collection = item && collections.has(item[1]) ? item[1] as Collection : undefined;
  const itemId = item?.[2];
  const revision = url.searchParams.get('revision');
  if (!revision || (!floor && !collection && url.pathname !== '/settings')) throw new ApiError(404, 'Действие недоступно');
  const attachment = floor && method === 'PUT' && init?.body instanceof Blob ? await prepareFloor(init.body) : undefined;

  return withStore('readwrite', catalog => {
    const state = eventState(catalog, eventId);
    const { plan } = state;
    if (plan.revision !== Number(revision)) throw new ApiError(409, 'План уже изменился. Закройте и откройте карточку снова.');
    let id: string | undefined;
    if (url.pathname === '/settings' && method === 'PUT') {
      saveSettings(plan, readBody<Settings>(init));
    } else if (floor && method === 'DELETE') {
      plan.floor = null;
      delete state.image;
    } else if (floor && attachment) {
      plan.floor = { name: url.searchParams.get('filename') ?? 'Схема', ratio: attachment.ratio, version: plan.revision + 1 };
      state.image = attachment.blob;
    } else if (collection && itemId && method === 'DELETE') {
      removeItem(plan, collection, itemId);
    } else if (collection && ((itemId && method === 'PUT') || (!itemId && method === 'POST'))) {
      id = saveItem(plan, collection, readBody<RecordItem>(init), itemId);
    } else {
      throw new ApiError(404, 'Действие недоступно');
    }
    plan.revision += 1;
    return { id, revision: plan.revision } as T;
  });
}
