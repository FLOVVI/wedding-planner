import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, HeartHandshake, Plus } from 'lucide-react';
import { loadTelegram, telegram } from './api';
import { ProgramPage } from './ProgramPage';
import { blockLabels, dateLabel, type EventSummary, type Program } from './types';

const titles = {
  create: 'Создать мероприятие', block: 'Добавить событие', guest: 'Добавить гостя', task: 'Добавить задачу',
};
export type TelegramFormKind = keyof typeof titles;

export function TelegramForm({ kind, eventId }: { kind: TelegramFormKind; eventId: string | null }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void loadTelegram().then(() => {
      const client = telegram();
      if (!client || client.platform === 'unknown') throw new Error('Откройте эту форму кнопкой в чате с ботом.');
      client.ready();
      client.expand();
      setReady(true);
    }).catch(reason => setError(reason.message));
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) { setError('Укажите название или имя.'); return; }
    const day = String(form.get('date') ?? '') || null;
    const data = kind === 'create' ? {
      type: 'create_event', settings: { name, date: day, venue: String(form.get('venue') ?? '') },
    } : {
      type: 'add_record', eventId, collection: kind,
      record: kind === 'block' ? {
        title: name, start: String(form.get('start')), duration: Number(form.get('duration')),
        kind: String(form.get('kind')),
      } : kind === 'task' ? { name, due: day } : { name },
    };
    try { telegram()?.sendData(JSON.stringify(data)); }
    catch { setError('Откройте форму кнопкой в чате с ботом ещё раз.'); }
  }

  return <main className="events-page">
    <h1>{titles[kind]}</h1>
    <form className="panel telegram-form" onSubmit={submit}>
      <label className="field"><span>{kind === 'guest' ? 'Имя гостя' : 'Название'}</span><input name="name" required maxLength={140} /></label>
      {(kind === 'create' || kind === 'task') && <label className="field"><span>{kind === 'task' ? 'Срок' : 'Дата'}</span><input name="date" type="date" required={kind === 'task'} /></label>}
      {kind === 'create' && <label className="field"><span>Площадка</span><input name="venue" maxLength={140} /></label>}
      {kind === 'block' && <>
        <label className="field"><span>Начало</span><input name="start" type="time" required /></label>
        <label className="field"><span>Длительность, мин</span><input name="duration" type="number" min={1} max={720} defaultValue={30} required /></label>
        <label className="field"><span>Тип</span><select name="kind" defaultValue="other">
          {Object.entries(blockLabels).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
        </select></label>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn primary" disabled={!ready}>Сохранить в боте</button>
    </form>
  </main>;
}

async function readSnapshot(encoded: string): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{1,2600}$/.test(encoded)) throw new Error();
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let json = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    json += decoder.decode(chunk.value, { stream: true });
    if (json.length > 120_000) {
      await reader.cancel();
      throw new Error();
    }
  }
  return JSON.parse(json + decoder.decode());
}

async function readProgram(encoded: string) {
  const data = await readSnapshot(encoded) as Program;
  if (!Array.isArray(data.blocks) || typeof data.settings?.name !== 'string') throw new Error();
  // The link contains public program data. Only HTTP(S) track links may be opened.
  data.blocks = data.blocks.filter(block => Object.hasOwn(blockLabels, block.kind) &&
    typeof block.start === 'string' && /^\d{2}:\d{2}/.test(block.start) && Array.isArray(block.tracks));
  for (const block of data.blocks) block.tracks = block.tracks.filter(link => /^https?:\/\//i.test(link));
  if (data.settings.date && !Number.isFinite(Date.parse(data.settings.date))) data.settings.date = null;
  return data;
}

export function TelegramProgram({ encoded }: { encoded: string }) {
  const [data, setData] = useState<Program>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void readProgram(encoded).then(setData).catch(() => setFailed(true));
  }, [encoded]);
  return <main className="team-shell">
    <div className="topbar"><PlannerLink /><span className="read-only">Программа · просмотр</span></div>
    {data ? <div className="content"><ProgramPage data={data} open={() => undefined} live={false} /></div> :
      <div className="content"><p role="status">{failed ? 'Откройте программу из бота заново.' : 'Открываем программу…'}</p></div>}
  </main>;
}

function PlannerLink() {
  return <a className="btn secondary" href={location.pathname}><ArrowLeft size={16} /> Открыть планировщик</a>;
}

export function TelegramCatalog({ encoded }: { encoded: string }) {
  const [data, setData] = useState<{ bot: string; events: EventSummary[] }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void readSnapshot(encoded).then(value => {
      const snapshot = value as { bot: string; events: EventSummary[] };
      if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(snapshot.bot) || !Array.isArray(snapshot.events)) throw new Error();
      setData({ ...snapshot, events: snapshot.events.filter(event => typeof event?.name === 'string' && /^[A-Za-z0-9_-]{22}$/.test(event.id)) });
    }).catch(() => setFailed(true));
  }, [encoded]);
  if (!data) return <main className="entry"><p>{failed ? 'Откройте мероприятия из бота заново.' : 'Открываем мероприятия…'}</p><PlannerLink /></main>;
  const bot = 'https://t.me/' + data.bot;
  return <main className="events-page">
    <header className="events-brand"><span className="brand-mark"><HeartHandshake size={22} /></span><strong>Вместе</strong><PlannerLink /></header>
    <div className="page-heading"><h1>Мои мероприятия</h1>
      <a className="btn primary" href={bot + '?start=new'}><Plus size={16} /> Создать мероприятие</a>
    </div>
    <section className="panel">
      {!data.events.length && <p className="empty">Создайте мероприятие, чтобы пригласить редакторов и собрать программу.</p>}
      {data.events.map(event => <a key={event.id} className="overview-record event-record" href={bot + '?start=open_' + event.id}>
        <span className="overview-record-icon"><CalendarDays size={18} /></span>
        <span><strong>{event.name}</strong><small>{event.date && Number.isFinite(Date.parse(event.date)) ? dateLabel(event.date, true) + ' · ' : ''}{event.role === 'owner' ? 'Владелец' : 'Редактор'}</small></span>
        <ArrowRight size={16} />
      </a>)}
    </section>
  </main>;
}
