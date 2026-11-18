import { useEffect, useState } from 'react';
import { Armchair, Bell, Check, CircleCheck, Clock, FlaskConical, ListTodo, Receipt, Search, UsersRound, Wallet } from 'lucide-react';
import { api, json } from './api';
import { AddButton, EditButton, Empty, type ChangeRecord, type OpenEditor } from './components';
import { expenseEditor, guestEditor, paymentEditor, settingsEditor, taskEditor } from './forms';
import { dateLabel, money, statusLabels, type Config, type Plan, type Reminders, type Status } from './types';

export function GuestsPage({ plan, open, change }: { plan: Plan; open: OpenEditor; change: ChangeRecord }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const guests = plan.guests.filter(guest => (filter === 'all' || guest.status === filter) &&
    `${guest.name} ${guest.family}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
  const groups = new Map<string, typeof guests>();
  for (const guest of guests) {
    const group = groups.get(guest.family) ?? [];
    group.push(guest);
    groups.set(guest.family, group);
  }
  return <>
    <header className="page-heading"><div><h1>Гости</h1><p>Семьи, ответы и места за столами.</p></div>
      <AddButton onClick={() => open(guestEditor(plan))}>Добавить гостя</AddButton>
    </header>
    <div className="stats">
      <div><UsersRound size={19} /><span>В списке</span><strong>{plan.guests.length}</strong></div>
      <div><CircleCheck size={19} /><span>Подтвердили</span><strong>{plan.budget.confirmed}</strong></div>
      <div><Clock size={19} /><span>Ждём ответ</span><strong>{plan.budget.expected - plan.budget.confirmed}</strong></div>
    </div>
    <section className="panel guests-panel">
      <div className="panel-heading"><h2>Список гостей</h2><div className="filters">
        <label className="search"><Search size={16} /><input aria-label="Поиск гостей" placeholder="Имя или семья" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="Фильтр по ответу" value={filter} onChange={event => setFilter(event.target.value as Status | 'all')}>
          <option value="all">Все ответы</option>{Object.entries(statusLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select>
      </div></div>
      {!guests.length && <Empty>{plan.guests.length ? 'По этим условиям никого не найдено.' : 'Добавьте первого гостя.'}</Empty>}
      {[...groups.entries()].map(([family, members]) => <div className="guest-group" key={family}>
        <h3>{family || 'Без группы'}</h3>
        {members.map(guest => <div key={guest.id} className="guest-row">
          <button className="person-name text-btn" onClick={() => open(guestEditor(plan, guest))}>{guest.name}</button>
          <span className="table-label"><Armchair size={15} />{plan.objects.find(item => item.id === guest.tableId)?.name ?? 'Без места'}</span>
          <select className={`guest-status ${guest.status}`} aria-label={`Ответ: ${guest.name}`} value={guest.status}
            onChange={event => void change('guests', guest.id, { ...guest, status: event.target.value })}>
            {Object.entries(statusLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
        </div>)}
      </div>)}
    </section>
  </>;
}

export function BudgetPage({ plan, open, change }: { plan: Plan; open: OpenEditor; change: ChangeRecord }) {
  const totals = plan.budget;
  const sources = new Map([
    ['banquet', 'Банкет'],
    ...plan.expenses.map<[string, string]>(expense => [`expense:${expense.id}`, expense.name]),
    ...plan.artists.map<[string, string]>(artist => [`artist:${artist.id}`, artist.name]),
  ]);
  const payments = [...plan.payments].sort((a, b) => Number(a.paid) - Number(b.paid) || (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  return <>
    <header className="page-heading"><div><h1>Смета</h1><p>План расходов, предоплаты и ближайшие платежи.</p></div>
      <AddButton onClick={() => open(expenseEditor())}>Добавить расход</AddButton>
    </header>
    <div className="stats budget-stats">
      <div><Wallet size={19} /><span>План на всех ожидаемых</span><strong>{money(totals.total)}</strong></div>
      <div><CircleCheck size={19} /><span>Уже оплачено</span><strong>{money(totals.paid)}</strong></div>
      <div><Receipt size={19} /><span>{totals.remaining < 0 ? 'Переплата' : 'Осталось по плану'}</span><strong>{money(Math.abs(totals.remaining))}</strong></div>
    </div>
    <div className="two-panels">
      <section className="panel">
        <div className="panel-heading"><div><h2>Банкет</h2><p>{money(plan.settings.banquetPrice)} на человека</p></div>
          <EditButton label="Изменить цену банкета" onClick={() => open(settingsEditor(plan.settings))} /></div>
        <div className="simple-row"><span>Подтвердили <small>· {totals.confirmed} чел.</small></span><strong>{money(totals.confirmedBanquet)}</strong></div>
        <div className="simple-row"><span>Все ожидаемые <small>· {totals.expected} чел.</small></span><strong>{money(totals.expectedBanquet)}</strong></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Другие расходы</h2><p>Гонорары и статьи сметы</p></div></div>
        {!plan.expenses.length && !plan.artists.length && <Empty>Добавьте расход или артиста.</Empty>}
        {plan.artists.map(artist => <div className="simple-row" key={artist.id}><span>{artist.name} <small>· гонорар</small></span><strong>{money(artist.fee)}</strong></div>)}
        {plan.expenses.map(expense => <div className="simple-row" key={expense.id}><span>{expense.name}</span>
          <div><strong>{money(expense.amount)}</strong><EditButton label={`Изменить ${expense.name}`} onClick={() => open(expenseEditor(expense))} /></div>
        </div>)}
      </section>
    </div>
    <section className="panel payment-panel">
      <div className="panel-heading"><div><h2>Платежи</h2><p>Привяжите предоплату или остаток к статье сметы.</p></div>
        <AddButton subtle onClick={() => open(paymentEditor(plan))}>Добавить платёж</AddButton></div>
      {!payments.length && <Empty>Запланированных платежей пока нет.</Empty>}
      {payments.map(payment => <div className="record-row" key={payment.id}>
        <button className={`check-btn${payment.paid ? ' checked' : ''}`} aria-pressed={payment.paid}
          aria-label={`Оплачен: ${payment.name}`} onClick={() => void change('payments', payment.id, { ...payment, paid: !payment.paid })}>
          {payment.paid && <Check size={16} />}
        </button>
        <div><h3>{payment.name}</h3><p>{sources.get(payment.source)} · {payment.paid ? 'Оплачен' : payment.due ? dateLabel(payment.due) : 'Без срока'}</p></div>
        <strong>{money(payment.amount)}</strong><EditButton label={`Изменить ${payment.name}`} onClick={() => open(paymentEditor(plan, payment))} />
      </div>)}
    </section>
  </>;
}

export function TasksPage({ plan, open, change, token, config, report }: {
  plan: Plan; open: OpenEditor; change: ChangeRecord; token: string; config: Config; report: (text: string) => void;
}) {
  const [reminders, setReminders] = useState<Reminders>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const tasks = [...plan.tasks].sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due));
  const nextDue = [
    ...tasks.filter(task => !task.done).map(task => task.due),
    ...plan.payments.flatMap(payment => !payment.paid && payment.due ? [payment.due] : []),
  ].sort()[0];
  const testDate = nextDue ? new Date(`${nextDue}T10:00:00Z`) : new Date();
  if (nextDue) testDate.setUTCDate(testDate.getUTCDate() - 1);
  const [clock, setClock] = useState<string | null>(null);
  const clockValue = clock ?? testDate.toISOString().slice(0, 16);

  useEffect(() => {
    let mounted = true;
    void api<Reminders>('/reminders', token).then(value => {
      if (mounted) setReminders(value);
    }).catch(reason => { if (mounted) report(reason.message); });
    return () => { mounted = false; };
  }, [token, report]);

  async function reminderAction(action: () => Promise<unknown>) {
    setBusy(true);
    setNotice('');
    try {
      await action();
      setReminders(await api('/reminders', token));
    } catch (reason) {
      const latest = await api<Reminders>('/reminders', token).catch(() => undefined);
      setReminders(latest ?? reminders);
      report(reason instanceof Error ? reason.message : 'Не удалось проверить напоминания');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <header className="page-heading"><div><h1>Задачи</h1><p>Сроки подготовки и личные напоминания.</p></div>
      <AddButton onClick={() => open(taskEditor())}>Добавить задачу</AddButton>
    </header>
    <div className="two-panels tasks-grid">
      <section className="panel">
        <div className="panel-heading"><div><h2>Список дел</h2><p>{tasks.filter(task => !task.done).length} осталось</p></div><ListTodo size={20} /></div>
        {!tasks.length && <Empty>Добавьте задачу со сроком.</Empty>}
        {tasks.map(task => <div className={`record-row task-row${task.done ? ' done' : ''}`} key={task.id}>
          <button className={`check-btn${task.done ? ' checked' : ''}`} aria-pressed={task.done}
            aria-label={`Выполнена: ${task.name}`} onClick={() => void change('tasks', task.id, { ...task, done: !task.done })}>
            {task.done && <Check size={16} />}
          </button>
          <div><h3>{task.name}</h3><p>{dateLabel(task.due)}</p></div>
          <EditButton label={`Изменить ${task.name}`} onClick={() => open(taskEditor(task))} />
        </div>)}
      </section>
      <section className="panel reminders-panel">
        <div className="panel-heading"><div><h2>Напоминания</h2><p>В 10:00 за день до срока · {plan.settings.timezone}</p></div><Bell size={20} /></div>
        {reminders && <div className="reminders-main">
          {reminders.connected ? <label className="check-field"><input type="checkbox" checked={reminders.enabled} disabled={busy}
            onChange={event => {
              const enabled = event.target.checked;
              setReminders({ ...reminders, enabled });
              void reminderAction(() => api('/reminders', token, json('PUT', { enabled })));
            }} /> Напоминать мне о задачах и платежах</label> :
            <p>Чтобы включить напоминания, отправьте <code>/start</code> боту в личном чате. <a href={`https://t.me/${config.botUsername}`} target="_blank" rel="noreferrer">Открыть бота</a></p>}
          {config.demo && <form className="reminder-test" onSubmit={event => {
            event.preventDefault();
            void reminderAction(async () => {
              const result = await api<{ created: number }>('/reminders/simulate', token, json('POST', { at: clockValue }));
              setNotice(`Создано напоминаний: ${result.created}`);
            });
          }}>
            <h3><FlaskConical size={16} /> Тестовые часы</h3>
            <label className="field"><span>Местное время свадьбы</span><input type="datetime-local" required value={clockValue} onChange={event => setClock(event.target.value)} /></label>
            <button className="btn secondary" disabled={busy || !reminders.enabled}>Проверить напоминания</button>
            {notice && <p role="status">{notice}</p>}
          </form>}
          {!!reminders.history.length && <ul className="reminder-history">
            {reminders.history.map(item => <li key={item.id}><Bell size={15} /><span>{item.message}</span>
              <small>{reminderStatuses[item.status] ?? 'Доставка не подтверждена'}</small></li>)}
          </ul>}
        </div>}
      </section>
    </div>
  </>;
}

const reminderStatuses: Record<string, string> = {
  simulated: 'Тест', sent: 'Отправлено', cancelled: 'Отменено', pending: 'В очереди', sending: 'Отправляется',
};
