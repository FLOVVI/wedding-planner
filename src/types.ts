export type Role = 'owner' | 'editor' | 'team';
export type Page = 'program' | 'seating' | 'guests' | 'budget' | 'tasks';
export type Status = 'confirmed' | 'waiting' | 'declined';
export type ObjectKind = 'round' | 'rectangle' | 'stage' | 'dance' | 'entrance';
export type BlockKind = 'soundcheck' | 'ceremony' | 'dance' | 'live' | 'dj' | 'other';

export interface Settings {
  name: string;
  date: string | null;
  venue: string;
  timezone: string;
  banquetPrice: number;
}

export interface Guest {
  id: string;
  name: string;
  family: string;
  status: Status;
  tableId: string | null;
}

export interface FloorObject {
  id: string;
  name: string;
  kind: ObjectKind;
  capacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface Artist {
  id: string;
  name: string;
  role: string;
  contact: string;
  fee: number;
  sound: string;
}

export interface Block {
  id: string;
  title: string;
  kind: BlockKind;
  start: string;
  nextDay?: boolean;
  duration: number;
  responsible: string;
  artistId: string | null;
  tracks: string[];
  notes: string;
}

export interface ProgramBlock extends Omit<Block, 'artistId'> {
  artistName: string;
  artistSound: string;
  conflict: boolean;
}

export interface Expense {
  id: string;
  name: string;
  amount: number;
}

export interface Payment extends Expense {
  source: string;
  due: string | null;
  paid: boolean;
}

export interface Task {
  id: string;
  name: string;
  due: string;
  done: boolean;
}

export interface Budget {
  confirmed: number;
  expected: number;
  confirmedBanquet: number;
  expectedBanquet: number;
  total: number;
  paid: number;
  remaining: number;
}

export interface Plan {
  revision: number;
  settings: Settings;
  floor: { name: string; ratio: number; version: number } | null;
  guests: Guest[];
  objects: FloorObject[];
  artists: Artist[];
  blocks: Block[];
  program: ProgramBlock[];
  expenses: Expense[];
  payments: Payment[];
  tasks: Task[];
  budget: Budget;
}

export interface Program {
  revision: number;
  settings: Omit<Settings, 'banquetPrice'>;
  blocks: ProgramBlock[];
}

export interface Config {
  demo: boolean;
  botUsername: string;
}

export interface Session {
  role: Role;
  token: string;
}

export interface Reminders {
  connected: boolean;
  enabled: boolean;
  history: { id: number; message: string; created: string; status: string }[];
}

export type Collection = 'blocks' | 'artists' | 'objects' | 'guests' | 'expenses' | 'payments' | 'tasks';
export type FormValue = string | number | boolean | null | string[];
export type FormData = Record<string, FormValue>;

export const objectLabels: Record<ObjectKind, string> = {
  round: 'Круглый стол', rectangle: 'Прямоугольный стол', stage: 'Сцена',
  dance: 'Танцпол', entrance: 'Вход',
};

export const blockLabels: Record<BlockKind, string> = {
  soundcheck: 'Саундчек', ceremony: 'Церемония', dance: 'Первый танец',
  live: 'Выступление', dj: 'DJ-сет', other: 'Событие',
};

export const statusLabels: Record<Status, string> = {
  confirmed: 'Придёт', waiting: 'Ждём ответ', declined: 'Не придёт',
};

export const isTable = (object: FloorObject) => object.kind === 'round' || object.kind === 'rectangle';
export const money = (value: number) => `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
export const dateLabel = (value: string, year = false) => new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: year ? 'numeric' : undefined, timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

export function showTime(block: ProgramBlock, end = false) {
  const [hour, minute] = block.start.split(':').map(Number);
  const total = hour * 60 + minute + (block.nextDay ? 1440 : 0) + (end ? block.duration : 0);
  const format = (value: number) => value.toString().padStart(2, '0');
  const clock = `${format(Math.floor(total / 60) % 24)}:${format(total % 60)}`;
  return total >= 1440 ? `${clock} +${Math.floor(total / 1440)}` : clock;
}
