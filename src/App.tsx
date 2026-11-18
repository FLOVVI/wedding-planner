import { useCallback, useEffect, useRef, useState } from 'react';
import { Armchair, CalendarDays, CalendarClock, HeartHandshake, LayoutGrid, ListTodo, Settings2, Share2, UsersRound, Wallet, X } from 'lucide-react';
import { AccessDialog } from './AccessDialog';
import { api, ApiError, json, telegram } from './api';
import { FormDialog, type Editor } from './components';
import { settingsEditor } from './forms';
import { OverviewPage } from './OverviewPage';
import { BudgetPage, GuestsPage, TasksPage } from './PlanningPages';
import { ProgramPage } from './ProgramPage';
import { SeatingPage } from './SeatingPage';
import type { Collection, Config, FormData, Page, Plan, Program, Session } from './types';

const navigation = [
  { id: 'overview', title: 'Обзор', icon: LayoutGrid },
  { id: 'program', title: 'Программа', icon: CalendarClock },
  { id: 'seating', title: 'Рассадка', icon: Armchair },
  { id: 'guests', title: 'Гости', icon: UsersRound },
  { id: 'budget', title: 'Смета', icon: Wallet },
  { id: 'tasks', title: 'Задачи', icon: ListTodo },
] as const;

const SESSION_KEY = 'vmeste-session';
const initialPage = () => navigation.find(item => `#${item.id}` === location.hash)?.id ?? 'overview';

let telegramScript: Promise<void> | undefined;
function loadTelegram() {
  if (telegram()) return Promise.resolve();
  telegramScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Не удалось загрузить Telegram Mini App'));
    document.head.append(script);
  });
  return telegramScript;
}

