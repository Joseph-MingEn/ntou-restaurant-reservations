import { bookingTables, cancelBooking, createBooking, diningTime, endTime, getAvailability, isActive, MAX_PARTY, moveBooking, TIMES, today } from './reservations.js?v=3';

const reply = text => ({ type: 'text', text });
const help = now => reply(
  `可以查詢空桌、訂位、取消或分享定位。\n\n查詢 ${today(now)}\n訂位 YYYY-MM-DD 12:00 2 王小明 0912000000\n我的訂位\n改期 訂位編號 YYYY-MM-DD 12:00 2\n取消 訂位編號\n定位 訂位編號`
);

export function handleLineMessage(state, message, { user, now = new Date(), createId }) {
  try {
    if (message.type === 'location') return saveLocation(state, user, message, now);
    if (message.type !== 'text') return help(now);
    const [command, ...fields] = message.text.normalize('NFKC').trim().split(/\s+/);
    const [date, time, party, name, ...contact] = fields;
    if (command === '查詢' && fields.length >= 1 && fields.length <= 2) {
      const lines = (time ? [time] : TIMES).map(start => {
        const info = getAvailability(state.bookings, date, start, now);
        const status = info.open
          ? `可接 ${info.seats} 人（最大單組 ${info.maxParty} 人、兩人桌 ${info.two}、四人桌 ${info.four}）`
          : '已截止';
        return `${start}–${endTime(start)}｜${status}`;
      });
      return reply(`${date}\n${lines.join('\n')}`);
    }
    if (command === '訂位' && fields.length >= 5) {
      if (Number(party) > MAX_PARTY) return reply(`${MAX_PARTY + 1} 人以上請直接聯繫店家安排。`);
      const id = createId();
      const separateAt = fields.indexOf('|', 3);
      const customer = separateAt === -1 ? name : fields.slice(3, separateAt).join(' ');
      const phoneOrEmail = separateAt === -1 ? contact.join(' ') : fields.slice(separateAt + 1).join(' ');
      const booking = createBooking(state.bookings, {
        date, time, party: Number(party), name: customer, contact: phoneOrEmail,
      }, { now, id, owner: user });
      return reply(`訂位成功！\n${date} ${time}–${endTime(time)}｜${booking.party} 人｜${bookingTables(booking).join('＋')} 桌\n訂位編號 ${id}\n\n需要時可傳送「定位 ${id}」，也可略過。`);
    }
    if (command === '我的訂位' && fields.length === 0) {
      const mine = state.bookings.filter(item => item.owner === user && isActive(item) &&
        diningTime(item.date, item.time) + 7_200_000 > +now)
        .sort((first, second) => diningTime(first.date, first.time) - diningTime(second.date, second.time));
      const summary = mine.slice(0, 40).map(item => `${item.id}｜${item.date} ${item.time}｜${item.party} 人`).join('\n');
      return reply(summary || '目前沒有有效訂位。');
    }
    if (command === '改期' && fields.length === 4) {
      const [id, newDate, newTime, newParty] = fields;
      const booking = moveBooking(state.bookings, id.toUpperCase(), user,
        { date: newDate, time: newTime, party: Number(newParty) }, now);
      const pending = state.locationRequests[user];
      if (pending?.id === booking.id) delete state.locationRequests[user];
      return reply(`改期成功！\n${booking.id}｜${newDate} ${newTime}–${endTime(newTime)}｜${booking.party} 人｜${bookingTables(booking).join('＋')} 桌`);
    }
    if (command === '取消' && fields.length === 1) {
      const booking = cancelBooking(state.bookings, date.toUpperCase(), user);
      return reply(`已取消訂位 ${booking.id}。`);
    }
    if (command === '定位' && fields.length === 1) return requestLocation(state, user, date.toUpperCase(), now);
    return help(now);
  } catch (error) {
    return reply(error.message);
  }
}

function eligibleBooking(state, user, id, now) {
  return state.bookings.find(item =>
    item.id === id && item.owner === user && isActive(item) &&
    diningTime(item.date, item.time) + 7_200_000 > +now
  );
}

function requestLocation(state, user, id, now) {
  const booking = eligibleBooking(state, user, id, now);
  if (!booking) return reply('找不到你仍有效的訂位。');
  state.locationRequests[user] = { id, until: +now + 600_000 };
  return {
    ...reply(`你可在 10 分鐘內分享一個位置給店家，附在訂位 ${id}。也可略過。`),
    quickReply: { items: [{ type: 'action', action: { type: 'location', label: '分享定位' } }] },
  };
}

function saveLocation(state, user, message, now) {
  const pending = Object.hasOwn(state.locationRequests, user) ? state.locationRequests[user] : undefined;
  const booking = pending?.until > +now && eligibleBooking(state, user, pending.id, now);
  if (!booking) return reply('請先傳送「定位 訂位編號」來選取你的訂位。');
  const { latitude, longitude } = message;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    return reply('定位資料無效，請再分享一次。');
  }
  booking.location = { latitude, longitude, sharedAt: now.toISOString() };
  delete state.locationRequests[user];
  return reply(`已收到訂位 ${booking.id} 的位置，店家可以在後台查看。`);
}
