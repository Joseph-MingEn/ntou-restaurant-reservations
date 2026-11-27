import { readBookingRequest, readParty } from './line-language.js?v=16';
import { bookingTables, cancelBooking, createBooking, DEADLINE_MINUTES, diningTime, endTime, getAvailability, isActive, MAX_PARTY, MEALS, moveBooking, TIMES, today } from './reservations.js?v=16';

const reply = text => ({ type: 'text', text });
const BOOKING_DATE_ACTION = 'booking-date';
const BOOKING_DRAFT_MS = 10 * 60_000;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const taipeiClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function cutoffTime(date, time) {
  return taipeiClock.format(diningTime(date, time) - DEADLINE_MINUTES * 60_000);
}

function clockMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function durationText(minutes) {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return [hours && hours + ' 小時', remaining && remaining + ' 分鐘'].filter(Boolean).join(' ');
}

function withActions(text, actions) {
  return {
    ...reply(text),
    quickReply: { items: actions.map(action => ({ type: 'action', action })) },
  };
}

function selectDate(now) {
  const tomorrow = today(new Date(+now + 86_400_000));
  return withActions(
    `請選擇用餐日期。也可以傳送「訂位 ${tomorrow}」並換成你要用餐的日期。`,
    [{ type: 'datetimepicker', label: '選擇用餐日期', data: BOOKING_DATE_ACTION, mode: 'date', min: today(now), initial: tomorrow }],
  );
}

function selectTime(state, date, user, now, { meal, party, clearDraft = true } = {}) {
  const choices = (meal ? MEALS[meal].times : TIMES)
    .map(time => ({ time, ...getAvailability(state.bookings, date, time, now) }))
    .filter(option => option.open && option.maxParty >= (party ?? 1));
  if (clearDraft && state.bookingDrafts) delete state.bookingDrafts[user];

  if (!choices.length) {
    const next = selectDate(now);
    return { ...next, text: `${date}${meal ? '的' + MEALS[meal].label : ''}${party ? '沒有能安排 ' + party + ' 人的' : '沒有'}可預約入座時間。
${next.text}` };
  }
  const lines = choices.map(({ time, maxParty }) => `${time}–${endTime(time)}｜最大單組 ${maxParty} 人｜${cutoffTime(date, time)} 前訂位`);
  const actions = choices.map(({ time }) => ({
    type: 'message',
    label: `${MEALS.lunch.times.includes(time) ? '午餐' : '晚餐'} ${time}`,
    text: `訂位 ${date} ${time}`,
  }));
  return withActions(
    `${date}｜請選擇入座時間（台灣時間）

${lines.join('\n')}

也可以傳送「訂位 ${date} ${choices[0].time}」，把時間換成你想選的時段。`,
    actions,
  );
}

function explainUnavailableTime(state, date, time, user, now, options = {}) {
  if (!CLOCK.test(time ?? '')) return reply('時間請用 24 小時格式，例如 17:30。');
  const mealKey = options.meal ?? (time >= MEALS.dinner.times[0] ? 'dinner'
    : time <= endTime(MEALS.lunch.times.at(-1)) ? 'lunch' : undefined);
  const alternatives = selectTime(state, date, user, now, { ...options, meal: mealKey });
  let explanation = `想在 ${time} 入座的話，請改選下方時段。入座時段每 30 分鐘開放一個選項。`;
  if (mealKey) {
    const meal = MEALS[mealKey];
    const last = meal.times.at(-1);
    if (time > last) {
      const earlier = durationText(clockMinutes(time) - clockMinutes(last));
      explanation = `${meal.label}營業到 ${endTime(last)}。每組保留桌位 2 小時，最晚 ${last} 入座，比 ${time} 提早 ${earlier}。若選最晚的入座時段，請在當天 ${cutoffTime(date, last)} 前完成訂位（入座前 ${DEADLINE_MINUTES} 分鐘）。`;
    }
  }
  return { ...alternatives, text: explanation + '\n\n' + alternatives.text };
}