export function App() {
  const [config, setConfig] = useState<Config>();
  const [session, setSession] = useState<Session>();
  const [plan, setPlan] = useState<Plan>();
  const [teamProgram, setTeamProgram] = useState<Program>();
  const [page, setPage] = useState<Page>(initialPage);
  const [editor, setEditor] = useState<{ form: Editor; revision: number }>();
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const timer = useRef<number>(undefined);
  const activeToken = useRef('');
  const changing = useRef(false);

  const report = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(''), 5500);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function activateSession(next: Session) {
    sessionStorage.setItem(SESSION_KEY, next.token);
    activeToken.current = next.token;
    setFailure('');
    setPlan(undefined);
    setTeamProgram(undefined);
    setSession(next);
  }

  useEffect(() => {
    async function boot() {
      try {
        const settings = await api<Config>('/config');
        setConfig(settings);
        if (settings.demo) {
          const params = new URLSearchParams(location.search);
          const invite = params.get('invite');
          const user = params.get('as');
          if (invite && (user === 'partner' || user === 'team')) {
            sessionStorage.removeItem(SESSION_KEY);
            const next = await api<Session>('/session/demo', undefined, json('POST', { user, invite }));
            history.replaceState(null, '', location.pathname + location.hash);
            activateSession(next);
            return;
          }
          const token = sessionStorage.getItem(SESSION_KEY);
          if (token) {
            const known = await api<{ role: Session['role'] }>('/session', token).catch(() => undefined);
            if (!known) throw new Error('Сессия закончилась или ссылка была отозвана.');
            activateSession({ token, role: known.role });
            return;
          }
          activateSession(await api<Session>('/session/demo', undefined, json('POST', { user: 'owner' })));
        } else {
          await loadTelegram();
          const app = telegram();
          app?.ready();
          app?.expand();
          if (!app?.initData) throw new Error('Откройте свадебный план из Telegram.');
          const launch = new URLSearchParams(location.search).get('tgWebAppStartParam');
          const token = sessionStorage.getItem(SESSION_KEY);
          const sameLaunch = sessionStorage.getItem('vmeste-launch') === (launch ?? '');
          if (token && sameLaunch) {
            const known = await api<{ role: Session['role'] }>('/session', token).catch(() => undefined);
            if (known) {
              activateSession({ token, role: known.role });
              return;
            }
          }
          const next = await api<Session>('/session/telegram', undefined, json('POST', { initData: app.initData }));
          sessionStorage.setItem('vmeste-launch', launch ?? '');
          activateSession(next);
        }
      } catch (reason) {
        setFailure(reason instanceof Error ? reason.message : 'Не удалось открыть приложение');
      }
    }
    void boot();
  }, []);

  const refresh = useCallback(async (current: Session) => {
    if (current.role === 'team') {
      const next = await api<Program>('/program', current.token);
      if (activeToken.current === current.token) setTeamProgram(previous => previous && previous.revision > next.revision ? previous : next);
    } else {
      const next = await api<Plan>('/plan', current.token);
      if (activeToken.current === current.token) setPlan(previous => previous && previous.revision > next.revision ? previous : next);
    }
    if (activeToken.current === current.token) setFailure('');
  }, []);

  useEffect(() => {
    if (!session) return;
    function sync() {
      if (!session) return;
      void refresh(session).catch(reason => {
        if (activeToken.current !== session.token) return;
        if (reason instanceof ApiError && reason.status === 401) {
          setFailure(reason.message);
          setPlan(undefined);
          setTeamProgram(undefined);
        } else setFailure('Не удалось обновить данные. Приложение повторит попытку.');
      });
    }
    sync();
    const interval = window.setInterval(sync, 6000);
    const onVisibility = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session, refresh]);

  async function reopenDemo() {
    try {
      history.replaceState(null, '', '/');
      setPage('overview');
      activateSession(await api<Session>('/session/demo', undefined, json('POST', { user: 'owner' })));
    } catch (reason) { setFailure(reason instanceof Error ? reason.message : 'Не удалось открыть локальный план'); }
  }

  function go(next: Page) {
    setPage(next);
    history.replaceState(null, '', `#${next}`);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function mutation(path: string, init: RequestInit) {
    if (!session) throw new Error('Откройте приложение заново');
    if (changing.current) throw new Error('Подождите, пока сохранится предыдущее изменение');
    changing.current = true;
    try {
      await api(path, session.token, init);
      await refresh(session).catch(() => report('Изменение сохранено. План обновится при следующем соединении.'));
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) await refresh(session).catch(() => undefined);
      throw reason;
    } finally { changing.current = false; }
  }

  function open(form: Editor) {
    if (plan) setEditor({ form, revision: plan.revision });
  }

  async function change(collection: Collection, id: string, body: FormData) {
    if (!plan) return false;
    try {
      await mutation(`/items/${collection}/${id}?revision=${plan.revision}`, json('PUT', body));
      return true;
    } catch (reason) {
      report(reason instanceof Error ? reason.message : 'Не удалось сохранить изменение');
      return false;
    }
  }

  async function changeFloor(file?: File) {
    if (!plan) return;
    if (file && file.size > 6 * 1024 * 1024) { report('Размер файла превышает 6 МБ'); return; }
    try {
      const filename = file ? `&filename=${encodeURIComponent(file.name.slice(0, 160))}` : '';
      await mutation(`/floor?revision=${plan.revision}${filename}`, file ? { method: 'PUT', body: file } : { method: 'DELETE' });
      report(file ? 'План площадки загружен' : 'Фон схемы удалён');
    } catch (reason) { report(reason instanceof Error ? reason.message : 'Не удалось изменить план площадки'); }
  }

  const workspace = session?.role === 'team' ? teamProgram : plan;
  const team = session?.role === 'team';
  if (!workspace || !config || !session) return <main className="entry">
    <div className="brand-mark"><HeartHandshake size={25} /></div><h1>Вместе</h1>
    <p role="status">{failure || 'Открываем свадебный план…'}</p>
    {config?.demo && failure && <button className="btn secondary" onClick={() => void reopenDemo()}>Открыть локальный план</button>}
    {!config && failure && <button className="btn secondary" onClick={() => location.reload()}>Повторить</button>}
    {config && !config.demo && failure && config.botUsername && <a className="btn primary" href={`https://t.me/${config.botUsername}`}>Открыть бота</a>}
  </main>;

  return <div className={`app-shell${team ? ' team-shell' : ''}`}>
    {!team && <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><HeartHandshake size={23} strokeWidth={1.9} /></span><div><strong>Вместе</strong><small>Свадебный планировщик</small></div></div>
      <div className="sidebar-rule" />
      <nav aria-label="Разделы плана">{navigation.map(item => {
        const Icon = item.icon;
        return <button key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => go(item.id)}>
          <Icon size={19} /><span>{item.title}</span>
        </button>;
      })}</nav>
      {plan && <button className="sidebar-settings" onClick={() => open(settingsEditor(plan.settings))}><Settings2 size={18} />Настройки свадьбы</button>}
    </aside>}
    <div className="workspace">
      <div className="topbar">
        <div className="workspace-label"><span><CalendarDays size={18} /></span><strong>{workspace.settings.name}</strong></div>
        <div className="top-actions">
          {config.demo && <span className="local-label"><i /> Локально</span>}
          {team ? <span className="read-only">Только просмотр</span> : <button className="btn secondary" onClick={() => setSharing(true)}><Share2 size={16} /> Доступ</button>}
        </div>
      </div>
      <main className="content" id="content">
        {failure && <div className="warning" role="status">{failure}</div>}
        {team && teamProgram && <ProgramPage data={teamProgram} open={open} share={() => undefined} />}
        {!team && plan && <>
          {page === 'overview' && <OverviewPage plan={plan} go={go} settings={() => open(settingsEditor(plan.settings))} />}
          {page === 'program' && <ProgramPage data={{ revision: plan.revision, settings: plan.settings, blocks: plan.program }} plan={plan} open={open} share={() => setSharing(true)} />}
          {page === 'seating' && <SeatingPage plan={plan} token={session.token} open={open} change={change}
            upload={changeFloor} clearImage={() => changeFloor()} report={report} />}
          {page === 'guests' && <GuestsPage plan={plan} open={open} change={change} />}
          {page === 'budget' && <BudgetPage plan={plan} open={open} change={change} />}
          {page === 'tasks' && <TasksPage plan={plan} open={open} change={change} token={session.token} config={config} report={report} />}
        </>}
      </main>
    </div>
    {editor && <FormDialog editor={editor.form} close={() => setEditor(undefined)} save={data => {
      const { form, revision } = editor;
      if (!form.collection) return mutation(`/settings?revision=${revision}`, json('PUT', data));
      const item = form.id ? `/${form.id}` : '';
      return mutation(`/items/${form.collection}${item}?revision=${revision}`, json(form.id ? 'PUT' : 'POST', data));
    }} remove={editor.form.id ? () => mutation(`/items/${editor.form.collection}/${editor.form.id}?revision=${editor.revision}`, { method: 'DELETE' }) : undefined} />}
    {sharing && <AccessDialog session={session} config={config} close={() => setSharing(false)} />}
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-btn" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><X size={16} /></button></div>}
  </div>;
}
