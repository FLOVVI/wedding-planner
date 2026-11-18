import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Link2, UserRoundPlus } from 'lucide-react';
import { api } from './api';
import { Modal } from './components';
import type { Config, Session } from './types';

type LinkKind = 'team' | 'partner';
type Links = { teamActive: boolean; partnerJoined: boolean };

export function AccessDialog({ session, config, close }: { session: Session; config: Config; close: () => void }) {
  const [links, setLinks] = useState<Links>();
  const [issued, setIssued] = useState<Partial<Record<LinkKind, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<LinkKind>();

  useEffect(() => {
    let active = true;
    void api<Links>('/links', session.token).then(result => { if (active) setLinks(result); })
      .catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [session.token]);

  async function change(kind: LinkKind, method: 'POST' | 'DELETE') {
    setError('');
    setCopied(undefined);
    setBusy(true);
    try {
      const result = await api<{ token?: string }>(`/links/${kind}`, session.token, { method });
      const url = result.token ? inviteUrl(result.token, kind, config) : undefined;
      setIssued(previous => ({ ...previous, [kind]: url }));
      setLinks(await api('/links', session.token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось обновить ссылку');
    } finally { setBusy(false); }
  }

  async function copy(kind: LinkKind, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(kind);
    } catch {
      setError('Выделите ссылку и скопируйте её вручную.');
    }
  }

  function linkField(kind: LinkKind) {
    const url = issued[kind];
    if (!url) return null;
    return <div className="link-field">
      <input aria-label={kind === 'team' ? 'Ссылка для команды' : 'Ссылка для пары'} value={url} readOnly onFocus={event => event.target.select()} />
      <button className="icon-btn" aria-label={copied === kind ? 'Скопировано' : 'Скопировать ссылку'} onClick={() => void copy(kind, url)}>
        {copied === kind ? <Check size={18} /> : <Copy size={18} />}
      </button>
      {config.demo && <a className="icon-btn" aria-label={kind === 'team' ? 'Открыть как команда' : 'Открыть как второй участник'}
        href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={18} /></a>}
    </div>;
  }

  return <Modal title="Доступ к свадьбе" close={() => { if (!busy) close(); }}>
    <div className="access-section"><Link2 size={21} />
      <div><h3>Команда</h3><p>По ссылке открывается программа дня с треками и заметками.</p>
        {linkField('team')}
        <div className="access-actions">
          <button className="btn primary" disabled={busy || !links} onClick={() => void change('team', 'POST')}>
            {links?.teamActive ? 'Выпустить новую ссылку' : 'Создать ссылку'}
          </button>
          {links?.teamActive && <button className="btn secondary" disabled={busy} onClick={() => void change('team', 'DELETE')}>Отозвать ссылку</button>}
        </div>
        {links?.teamActive && <small>Новая ссылка заменяет предыдущую.</small>}
      </div>
    </div>
    {session.role === 'owner' && <div className="access-section"><UserRoundPlus size={21} />
      <div><h3>Второй участник</h3><p>{links?.partnerJoined ? 'Второй участник уже редактирует общий план.' : 'Приглашение действует 24 часа и используется один раз.'}</p>
        {linkField('partner')}
        {!links?.partnerJoined && <div className="access-actions">
          <button className="btn secondary" disabled={busy || !links} onClick={() => void change('partner', 'POST')}>Пригласить</button>
          {issued.partner && <button className="btn danger" disabled={busy} onClick={() => void change('partner', 'DELETE')}>Отозвать приглашение</button>}
        </div>}
      </div>
    </div>}
    {config.demo && <p className="demo-hint">В локальном режиме ссылки открываются в новой вкладке на этом компьютере.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>;
}

function inviteUrl(token: string, kind: LinkKind, config: Config) {
  if (!config.demo) return `https://t.me/${config.botUsername}?startapp=${token}`;
  const url = new URL('/', location.origin);
  url.searchParams.set('as', kind);
  url.searchParams.set('invite', token);
  return url.toString();
}
