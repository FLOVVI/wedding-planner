import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Armchair, DoorOpen, ImagePlus, MapPinned, Mic2, Minus, Plus, RotateCcw, Settings2, Sparkles, UsersRound, X } from 'lucide-react';
import { downloadFloor } from './api';
import { EditButton, Empty, type ChangeRecord, type OpenEditor } from './components';
import { objectEditor } from './forms';
import { isTable, objectLabels, statusLabels, type FloorObject, type ObjectKind, type Plan } from './types';

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function SeatingPage({ plan, token, eventId, open, change, upload, clearImage, report }: {
  plan: Plan; token: string; eventId?: string; open: OpenEditor; change: ChangeRecord;
  upload: (image: File) => Promise<void>; clearImage: () => Promise<void>; report: (message: string) => void;
}) {
  const [background, setBackground] = useState('');
  const [zoom, setZoom] = useState(100);
  const [selectedGuest, selectGuest] = useState<string | null>(null);
  const [selectedObject, selectObject] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number }>();
  const [uploading, setUploading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const pointer = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);
  const mapPanel = useRef<HTMLElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const floorVersion = plan.floor?.version;

  useEffect(() => {
    setBackground('');
    if (floorVersion === undefined) return;
    const controller = new AbortController();
    let objectUrl = '';
    downloadFloor(token, controller.signal, eventId).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setBackground(objectUrl);
    }).catch(() => {
      if (!controller.signal.aborted) report('Не удалось загрузить изображение площадки');
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, eventId, floorVersion, report]);

  const tables = plan.objects.filter(isTable);
  const attending = plan.guests.filter(item => item.status !== 'declined');
  const unseated = attending.filter(item => !item.tableId);
  const seated = attending.length - unseated.length;
  const activeGuest = unseated.find(item => item.id === selectedGuest);
  const activeObject = plan.objects.find(item => item.id === selectedObject);
  const guestsAt = (id: string) => attending.filter(item => item.tableId === id);

  async function handleFile(image: File | undefined) {
    if (!image) return;
    setUploading(true);
    try { await upload(image); }
    finally { setUploading(false); }
  }

  function moveTo(item: FloorObject, x: number, y: number) {
    const dimensions = canvas.current?.getBoundingClientRect();
    if (!dimensions) return { x: item.x, y: item.y };
    const angle = item.rotation * Math.PI / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const ratio = dimensions.width / dimensions.height;
    const halfX = Math.min(.48, (item.width * cos + item.height * sin / ratio) / 2);
    const halfY = Math.min(.48, (item.width * sin * ratio + item.height * cos) / 2);
    return { x: clamp(x, halfX, 1 - halfX), y: clamp(y, halfY, 1 - halfY) };
  }

  function dragPosition(event: PointerEvent<HTMLButtonElement>, item: FloorObject) {
    const bounds = canvas.current?.getBoundingClientRect();
    const start = pointer.current;
    if (!bounds || !start) return { x: item.x, y: item.y };
    return moveTo(item, item.x + (event.clientX - start.x) / bounds.width, item.y + (event.clientY - start.y) / bounds.height);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, item: FloorObject) {
    suppressClick.current = false;
    if (activeGuest || event.button !== 0 || pointer.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { id: item.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }

  function updateDrag(event: PointerEvent<HTMLButtonElement>, item: FloorObject) {
    const start = pointer.current;
    if (start?.id !== item.id || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) start.moved = true;
    if (start.moved) setDragging({ id: item.id, ...dragPosition(event, item) });
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>, item: FloorObject, cancelled = false) {
    const start = pointer.current;
    if (start?.id !== item.id || start.pointerId !== event.pointerId) return;
    if (!cancelled && start.moved) {
      suppressClick.current = true;
      selectObject(item.id);
      void change('objects', item.id, { ...item, ...dragPosition(event, item) }).finally(() => setDragging(undefined));
    } else setDragging(undefined);
    pointer.current = null;
  }

  async function pickObject(item: FloorObject) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    selectObject(item.id);
    if (activeGuest && isTable(item)) {
      if (guestsAt(item.id).length >= item.capacity) {
        report('За этим столом нет свободных мест');
        return;
      }
      if (await change('guests', activeGuest.id, { ...activeGuest, tableId: item.id })) selectGuest(null);
    }
  }

  return <>
    <header className="page-heading"><div><h1>Карта рассадки</h1><p>Расставьте столы по плану площадки и распределите гостей.</p></div>
      <button className="btn primary" onClick={() => file.current?.click()} disabled={uploading}>
        <ImagePlus size={18} /> {uploading ? 'Загружаем…' : plan.floor ? 'Заменить план' : 'Загрузить план'}
      </button>
      <input ref={file} type="file" hidden aria-label="Файл схемы площадки" accept="image/png,image/jpeg" onChange={event => {
        void handleFile(event.target.files?.[0]);
        event.target.value = '';
      }} />
    </header>

    <div className="stats seating-stats">
      <div><Armchair size={19} /><span>Мест за столами</span><strong>{tables.reduce((sum, table) => sum + table.capacity, 0)}</strong></div>
      <div><UsersRound size={19} /><span>Рассажено</span><strong>{seated} из {attending.length}</strong></div>
      <div><MapPinned size={19} /><span>Без места</span><strong>{unseated.length}</strong></div>
    </div>

    <div className="seating-grid">
      <section className="panel map-panel" ref={mapPanel}>
        <div className="map-toolbar">
          <div className="map-title"><h2>План площадки</h2><p>{plan.floor ? plan.floor.name : 'Черновик · можно загрузить PNG или JPEG'}</p></div>
          <label className="add-select"><Plus size={17} /><select aria-label="Добавить объект" value="" onChange={event => {
            if (event.target.value) open(objectEditor(plan, undefined, event.target.value as ObjectKind));
          }}><option value="" disabled>Добавить объект</option>
            {Object.entries(objectLabels).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}
          </select></label>
        </div>
        {activeGuest && <div className="selection-banner" role="status"><span>Выберите стол для гостя <strong>{activeGuest.name}</strong></span>
          <button className="icon-btn" aria-label="Отменить выбор гостя" onClick={() => selectGuest(null)}><X size={16} /></button>
        </div>}
        <div className={`map-window${activeGuest ? ' assigning' : ''}`}>
          <div ref={canvas} className={`venue-canvas${background ? ' with-image' : ''}`} style={{ width: `${zoom}%`, aspectRatio: plan.floor?.ratio ?? 1.58 }}>
            {background && <img className="venue-image" src={background} alt="Загруженный план площадки" draggable={false} />}
            {!plan.objects.length && !background && <p className="canvas-empty"><MapPinned size={28} />Добавьте первый стол</p>}
            {plan.objects.map(item => {
              const occupants = guestsAt(item.id).length;
              const table = isTable(item);
              const position = dragging?.id === item.id ? dragging : item;
              const style: CSSProperties = {
                left: `${position.x * 100}%`, top: `${position.y * 100}%`,
                width: `${item.width * 100}%`, height: `${item.height * 100}%`,
                transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
              };
              return <button type="button" key={item.id} style={style}
                className={`map-object object-${item.kind}${selectedObject === item.id ? ' selected' : ''}${activeGuest && table && occupants < item.capacity ? ' available' : ''}`}
                aria-label={table ? `${item.name}, занято ${occupants} из ${item.capacity}` : item.name}
                onPointerDown={event => startDrag(event, item)} onPointerMove={event => updateDrag(event, item)}
                onPointerUp={event => endDrag(event, item)} onPointerCancel={event => endDrag(event, item, true)}
                onKeyDown={event => {
                  if (activeGuest || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                  event.preventDefault();
                  const dx = event.key === 'ArrowLeft' ? -.025 : event.key === 'ArrowRight' ? .025 : 0;
                  const dy = event.key === 'ArrowUp' ? -.025 : event.key === 'ArrowDown' ? .025 : 0;
                  void change('objects', item.id, { ...item, ...moveTo(item, item.x + dx, item.y + dy) });
                }} onClick={() => void pickObject(item)}>
                {item.kind === 'stage' && <Mic2 size={15} />}
                {item.kind === 'dance' && <Sparkles size={17} />}
                {item.kind === 'entrance' && <DoorOpen size={14} />}
                <strong>{item.name}</strong>{table && <small>{occupants} / {item.capacity}</small>}
              </button>;
            })}
          </div>
        </div>
        <div className="map-footer">
          <div className="zoom-controls" aria-label="Масштаб карты">
            <button className="icon-btn" aria-label="Уменьшить" disabled={zoom <= 100} onClick={() => setZoom(zoom - 25)}><Minus size={16} /></button>
            <button className="text-btn" title="Сбросить масштаб" onClick={() => setZoom(100)}>{zoom}%</button>
            <button className="icon-btn" aria-label="Увеличить" disabled={zoom >= 250} onClick={() => setZoom(zoom + 25)}><Plus size={16} /></button>
          </div>
          {plan.floor && <button className="text-btn" onClick={() => {
            if (!confirmClear) setConfirmClear(true);
            else void clearImage().finally(() => setConfirmClear(false));
          }}><RotateCcw size={14} />{confirmClear ? 'Убрать фон, подтвердить' : 'Убрать фон'}</button>}
        </div>
      </section>

      <aside className="seat-aside">
        <section className="panel">
          <div className="panel-heading"><div><h2>Без места</h2><p>Выберите гостя, затем стол.</p></div><span className="count-badge">{unseated.length}</span></div>
          {!unseated.length && <Empty>Все ожидаемые гости рассажены.</Empty>}
          <div className="pick-list">
            {unseated.map(guest => <button key={guest.id} className={activeGuest?.id === guest.id ? 'active' : ''}
              onClick={() => {
                const selected = activeGuest?.id === guest.id ? null : guest.id;
                selectGuest(selected);
                if (selected) mapPanel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }} aria-pressed={activeGuest?.id === guest.id}>
              <span>{guest.name}</span><small>{statusLabels[guest.status]}</small>
            </button>)}
          </div>
        </section>
        <section className="panel">
          {activeObject ? <>
            <div className="panel-heading"><div><h2>{activeObject.name}</h2><p>{isTable(activeObject) ? `${activeObject.capacity - guestsAt(activeObject.id).length} свободных мест` : objectLabels[activeObject.kind]}</p></div>
              <button className="icon-btn" aria-label="Настроить объект" onClick={() => open(objectEditor(plan, activeObject))}><Settings2 size={18} /></button>
            </div>
            <div className="pick-list table-guests">
              {guestsAt(activeObject.id).map(guest => <div key={guest.id}><span>{guest.name}</span><button className="icon-btn" aria-label={`Убрать ${guest.name} со стола`}
                onClick={() => void change('guests', guest.id, { ...guest, tableId: null })}><X size={15} /></button></div>)}
            </div>
          </> : <div className="panel-heading"><div><h2>Объекты</h2><p>Нажмите на объект, чтобы настроить его.</p></div></div>}
          <div className="object-list">
            {plan.objects.map(item => <div key={item.id}>
              <button className="text-btn" onClick={() => void pickObject(item)}>{item.name}</button>
              <EditButton label={`Настроить ${item.name}`} onClick={() => open(objectEditor(plan, item))} />
            </div>)}
          </div>
        </section>
      </aside>
    </div>
  </>;
}
