import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TelegramCatalog, TelegramForm, TelegramProgram } from './TelegramPages';
import './styles.css';

const params = new URLSearchParams(location.search);
const form = params.get('telegram');
const snapshot = new URLSearchParams(location.hash.slice(1));
const program = snapshot.get('program');
const catalog = snapshot.get('catalog');
const content = form === 'create' || form === 'block' || form === 'guest' || form === 'task'
  ? <TelegramForm kind={form} eventId={params.get('event')} />
  : program ? <TelegramProgram encoded={program} /> : catalog ? <TelegramCatalog encoded={catalog} /> : <App />;

createRoot(document.getElementById('root')!).render(content);
