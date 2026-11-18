import { Armchair, ArrowDown, CalendarDays, HeartHandshake, ListTodo, Send, Wallet } from 'lucide-react';

const features = [
  { icon: CalendarDays, title: 'Программа дня', text: 'Соберите церемонию, фотосъёмку, банкет и музыку в одном тайминге.' },
  { icon: Armchair, title: 'Гости и рассадка', text: 'Отметьте ответы гостей. Расставьте столы на схеме площадки и распределите места.' },
  { icon: Wallet, title: 'Смета и платежи', text: 'Сравните стоимость банкета для разных составов гостей и учитывайте предоплаты.' },
  { icon: ListTodo, title: 'Задачи и команда', text: 'Храните сроки, контакты подрядчиков и делитесь программой с координатором.' },
];

export function PublicPage() {
  const username = (import.meta.env.VITE_BOT_USERNAME as string | undefined)?.replace(/^@/, '');
  const bot = username && /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username) ? `https://t.me/${username}` : undefined;

  return <div className="public-page">
    <header className="public-header">
      <a className="public-brand" href="./" aria-label="Вместе, главная"><span className="brand-mark"><HeartHandshake size={23} /></span>Вместе</a>
      <a className="text-btn" href="#features">Возможности</a>
    </header>
    <main className="public-content">
      <section className="public-hero">
        <div className="public-hero-copy">
          <h1>Спланируйте свадьбу вместе</h1>
          <p>Гости, рассадка, смета и программа свадебного дня в одном приложении для пары.</p>
          {bot ? <a className="btn primary" href={bot}><Send size={17} /> Открыть в Telegram</a> :
            <a className="btn primary" href="#features">Посмотреть возможности <ArrowDown size={16} /></a>}
        </div>
        <div className="public-illustration" aria-hidden="true"><i /><i /><HeartHandshake size={83} strokeWidth={1.15} /></div>
      </section>
      <section id="features" className="public-features" aria-label="Возможности">
        {features.map(({ icon: Icon, title, text }) => <article className="public-card" key={title}>
          <div className="public-card-icon"><Icon size={21} /></div>
          <h2>{title}</h2><p>{text}</p>
        </article>)}
      </section>
      {!bot && <p className="public-footer"><Send size={16} /> Свадебный план будет открываться из бота в Telegram после подключения сервера.</p>}
    </main>
  </div>;
}
