import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CalendarDays, HeartHandshake } from 'lucide-react';
import { api, json } from './api';
import { AddButton, Empty, FormDialog } from './components';
import { settingsEditor } from './forms';
import { dateLabel, type EventSummary } from './types';

const newEvent = settingsEditor({
  name: '', date: null, venue: '', timezone: 'Europe/Moscow', banquetPrice: 0,
});

export function EventList({ token, offline, select, report }: {
  token: string; offline: boolean; select: (eventId: string) => Promise<void>; report: (reason: string) => void;
}) {
  const [events, setEvents] = useState<EventSummary[]>();
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setError('');
    try {
      setEvents(await api<EventSummary[]>('/events', token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить мероприятия');
    }
  }, [token]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function open(id: string) {
    setOpening(true);
    try { await select(id); }
    catch (reason) {
      report(reason instanceof Error ? reason.message : 'Не удалось открыть мероприятие');
      await refresh();
    } finally { setOpening(false); }
  }

  return <main className="events-page">
    <header className="events-brand"><span className="brand-mark"><HeartHandshake size={22} /></span><strong>Вместе</strong></header>
    <div className="page-heading">
      <div><h1>Мои мероприятия</h1>{offline && <p>Планы сохраняются в этом браузере.</p>}</div>
      <AddButton onClick={() => setCreating(true)}>Создать мероприятие</AddButton>
    </div>
    <section className="panel">
      {error && <div className="events-error"><p role="alert">{error}</p>
        <button className="btn secondary" onClick={() => void refresh()}>Повторить</button>
      </div>}
      {!events && !error && <Empty>Загружаем мероприятия…</Empty>}
      {events && !events.length && <Empty>Создайте мероприятие, чтобы собрать программу, список гостей и смету.</Empty>}
      {events?.map(event => <button key={event.id} className="overview-record event-record" disabled={opening} onClick={() => void open(event.id)}>
        <span className="overview-record-icon"><CalendarDays size={18} /></span>
        <span><strong>{event.name}</strong><small>{event.date ? dateLabel(event.date, true) + ' · ' : ''}{event.role === 'owner' ? 'Владелец' : 'Редактор'}</small></span>
        <ArrowRight size={16} />
      </button>)}
    </section>
    {creating && <FormDialog editor={{ ...newEvent, title: 'Создать мероприятие' }} close={() => setCreating(false)} save={async data => {
      const event = await api<{ id: string }>('/events', token, json('POST', data));
      await open(event.id);
    }} />}
  </main>;
}
