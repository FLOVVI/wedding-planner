import { createRoot } from 'react-dom/client';
import { publicSite } from './api';
import { App } from './App';
import { PublicPage } from './PublicPage';
import './styles.css';

createRoot(document.getElementById('root')!).render(publicSite ? <PublicPage /> : <App />);