function prepareBooking(state, date, time, user, now, options = {}) {
  if (!TIMES.includes(time) || (options.meal && !MEALS[options.meal].times.includes(time))) {
    return explainUnavailableTime(state, date, time, user, now, options);
  }
  const availability = getAvailability(state.bookings, date, time, now);
  if (!availability.open || availability.maxParty < (options.party ?? 1)) {
    const choices = selectTime(state, date, user, now, options);
    const reason = availability.open
      ? (options.party ? `這個時段目前無法安排 ${options.party} 人。` : '此入座時間已額滿。')
      : `已過訂位截止。這個時段需在當天 ${cutoffTime(date, time)} 前完成訂位（入座前 ${DEADLINE_MINUTES} 分鐘）。`;
    return { ...choices, text: reason + '\n\n' + choices.text };
  }
  state.bookingDrafts ??= {};
  state.bookingDrafts[user] = { date, time, until: +now + BOOKING_DRAFT_MS };
  return reply(`已選擇 ${date} ${time}–${endTime(time)}，目前最大單組可接 ${availability.maxParty} 人。
請在當天 ${cutoffTime(date, time)} 前完成訂位（入座前 ${DEADLINE_MINUTES} 分鐘）。

請在 10 分鐘內傳送「確認 人數 姓名 電話或 Email」。
例如「確認 ${options.party ?? 2} 王小明 guest@example.test」。
如要換時間，可以再次傳送「訂位 ${date}」。`);
}

function queryAvailability(state, date, time, user, now, { meal, party } = {}) {
  if (time && (!TIMES.includes(time) || (meal && !MEALS[meal].times.includes(time)))) {
    return explainUnavailableTime(state, date, time, user, now, { meal, party, clearDraft: false });
  }
  const lines = (time ? [time] : meal ? MEALS[meal].times : TIMES).map(start => {
    const info = getAvailability(state.bookings, date, start, now);
    const deadline = cutoffTime(date, start);
    let status = `已截止（${deadline} 前訂位）`;
    if (info.open) {
      const capacity = party
        ? (info.maxParty >= party ? `${party} 人可訂` : `目前無法安排 ${party} 人`)
        : `可接 ${info.seats} 人`;
      status = `${capacity}（最大單組 ${info.maxParty} 人、兩人桌 ${info.two}、四人桌 ${info.four}）｜${deadline} 前訂位`;
    }
    return `${start}–${endTime(start)}｜${status}`;
  });
  return reply(`${date}\n${lines.join('\n')}`);
}

function finishBooking(state, date, time, details, { user, now, createId }) {
  const [party, name, ...contact] = details;
  if (!TIMES.includes(time)) return explainUnavailableTime(state, date, time, user, now);
  if (!getAvailability(state.bookings, date, time, now).open) {
    return reply(`已過訂位截止。這個時段需在當天 ${cutoffTime(date, time)} 前完成訂位（入座前 ${DEADLINE_MINUTES} 分鐘）。`);
  }
  const partySize = readParty(party);
  if (partySize > MAX_PARTY) return reply(`${MAX_PARTY + 1} 人以上請直接聯繫店家安排。`);
  const separateAt = details.indexOf('|', 1);
  const customer = separateAt === -1 ? name : details.slice(1, separateAt).join(' ');
  const phoneOrEmail = separateAt === -1 ? contact.join(' ') : details.slice(separateAt + 1).join(' ');
  const id = createId();
  const booking = createBooking(state.bookings, {
    date, time, party: partySize, name: customer, contact: phoneOrEmail,
  }, { now, id, owner: user });
  if (state.bookingDrafts) delete state.bookingDrafts[user];
  return reply(`訂位成功！
${date} ${time}–${endTime(time)}｜${booking.party} 人｜${bookingTables(booking).join('＋')} 桌
訂位編號 ${id}`);
}
function help(now) {
  const date = today(new Date(+now + 86_400_000));
  return reply(`訂位指令 /help

可以直接問「明天晚上五點半，五位，有位嗎？」或傳「我想訂明晚六點，四位」。使用下列完整指令時，請用空格分隔資料。

查詢空位
查詢 ${date}
查詢 ${date} 17:00

選日期和入座時間
訂位
訂位 ${date}
選好時間後，回覆「確認 人數 姓名 電話或 Email」。

一次輸入完整訂位（日期 時間 人數 姓名 電話或 Email）
訂位 ${date} 17:00 5 王小明 guest@example.test

查看自己的有效訂位
我的訂位
新訂位使用 6 位數字編號，例如 482731。

改日期、時間或人數
改期 訂位編號 ${date} 17:30 4

取消訂位
取消 訂位編號

選填定位（讓店家看到你主動分享的地圖位置）
定位 訂位編號

每組 1–${MAX_PARTY} 人，最多用餐 2 小時，入座前 ${DEADLINE_MINUTES} 分鐘截止。需要時可再傳 /help。`);
}

