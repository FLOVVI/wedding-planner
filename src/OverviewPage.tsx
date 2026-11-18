import { Armchair, ArrowRight, CalendarDays, CalendarCheck, CheckCircle2, ClipboardList, CreditCard, MapPin, Settings2, UsersRound, Wallet } from 'lucide-react';
import { Empty } from './components';
import { blockLabels, dateLabel, money, showTime, type Page, type Plan } from './types';

export function OverviewPage({ plan, go, settings }: { plan: Plan; go: (page: Page) => void; settings: () => void }) {
  const { budget } = plan;
  const seated = plan.guests.filter(guest => guest.status !== 'declined' && guest.tableId).length;
  const pending = plan.tasks.filter(task => !task.done);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: plan.settings.timezone }).format(new Date());
  const upcoming = [
    ...pending.map(task => ({ id: task.id, name: task.name, due: task.due, type: 'task' as const })),
    ...plan.payments.flatMap(payment => payment.due && !payment.paid ? [{
      id: payment.id, name: payment.name, due: payment.due, type: 'payment' as const,
    }] : []),
  ].sort((first, second) => first.due.localeCompare(second.due)).slice(0, 5);
  const metrics = [
    { page: 'guests', title: 'Гости', value: `${budget.confirmed} из ${budget.expected}`, detail: 'подтвердили участие', icon: UsersRound },
    { page: 'seating', title: 'Рассадка', value: `${seated} из ${budget.expected}`, detail: 'гостей за столами', icon: Armchair },
    { page: 'budget', title: 'Смета', value: money(budget.total), detail: `${money(budget.paid)} оплачено`, icon: Wallet },
    { page: 'tasks', title: 'Задачи', value: String(pending.length), detail: 'к выполнению', icon: ClipboardList },
  ] as const;

  return <>
    <section className="overview-hero">
      <div className="wedding-rings" aria-hidden="true"><i /><i /></div>
      <div className="hero-content">
        <h1>План свадьбы</h1>
        <div className="hero-meta">
          <span><CalendarDays size={16} />{plan.settings.date ? dateLabel(plan.settings.date, true) : 'Дата уточняется'}</span>
          <span><MapPin size={16} />{plan.settings.venue || 'Площадка уточняется'}</span>
        </div>
      </div>
      <button className="btn secondary overview-settings" onClick={settings}><Settings2 size={16} /> Настройки свадьбы</button>
    </section>
    <div className="overview-metrics" aria-label="Состояние подготовки">
      {metrics.map(item => <button key={item.page} className="overview-metric" onClick={() => go(item.page)}>
        <span className="overview-metric-title"><item.icon size={18} /> {item.title}<ArrowRight size={14} /></span>
        <strong>{item.value}</strong>
        <small>{item.detail}</small>
      </button>)}
    </div>
    <div className="two-panels">
      <section className="panel">
        <div className="panel-heading"><h2>Ближайшие сроки</h2><CalendarCheck size={20} /></div>
        {!upcoming.length && <Empty>Задачи и платежи со сроком появятся здесь.</Empty>}
        {upcoming.map(item => <button className="overview-record" key={item.id} onClick={() => go(item.type === 'task' ? 'tasks' : 'budget')}>
          <span className={`overview-record-icon ${item.type}`}>{item.type === 'task' ? <CheckCircle2 size={17} /> : <CreditCard size={17} />}</span>
          <span><strong>{item.name}</strong><small>{item.type === 'task' ? 'Задача' : 'Платёж'}</small></span>
          <span className={item.due < today ? 'past-due' : ''}>{item.due === today ? 'Сегодня' : dateLabel(item.due)}</span>
        </button>)}
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>День свадьбы</h2>
          <button className="text-btn" onClick={() => go('program')}>Вся программа <ArrowRight size={15} /></button>
        </div>
        {!plan.program.length && <Empty>Добавьте события, чтобы собрать тайминг дня.</Empty>}
        {plan.program.slice(0, 4).map(block => <button className="overview-record agenda-record" key={block.id} onClick={() => go('program')}>
          <time>{showTime(block)}</time><span><strong>{block.title}</strong><small>{blockLabels[block.kind]}</small></span>
          <ArrowRight size={14} />
        </button>)}
      </section>
    </div>
  </>;
}
