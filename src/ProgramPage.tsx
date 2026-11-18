import {
  AlertTriangle, AudioLines, CalendarDays, ChevronDown, Disc3, ExternalLink, Heart, MapPin, Mic2,
  Music2, Radio, Settings2, Share2, Sparkles, UsersRound,
} from 'lucide-react';
import { AddButton, EditButton, Empty, type OpenEditor } from './components';
import { artistEditor, eventEditor, paymentEditor, settingsEditor } from './forms';
import { blockLabels, dateLabel, money, showTime, type Plan, type Program } from './types';

const eventIcons = { soundcheck: AudioLines, ceremony: Heart, dance: Music2, live: Mic2, dj: Disc3, other: Sparkles };

export function ProgramPage({ data, plan, open, share }: {
  data: Program; plan?: Plan; open: OpenEditor; share: () => void;
}) {
  const conflicts = data.blocks.filter(block => block.conflict).length;
  return <>
    <section className="program-hero">
      <div className="hero-motif" aria-hidden="true"><i /><i /><i /><i /><Music2 size={82} strokeWidth={.85} /></div>
      <div className="hero-content">
        <div className="hero-kicker"><Music2 size={15} /> Музыка и тайминг</div>
        <h1>Программа свадьбы</h1>
        <div className="hero-meta">
          <span><CalendarDays size={16} />{data.settings.date ? dateLabel(data.settings.date, true) : 'Дата уточняется'}</span>
          <span><MapPin size={16} />{data.settings.venue || 'Площадка уточняется'}</span>
        </div>
      </div>
      {plan && <button className="hero-settings" aria-label="Настройки свадьбы" title="Настройки свадьбы"
        onClick={() => open(settingsEditor(plan.settings))}><Settings2 size={18} /></button>}
    </section>

    <div className={`program-grid${plan ? '' : ' team-grid'}`}>
      <section className="panel timeline-panel">
        <div className="panel-heading">
          <div><h2>Тайминг дня</h2><p>{data.blocks.length ? `${data.blocks.length} ${eventWord(data.blocks.length)} · ${data.settings.timezone.replaceAll('_', ' ')}` : 'Порядок событий и выступлений'}</p></div>
          {plan && <AddButton onClick={() => open(eventEditor(plan))}>Добавить событие</AddButton>}
        </div>
        {!!conflicts && <div className="warning" role="status"><AlertTriangle size={17} /> Есть пересечения по времени. Проверьте отмеченные события.</div>}
        {!data.blocks.length && <Empty>В программе пока нет событий.</Empty>}
        <ol className="timeline">
          {data.blocks.map(block => {
            const Icon = eventIcons[block.kind];
            const record = plan?.blocks.find(item => item.id === block.id);
            return <li key={block.id} className={`timeline-row ${block.conflict ? 'overlap' : ''}`}>
              <div className="timeline-time"><strong>{showTime(block)}</strong><span>{showTime(block, true)}</span></div>
              <div className={`timeline-marker marker-${block.kind}`}><Icon size={17} /></div>
              <div className="timeline-body">
                <div className="timeline-title"><h3>{block.title}</h3>{block.conflict && <span className="conflict-tag" title="Пересечение по времени"><AlertTriangle size={13} /> Пересечение</span>}</div>
                <div className="timeline-info"><span className={`kind kind-${block.kind}`}>{blockLabels[block.kind]}</span>
                  {block.artistName && <span>{block.artistName}</span>}
                  {block.responsible && <span>{block.responsible}</span>}
                </div>
                {block.notes && <p>{block.notes}</p>}
                {(block.tracks.length > 0 || block.artistSound) && <details className="block-details">
                  <summary>{block.tracks.length ? 'Треки и звук' : 'Требования к звуку'} <ChevronDown size={13} /></summary>
                  {block.artistSound && <p>{block.artistSound}</p>}
                  {block.tracks.map((track, index) => <a key={`${track}-${index}`} href={track} target="_blank" rel="noreferrer">
                    <Music2 size={14} /> Трек {index + 1} <ExternalLink size={12} />
                  </a>)}
                </details>}
              </div>
              {plan && record && <EditButton label={`Изменить ${block.title}`} onClick={() => open(eventEditor(plan, record))} />}
            </li>;
          })}
        </ol>
      </section>

      {plan && <aside className="program-aside">
        <section className="panel artist-panel">
          <div className="panel-heading">
            <div><h2>Артисты</h2><p>Состав и технические детали</p></div>
            <button className="icon-btn add-icon" aria-label="Добавить артиста" title="Добавить артиста" onClick={() => open(artistEditor())}>
              <span aria-hidden="true">+</span>
            </button>
          </div>
          {!plan.artists.length && <Empty>Приглашённые артисты появятся здесь.</Empty>}
          {plan.artists.map((artist, index) => {
            const payments = plan.payments.filter(payment => payment.source === `artist:${artist.id}`);
            return <article className="artist-card" key={artist.id}>
              <div className="artist-row">
                <div className={`artist-icon ${index % 2 ? 'cool' : ''}`}>{index % 2 ? <Disc3 size={21} /> : <Mic2 size={21} />}</div>
                <div className="artist-name"><h3>{artist.name}</h3>{artist.role && <p>{artist.role}</p>}</div>
                <EditButton label={`Изменить ${artist.name}`} onClick={() => open(artistEditor(artist))} />
              </div>
              <details className="artist-details">
                <summary><span>{money(artist.fee)}</span><span>Детали <ChevronDown size={13} /></span></summary>
                {artist.contact && <p>{artist.contact}</p>}
                {artist.sound && <p>{artist.sound}</p>}
                <div className="artist-payments">
                  {payments.map(payment => <button className="text-btn payment-link" key={payment.id} onClick={() => open(paymentEditor(plan, payment))}>
                    <span>{payment.name}</span><small>{payment.paid ? 'Оплачен' : payment.due ? dateLabel(payment.due) : 'Без срока'} · {money(payment.amount)}</small>
                  </button>)}
                  <button className="text-btn" onClick={() => open(paymentEditor(plan, undefined, `artist:${artist.id}`))}>Добавить платёж</button>
                </div>
              </details>
            </article>;
          })}
        </section>

        <section className="share-card">
          <div className="share-card-icon"><UsersRound size={19} /></div>
          <h2>Программа для команды</h2>
          <p>Координатор, ведущий и звукорежиссёр увидят актуальный тайминг по одной ссылке.</p>
          <button className="btn secondary" onClick={share}><Share2 size={16} /> Настроить доступ</button>
        </section>
      </aside>}
    </div>
    {!plan && <p className="team-foot"><Radio size={15} /> Программа обновляется автоматически</p>}
  </>;
}

function eventWord(count: number) {
  if (count % 100 >= 11 && count % 100 <= 14) return 'событий';
  if (count % 10 === 1) return 'событие';
  if (count % 10 >= 2 && count % 10 <= 4) return 'события';
  return 'событий';
}
