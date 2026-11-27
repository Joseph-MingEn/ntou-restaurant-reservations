export const MEALS = {
  lunch: { label: '午餐', hours: '11:30–14:30', times: ['11:30', '12:00', '12:30'] },
  dinner: { label: '晚餐', hours: '17:00–20:00', times: ['17:00', '17:30', '18:00'] },
};
export const TIMES = Object.values(MEALS).flatMap(meal => meal.times);
export const TABLES = [2, 4].flatMap((capacity, group) =>
  Array.from({ length: 6 }, (_, index) => ({
    id: `${group === 0 ? 'A' : 'B'}0${index + 1}`, capacity,
  }))
);
export const MAX_PARTY = 12;

function adjacent(first, second) {
  const sameRow = first.id[0] === second.id[0];
  const columnDistance = Math.abs(Number(first.id.slice(1)) - Number(second.id.slice(1)));
  return sameRow ? columnDistance === 1 : columnDistance === 0;
}

const configurations = new Map();
for (const table of TABLES) configurations.set(table.id, [table]);
for (let size = 1; size < 3; size++) {
  for (const group of [...configurations.values()].filter(item => item.length === size)) {
    for (const table of TABLES) {
      if (group.includes(table) || !group.some(member => adjacent(member, table))) continue;
      const next = [...group, table].sort((first, second) => first.id.localeCompare(second.id));
      configurations.set(next.map(member => member.id).join(','), next);
    }
  }
}
const seatingOptions = [...configurations.values()].map(group => ({
  ids: group.map(table => table.id),
  capacity: group.reduce((sum, table) => sum + table.capacity, 0),
})).sort((first, second) =>
  first.capacity - second.capacity || first.ids.length - second.ids.length ||
  first.ids.join(',').localeCompare(second.ids.join(','))
);

export function createBookingNumber(records) {
  const first = 100_000;
  const count = 900_000;
  const used = new Set(records.filter(item => /^\d{6}$/.test(item.id)).map(item => item.id));
  let offset = Math.floor(Math.random() * count);
  for (let attempt = 0; attempt < count; attempt++) {
    const id = String(first + offset);
    if (!used.has(id)) return id;
    offset = (offset + 1) % count;
  }
  throw new Error('訂位編號已用完，請聯繫店家。');
}

export function bookingTables(booking) {
  return booking.tableIds ?? [booking.tableId];
}

const MINUTE = 60_000;
const DURATION = 120 * MINUTE;
export const DEADLINE_MINUTES = 30;
const taipeiDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function today(now = new Date()) {
  return taipeiDate.format(now);
}

export function diningTime(date, time) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('日期格式為 YYYY-MM-DD。');
  }
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    throw new Error('請選擇有效日期。');
  }
  if (!TIMES.includes(time)) throw new Error('請選擇營業時間內的入座時段。');
  return Date.parse(`${date}T${time}:00+08:00`);
}

export function endTime(time) {
  const [hour, minute] = time.split(':');
  return `${String(Number(hour) + 2).padStart(2, '0')}:${minute}`;
}

export function getAvailability(records, date, time, now = new Date()) {
  const start = diningTime(date, time);
  const occupied = new Map();
  for (const booking of records) {
    if (booking.date !== date || !isActive(booking)) continue;
    const otherStart = diningTime(booking.date, booking.time);
    if (otherStart < start + DURATION && start < otherStart + DURATION) {
      for (const id of bookingTables(booking)) occupied.set(id, booking);
    }
  }
  const tables = TABLES.map(table => ({ ...table, occupied: occupied.has(table.id) }));
  const free = tables.filter(table => !table.occupied);
  const options = seatingOptions.filter(option => option.ids.every(id => !occupied.has(id)));
  return {
    tables, seats: free.reduce((sum, table) => sum + table.capacity, 0),
    two: free.filter(table => table.capacity === 2).length,
    four: free.filter(table => table.capacity === 4).length,
    maxParty: options.at(-1)?.capacity ?? 0,
    open: now.getTime() < start - DEADLINE_MINUTES * MINUTE,
  };
}

