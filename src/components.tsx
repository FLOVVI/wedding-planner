import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X, Plus, Pencil, Trash2 } from 'lucide-react';
import type { Collection, FormData, FormValue } from './types';

export type FieldSpec = {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'time' | 'check' | 'select' | 'links' | 'range';
  options?: [string, string][];
  required?: boolean;
  emptyNull?: boolean;
  half?: boolean;
  min?: number;
  max?: number;
  step?: number | 'any';
  hint?: string;
  show?: (draft: FormData) => boolean;
};

export type Editor = {
  title: string;
  fields: FieldSpec[];
  initial: FormData;
  collection?: Collection;
  id?: string;
};

export type OpenEditor = (editor: Editor) => void;
export type ChangeRecord = (collection: Collection, id: string, body: FormData) => Promise<boolean>;

export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);

  return <dialog ref={dialog} className="modal" aria-labelledby="dialog-title" onCancel={event => {
    event.preventDefault();
    close();
  }} onClick={event => {
    if (event.target === dialog.current) close();
  }}>
    <div className="modal-inner">
      <div className="modal-heading">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={close}><X size={20} /></button>
      </div>
      {children}
    </div>
  </dialog>;
}

export function FormDialog({ editor, close, save, remove }: {
  editor: Editor; close: () => void;
  save: (data: FormData) => Promise<void>;
  remove?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(editor.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const formId = useId();

  async function submit(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось сохранить изменения');
    } finally {
      setBusy(false);
    }
  }

  function fieldChange(field: FieldSpec, value: string, checked: boolean) {
    let parsed: FormValue = value;
    if (field.type === 'check') parsed = checked;
    if (field.emptyNull && value === '') parsed = null;
    setDraft(previous => ({ ...previous, [field.key]: parsed }));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = { ...draft };
    for (const field of editor.fields) {
      const value = payload[field.key];
      if (field.type === 'number' || field.type === 'range') payload[field.key] = Number(value);
      if (field.type === 'links' && typeof value === 'string') {
        payload[field.key] = value.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
      }
    }
    void submit(() => save(payload));
  }

  return <Modal title={editor.title} close={() => { if (!busy) close(); }}>
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        {editor.fields.filter(field => !field.show || field.show(draft)).map(field => {
          const data = draft[field.key];
          const value = Array.isArray(data) ? data.join('\n') : String(data ?? '');
          const labelId = `${formId}-${field.key}`;
          const accessibility = { 'aria-labelledby': labelId, 'aria-describedby': field.hint ? `${labelId}-hint` : undefined };
          const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
            fieldChange(field, event.target.value, 'checked' in event.target && event.target.checked);
          };
          if (field.type === 'check') return <label className={`check-field${field.half ? ' half' : ''}`} key={field.key}>
            <input type="checkbox" checked={Boolean(data)} onChange={onChange} /> {field.label}
          </label>;
          return <label key={field.key} className={`field${field.half ? ' half' : ''}`}>
            <span id={labelId}>{field.label}{field.type === 'range' ? ` · ${value}°` : ''}</span>
            {field.type === 'select' ? <select {...accessibility} value={value} required={field.required} onChange={onChange}>
              {field.options?.map(([option, name]) => <option key={option} value={option}>{name}</option>)}
            </select> : field.type === 'textarea' || field.type === 'links' ?
              <textarea {...accessibility} value={value} onChange={onChange} required={field.required} rows={3} maxLength={field.type === 'links' ? 8000 : 2000} /> :
              <input {...accessibility} type={field.type ?? 'text'} value={value} onChange={onChange} required={field.required}
                min={field.min} max={field.max} step={field.step} maxLength={field.type ? undefined : 140} />}
            {field.hint && <small id={`${labelId}-hint`}>{field.hint}</small>}
          </label>;
        })}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer">
        {remove && <button type="button" className="btn danger" disabled={busy} onClick={() => {
          if (confirm) void submit(remove);
          else setConfirm(true);
        }}><Trash2 size={16} />{confirm ? 'Подтвердить удаление' : 'Удалить'}</button>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </form>
  </Modal>;
}

export function AddButton({ children, onClick, subtle = false }: {
  children: ReactNode; onClick: () => void; subtle?: boolean;
}) {
  return <button type="button" className={`btn ${subtle ? 'secondary' : 'primary'}`} onClick={onClick}>
    <Plus size={17} />{children}
  </button>;
}

export function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="icon-btn edit-btn" aria-label={label} title={label} onClick={onClick}>
    <Pencil size={15} />
  </button>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
