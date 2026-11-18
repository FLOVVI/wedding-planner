from datetime import date as calendar_date, datetime, time
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AnyHttpUrl, BaseModel, Field, StringConstraints, field_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=140)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Amount = Annotated[int, Field(ge=0, le=1_000_000_000)]


class Settings(BaseModel):
    name: Name = 'Наша свадьба'
    date: calendar_date | None = None
    venue: Text = ''
    timezone: str = 'Europe/Moscow'
    banquetPrice: Amount = 0

    @field_validator('timezone')
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('Укажите часовой пояс, например Europe/Moscow') from None
        return value


class Guest(BaseModel):
    name: Name
    family: Name | Literal[''] = ''
    status: Literal['waiting', 'confirmed', 'declined'] = 'waiting'
    tableId: str | None = None


class FloorObject(BaseModel):
    name: Name
    kind: Literal['round', 'rectangle', 'stage', 'dance', 'entrance']
    capacity: int = Field(default=0, ge=0, le=200)
    x: float = Field(default=.5, ge=0, le=1)
    y: float = Field(default=.5, ge=0, le=1)
    width: float = Field(default=.14, ge=.025, le=.7)
    height: float = Field(default=.17, ge=.025, le=.7)
    rotation: int = Field(default=0, ge=-180, le=180)


class Artist(BaseModel):
    name: Name
    category: Literal['music', 'venue', 'photo', 'host', 'food', 'decor', 'other'] = 'music'
    role: Text = ''
    contact: Text = ''
    fee: Amount = 0
    sound: Text = ''


class ProgramBlock(BaseModel):
    title: Name
    kind: Literal['welcome', 'ceremony', 'photo', 'dinner', 'toast', 'cake', 'soundcheck', 'dance', 'live', 'dj', 'other'] = 'other'
    start: time
    nextDay: bool = False
    duration: int = Field(ge=1, le=720)
    responsible: Text = ''
    artistId: str | None = None
    tracks: list[AnyHttpUrl] = Field(default_factory=list, max_length=15)
    notes: Text = ''

    @field_validator('start')
    @classmethod
    def local_minute(cls, value: time) -> time:
        if value.tzinfo is not None or value.second or value.microsecond:
            raise ValueError('Введите местное время с точностью до минуты')
        return value


class Expense(BaseModel):
    name: Name
    amount: Amount


class Payment(BaseModel):
    name: Name
    source: str = Field(max_length=128)
    amount: Amount
    due: calendar_date | None = None
    paid: bool = False


class Task(BaseModel):
    name: Name
    due: calendar_date
    done: bool = False


class TelegramLogin(BaseModel):
    initData: str = Field(min_length=1, max_length=8192)


class DemoLogin(BaseModel):
    user: Literal['owner', 'partner', 'team', 'visitor']
    invite: str | None = Field(default=None, max_length=64)


class Simulation(BaseModel):
    at: datetime


class Subscription(BaseModel):
    enabled: bool


COLLECTIONS = {
    'guests': Guest,
    'objects': FloorObject,
    'artists': Artist,
    'blocks': ProgramBlock,
    'expenses': Expense,
    'payments': Payment,
    'tasks': Task,
}