export function createBooking(records, request, { now = new Date(), id, owner = '' } = {}) {
  const { date, time, party } = request;
  const availability = getAvailability(records, date, time, now);
  if (!Number.isInteger(party) || party < 1 || party > MAX_PARTY) throw new Error('每組限 1 至 12 人。');
  const name = typeof request.name === 'string' ? request.name.trim() : '';
  const contact = typeof request.contact === 'string' ? request.contact.trim() : '';
  if (!name || name.length > 40) throw new Error('請輸入姓名（最多 40 字）。');
  const phone = /^\+?[\d\s()-]+$/.test(contact) && /^\d{8,15}$/.test(contact.replace(/\D/g, ''));
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  if (contact.length > 100 || (!phone && !email)) throw new Error('請輸入有效的電話或 Email。');
  if (!availability.open) throw new Error('已過訂位截止時間（入座前 30 分鐘）。');
  const occupied = new Set(availability.tables.filter(table => table.occupied).map(table => table.id));
  const option = seatingOptions.find(item => item.capacity >= party && item.ids.every(id => !occupied.has(id)));
  if (!option) throw new Error('此時段沒有足夠的相鄰空桌，請改選時段。');
  const booking = { id, date, time, party, name, contact, tableId: option.ids[0], owner };
  if (option.ids.length > 1) booking.tableIds = option.ids.slice();
  records.push(booking);
  return booking;
}

export function isActive(booking) {
  return !booking.cancelled && booking.status !== 'no-show';
}

export function moveBooking(records, id, owner, changes, now = new Date()) {
  const index = records.findIndex(item => item.id === id && item.owner === owner);
  const original = records[index];
  if (!original || !isActive(original) || original.status === 'arrived') throw new Error('找不到可改期的訂位。');
  if (!getAvailability([], original.date, original.time, now).open) {
    throw new Error('原訂位已過可改期時間（入座前 30 分鐘）。');
  }
  const others = records.filter((_, position) => position !== index);
  const booking = createBooking(others, { ...original, ...changes }, { now, id, owner });
  records[index] = booking;
  return booking;
}

export function cancelBooking(records, id, owner) {
  const booking = records.find(item => item.id === id && (owner === undefined || item.owner === owner));
  if (!booking || booking.status) throw new Error('找不到這筆訂位。');
  booking.cancelled = true;
  delete booking.location;
  return booking;
}

export function getService(records, date, time, now = new Date()) {
  const availability = getAvailability(records, date, time, now);
  const meal = Object.values(MEALS).find(item => item.times.includes(time));
  const bookings = records
    .filter(item => item.date === date && meal.times.includes(item.time))
    .sort((first, second) => first.time.localeCompare(second.time));
  const active = bookings.filter(isActive);
  const arrivals = meal.times.map(slot => ({
    time: slot, guests: active.filter(item => item.time === slot).reduce((sum, item) => sum + item.party, 0),
  }));
  return {
    availability, bookings, arrivals, parties: active.length,
    guests: arrivals.reduce((sum, slot) => sum + slot.guests, 0),
  };
}

export function setArrival(records, id, status, now = new Date()) {
  const booking = records.find(item => item.id === id && !item.cancelled && !item.status);
  if (!booking) throw new Error('找不到可更新的訂位。');
  const start = diningTime(booking.date, booking.time);
  if (status === 'arrived' && (+now < start - DEADLINE_MINUTES * MINUTE || +now >= start + DURATION)) {
    throw new Error('入座前 30 分鐘至用餐結束前可報到。');
  }
  if (status === 'no-show' && +now < start) throw new Error('超過入座時間才能標記未到。');
  if (status !== 'arrived' && status !== 'no-show') throw new Error('無效的訂位狀態。');
  booking.status = status;
  if (status === 'no-show') delete booking.location;
  return booking;
}
