import { today } from './reservations.js?v=14';

const DAY_MS = 86_400_000;
const digits = '零一二三四五六七八九';
const numberPattern = '[0-9零〇一二兩两三四五六七八九十]+';

function readNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const text = value?.replaceAll('〇', '零').replace(/[兩两]/g, '二');
  if (!text) return NaN;
  if (text.length === 1 && text !== '十') return digits.indexOf(text);
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  return tens ? (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0) : NaN;
}

export function readParty(value) {
  const match = new RegExp(`^(${numberPattern})(?:\\s*(?:個人|人|位))?$`).exec(value ?? '');
  return match ? readNumber(match[1]) : NaN;
}

function dateFromText(text, now) {
  const current = today(now);
  const pad = value => value.padStart(2, '0');
  const full = text.match(/(?:^|[^\d])(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?!\d)/);
  if (full) return full[1] + '-' + pad(full[2]) + '-' + pad(full[3]);
  const short = text.match(/(?:^|[^\d])(\d{1,2})[\/月](\d{1,2})(?!\d)/);
  if (short) return current.slice(0, 5) + pad(short[1]) + '-' + pad(short[2]);
  if (/後天|後晚/.test(text)) return today(new Date(+now + 2 * DAY_MS));
  if (/明天|明晚/.test(text)) return today(new Date(+now + DAY_MS));
  if (/今天|今晚/.test(text)) return current;

  const weekday = text.match(/(下(?:個)?)?(?:週|星期|禮拜)([一二三四五六日天])/);
  if (!weekday) return undefined;
  const target = '日一二三四五六'.indexOf(weekday[2].replace('天', '日'));
  const day = new Date(current + 'T00:00:00Z').getUTCDay();
  const daysAhead = weekday[1]
    ? 7 - ((day + 6) % 7) + ((target + 6) % 7)
    : (target - day + 7) % 7;
  return today(new Date(+now + daysAhead * DAY_MS));
}

function timeFromText(text, meal) {
  const clock = text.match(/(?:^|[^\d])([0-9]{1,2}):([0-9]{2})(?!\d)/);
  const spoken = text.match(new RegExp(`(${numberPattern})\\s*[點点時时](?:\\s*(半|[一三]刻)|\\s*(${numberPattern})\\s*分)?`));
  if (!clock && !spoken) return undefined;
  let hour = readNumber((clock ?? spoken)[1]);
  const minutes = clock ? Number(clock[2]) : readMinutes(spoken[2] ?? spoken[3]);
  if (meal === 'dinner' && hour >= 1 && hour <= 11) hour += 12;
  if (meal === 'lunch' && /中午|午間|午餐/.test(text) && hour > 0 && hour < 6) hour += 12;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  return [hour, minutes].map(value => String(value).padStart(2, '0')).join(':');
}

function readMinutes(value) {
  const fixed = { 半: 30, 一刻: 15, 三刻: 45 };
  return value ? (fixed[value] ?? readNumber(value)) : 0;
}

export function readBookingRequest(text, now) {
  if (/我的(?:訂位|預約)|我(?:有|已經)?訂了什麼|我.*有(?:沒有)?訂位/.test(text)) return { kind: 'mine' };
  if (/取消|改期|更改.*(?:訂位|預約)|(?:想|要)改.*(?:訂位|預約)|換(?:日期|時間)/.test(text)) return { kind: 'manage' };
  const meal = /晚上|晚餐|晚間|傍晚|下午|今晚|明晚|後晚/.test(text) ? 'dinner'
    : /中午|午間|午餐|早上|上午/.test(text) ? 'lunch' : undefined;
  const date = dateFromText(text, now);
  const time = timeFromText(text, meal);
  const partyWord = text.match(new RegExp(`(${numberPattern})\\s*(?:個人|人|位)`));
  const party = partyWord ? readParty(partyWord[1]) : undefined;
  const ordering = /訂位|預約|訂桌|(?:想|要|幫我)訂/.test(text);
  const asking = /查詢|(?:有沒有|有|剩下?|找)\s*(?:空位|座位|空桌|座|桌|位子|位)|空位|有空嗎|能訂嗎|可(?:以)?訂嗎/.test(text);
  if (/提早|提前|多久前|多久以前|截止|多早|幾點前|最晚幾點/.test(text) && (ordering || date || time)) {
    return { kind: 'deadline', date, time, meal, party };
  }
  if (asking) return { kind: 'query', date, time, meal, party };
  if (ordering || date || time !== undefined) return { kind: 'booking', date, time, meal, party };
  return undefined;
}