export function handleLineMessage(state, message, { user, now = new Date(), createId }) {
  try {
    if (message.type === 'location') return saveLocation(state, user, message, now);
    if (message.type === 'postback' && message.data === BOOKING_DATE_ACTION) {
      return selectTime(state, message.params?.date, user, now);
    }
    if (message.type !== 'text') return help(now);
    const text = message.text.normalize('NFKC').trim();
    const [command, ...fields] = text.split(/\s+/);
    if (command.toLowerCase() === '/help' && fields.length === 0) return help(now);
    const [date, time] = fields;
    if (command === '查詢' && DATE.test(date ?? '') && (fields.length === 1 || fields.length === 2 && CLOCK.test(time ?? ''))) {
      return queryAvailability(state, date, time, user, now);
    }
    if (command === '訂位' && fields.length === 0) {
      if (state.bookingDrafts) delete state.bookingDrafts[user];
      return selectDate(now);
    }
    if (command === '訂位' && DATE.test(date ?? '') && (fields.length === 1 || CLOCK.test(time ?? ''))) {
      if (fields.length === 1) return selectTime(state, date, user, now);
      if (fields.length === 2) return prepareBooking(state, date, time, user, now);
      if (fields.length >= 5) {
        return finishBooking(state, date, time, fields.slice(2), { user, now, createId });
      }
      if (fields.length === 3 && Number.isInteger(readParty(fields[2]))) {
        return prepareBooking(state, date, time, user, now, { party: readParty(fields[2]) });
      }
      return reply('請填寫人數、姓名和電話或 Email，或重新傳送「訂位」來選時間。');
    }
    if (command === '確認') {
      const draft = state.bookingDrafts?.[user];
      if (!draft || draft.until <= +now) return reply('請先傳送「訂位」，重新選擇日期與入座時間。');
      if (fields.length < 3) return reply('請傳送「確認 人數 姓名 電話或 Email」。');
      return finishBooking(state, draft.date, draft.time, fields, { user, now, createId });
    }
    const request = readBookingRequest(text, now);
    if (request?.kind === 'mine') {
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
    return request ? answerRequest(state, request, user, now) : help(now);
  } catch (error) {
    return reply(error.message);
  }
}

function answerRequest(state, request, user, now) {
  const { kind, date, time, meal, party } = request;
  if (kind === 'manage') return reply('請先傳「我的訂位」取得訂位編號，再用 /help 查看改期或取消格式。');
  if (party > MAX_PARTY) return reply(`${MAX_PARTY + 1} 人以上請直接聯繫店家安排。`);
  if (party === 0) return reply(`每組請選 1 至 ${MAX_PARTY} 人。`);
  if (time === null) return reply('這個時間格式有誤。可以試「明天晚上五點半」或「明天 17:30」。');
  if (kind === 'deadline') {
    if (!date || !time) return reply(`請在入座前 ${DEADLINE_MINUTES} 分鐘完成訂位。告訴我想用餐的日期和時間，我可以告訴你確切的截止時間。`);
    if (!TIMES.includes(time) || (meal && !MEALS[meal].times.includes(time))) {
      return explainUnavailableTime(state, date, time, user, now, { meal, party, clearDraft: false });
    }
    const status = getAvailability(state.bookings, date, time, now).open ? '' : '這個時段已截止。';
    return reply(`${date} ${time} 入座，請在當天 ${cutoffTime(date, time)} 前完成訂位（提前 ${DEADLINE_MINUTES} 分鐘）。${status}`);
  }
  if (!date) return selectDate(now);
  if (kind === 'query') return queryAvailability(state, date, time, user, now, { meal, party });
  return time ? prepareBooking(state, date, time, user, now, { meal, party })
    : selectTime(state, date, user, now, { meal, party });
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
