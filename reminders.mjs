import { diningTime } from './site/reservations.js?v=8';
import { reminderRecipient } from './gmail.mjs';
import { VENUE_DETAILS } from './site/venue.js';

const MINUTE = 60_000;

function reminderPhase(booking, now) {
  if (booking.cancelled || booking.status || !reminderRecipient(booking.contact)) return;
  const remaining = diningTime(booking.date, booking.time) - now;
  if (remaining <= 0 || remaining > 120 * MINUTE) return;
  return remaining <= 30 * MINUTE ? '30 分鐘' : '2 小時';
}

export async function deliverReminders({ getState, commit, clock, sendReminder }) {
  const scanTime = +clock();
  const candidates = getState().bookings.filter(booking => reminderPhase(booking, scanTime));
  for (const { id } of candidates) {
    const state = getState();
    const booking = state.bookings.find(item => item.id === id);
    const now = +clock();
    const phase = reminderPhase(booking, now);
    if (!phase) continue;

    const key = [id, booking.date, booking.time, phase].join('|');
    const previous = state.reminders?.[key];
    if (previous && (!previous.retryAt || previous.retryAt > now)) continue;

    // Claim before calling Gmail so a restart during submission does not send twice.
    commit({ ...state, reminders: { ...state.reminders, [key]: { claimedAt: now } } });
    const stillCurrent = () => {
      const current = getState().bookings.find(item => item.id === id);
      return current?.date === booking.date && current.time === booking.time &&
        current.contact === booking.contact && current.party === booking.party &&
        reminderPhase(current, +clock()) === phase;
    };

    try {
      const outcome = await sendReminder({
        to: booking.contact,
        subject: '餐廳用餐提醒｜入座前 ' + phase,
        body: [
          '您好，提醒您即將用餐。',
          '',
          '訂位編號 ' + id,
          '用餐日期 ' + booking.date,
          '入座時間 ' + booking.time + '（台灣時間）',
          '用餐人數 ' + booking.party + ' 人',
          '',
          ...VENUE_DETAILS.split('\n'),
          '',
          '如需查看或更改訂位，請回到原 LINE 對話傳送 /help。',
        ].join('\r\n'),
      }, stillCurrent);

      if (outcome === 'retry' || outcome === 'skipped') {
        const latest = getState();
        const reminders = { ...latest.reminders };
        if (outcome === 'retry') reminders[key] = { retryAt: +clock() + 5 * MINUTE };
        else delete reminders[key];
        commit({ ...latest, reminders });
      }
    } catch {
      console.error('Gmail 提醒交付狀態不明，已保留寄送紀錄。');
    }
  }
}
