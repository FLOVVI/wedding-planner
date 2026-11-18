import type { Editor, FieldSpec } from './components';
import {
  type Artist, type Block, type Expense, type FloorObject, type Guest, type ObjectKind, type Payment,
  type Plan, type Settings, type Task, blockLabels, contractorLabels, isTable, objectLabels, statusLabels,
} from './types';

const name: FieldSpec = { key: 'name', label: 'Название', required: true };
const amount: FieldSpec = { key: 'amount', label: 'Сумма, ₽', type: 'number', min: 0, max: 1_000_000_000, required: true };
const due: FieldSpec = { key: 'due', label: 'Срок', type: 'date', emptyNull: true, half: true };

export function eventEditor(plan: Plan, current?: Block): Editor {
  return {
    title: current ? 'Редактировать событие' : 'Новое событие', collection: 'blocks', id: current?.id,
    initial: current ? { ...current, start: current.start.slice(0, 5) } : {
      title: '', kind: 'other', start: '16:00', nextDay: false, duration: 30,
      responsible: '', tracks: [], artistId: null, notes: '',
    },
    fields: [
      { ...name, key: 'title' },
      { key: 'kind', label: 'Тип', type: 'select', options: Object.entries(blockLabels) },
      { key: 'start', label: 'Начало', type: 'time', half: true, required: true },
      { key: 'duration', label: 'Длительность, мин', type: 'number', half: true, min: 1, max: 720, required: true },
      { key: 'nextDay', label: 'После полуночи, на следующий день', type: 'check' },
      { key: 'artistId', label: 'Подрядчик', type: 'select', emptyNull: true,
        options: [['', 'Без подрядчика'], ...plan.artists.map<[string, string]>(artist => [artist.id, artist.name])] },
      { key: 'responsible', label: 'Ответственный' },
      { key: 'tracks', label: 'Ссылки на треки', type: 'links', hint: 'Одна ссылка на строку.' },
      { key: 'notes', label: 'Заметки для команды', type: 'textarea' },
    ],
  };
}

export function artistEditor(current?: Artist): Editor {
  return {
    title: current ? 'Карточка подрядчика' : 'Новый подрядчик', collection: 'artists', id: current?.id,
    initial: current ? { ...current, category: current.category ?? 'music' } :
      { name: '', category: 'other', role: '', contact: '', fee: 0, sound: '' },
    fields: [
      { ...name, label: 'Имя или название' },
      { key: 'category', label: 'Категория', type: 'select', options: Object.entries(contractorLabels) },
      { key: 'role', label: 'Услуга или роль' },
      { key: 'contact', label: 'Контакт' },
      { ...amount, key: 'fee', label: 'Стоимость, ₽' },
      { key: 'sound', label: 'Технические детали', type: 'textarea',
        hint: 'Например, требования к звуку или порядок доступа на площадку. Видны команде в связанных событиях.' },
    ],
  };
}

export function objectEditor(plan: Plan, current?: FloorObject, kind: ObjectKind = 'round'): Editor {
  const table = kind === 'round' || kind === 'rectangle';
  return {
    title: current ? 'Настроить объект' : objectLabels[kind], collection: 'objects', id: current?.id,
    initial: { ...(current ?? {
      name: table ? `Стол ${plan.objects.filter(isTable).length + 1}` : objectLabels[kind], kind,
      capacity: table ? 8 : 0, x: .5, y: .5, width: kind === 'round' ? .15 : .22,
      height: kind === 'entrance' ? .08 : .18, rotation: 0,
    }) },
    fields: [
      name,
      { key: 'kind', label: 'Тип', type: 'select', options: Object.entries(objectLabels) },
      { key: 'capacity', label: 'Мест за столом', type: 'number', min: 1, max: 200, required: true,
        show: data => data.kind === 'round' || data.kind === 'rectangle' },
      { key: 'width', label: 'Ширина (доля схемы)', type: 'number', min: .025, max: .7, step: 'any', half: true },
      { key: 'height', label: 'Высота (доля схемы)', type: 'number', min: .025, max: .7, step: 'any', half: true },
      { key: 'rotation', label: 'Поворот', type: 'range', min: -180, max: 180, step: 1 },
    ],
  };
}

export function guestEditor(plan: Plan, current?: Guest): Editor {
  const options = plan.objects.filter(isTable).map<[string, string]>(table => {
    const occupied = plan.guests.filter(guest => guest.tableId === table.id && guest.id !== current?.id).length;
    return [table.id, `${table.name} · свободно ${table.capacity - occupied}`];
  });
  return {
    title: current ? 'Карточка гостя' : 'Новый гость', collection: 'guests', id: current?.id,
    initial: { ...(current ?? { name: '', family: '', status: 'waiting', tableId: null }) },
    fields: [
      { ...name, label: 'Имя гостя' }, { key: 'family', label: 'Семья или группа' },
      { key: 'status', label: 'Ответ', type: 'select', options: Object.entries(statusLabels) },
      { key: 'tableId', label: 'Стол', type: 'select', emptyNull: true,
        options: [['', 'Без места'], ...options], show: draft => draft.status !== 'declined' },
    ],
  };
}

export const expenseEditor = (current?: Expense): Editor => ({
  title: current ? 'Статья сметы' : 'Новый расход', collection: 'expenses', id: current?.id,
  initial: { ...(current ?? { name: '', amount: 0 }) }, fields: [name, amount],
});

export function paymentEditor(plan: Plan, current?: Payment, source = 'banquet'): Editor {
  return {
    title: current ? 'Детали платежа' : 'Новый платёж', collection: 'payments', id: current?.id,
    initial: { ...(current ?? { name: '', source, amount: 0, due: null, paid: false }) },
    fields: [
      name,
      { key: 'source', label: 'Статья сметы', type: 'select', options: [
        ['banquet', 'Банкет'],
        ...plan.artists.map<[string, string]>(artist => [`artist:${artist.id}`, artist.name]),
        ...plan.expenses.map<[string, string]>(item => [`expense:${item.id}`, item.name]),
      ] },
      { ...amount, half: true }, due,
      { key: 'paid', label: 'Оплачен', type: 'check' },
    ],
  };
}

export const taskEditor = (current?: Task): Editor => ({
  title: current ? 'Редактировать задачу' : 'Новая задача', collection: 'tasks', id: current?.id,
  initial: { ...(current ?? { name: '', due: null, done: false }) },
  fields: [name, { ...due, required: true, half: false }, { key: 'done', label: 'Выполнена', type: 'check' }],
});

export const settingsEditor = (settings: Settings): Editor => ({
  title: 'Настройки свадьбы', initial: { ...settings }, fields: [
    { ...name, label: 'Название свадьбы' },
    { key: 'date', label: 'Дата', type: 'date', emptyNull: true },
    { key: 'venue', label: 'Площадка' },
    { key: 'timezone', label: 'Часовой пояс', required: true, hint: 'Например, Europe/Moscow.' },
    { ...amount, key: 'banquetPrice', label: 'Банкет на человека, ₽' },
  ],
});
