import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';

const key = 'test-admin-key';
const secret = 'test-line-secret';
const event = (webhookEventId, text) => ({
  webhookEventId, type: 'message', replyToken: webhookEventId, mode: 'active',
  source: { type: 'user', userId: 'U123' }, message: { type: 'text', text },
});

async function setup(t, options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'restaurant-http-'));
  const replyCalls = [];
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.filter(server => server.listening)
      .map(server => new Promise(resolve => server.close(resolve))));
    rmSync(folder, { recursive: true, force: true });
  });
  const start = async () => {
    const server = createServer({
      dataFile: join(folder, 'bookings.json'), adminKey: key, lineSecret: secret,
      clock: () => new Date('2027-01-11T12:00:00+08:00'),
      replyToLine: async (token, message) => replyCalls.push({ token, message }),
      ...options,
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    return {
      server,
      send: (events, signed = true) => {
        const body = JSON.stringify({ events });
        const signature = signed ? createHmac('sha256', secret).update(body).digest('base64') : 'invalid';
        return fetch(base + '/line/webhook', { method: 'POST', body, headers: { 'x-line-signature': signature } });
      },
      service: (authorized = true) => fetch(base + '/api/admin/service?date=2027-01-12&time=11:30',
        { headers: authorized ? { Authorization: 'Bearer ' + key } : {} }),
    };
  };
  return { ...(await start()), start, replyCalls };
}

test('只接受有效簽章，重送同一事件只保留一筆，重啟保留資料', async t => {
  const { server, send, service, start, replyCalls } = await setup(t);
  const booking = event('event-1', '訂位 2027-01-12 12:30 3 林小安 guest@example.test');
  assert.equal((await send([booking], false)).status, 401);
  assert.equal((await service(false)).status, 401);
  assert.equal((await send([booking])).status, 200);
  assert.equal((await send([booking])).status, 200);
  assert.equal(replyCalls.length, 1);
  await new Promise(resolve => server.close(resolve));
  const restarted = await start();
  const result = await (await restarted.service()).json();
  assert.equal(result.parties, 1);
  assert.equal(result.guests, 3);
  assert.equal(result.bookings[0].owner, undefined);
  assert.equal((await restarted.send([booking])).status, 200);
  assert.equal(replyCalls.length, 1);
});

test('七筆同時搶午餐四人桌，十二人組只取得兩次且分配互斥', async t => {
  const { send, service, replyCalls } = await setup(t);
  const responses = await Promise.all(Array.from({ length: 7 }, (_, index) => send([
    event('large-' + index, '訂位 2027-01-12 12:30 12 林小安 guest@example.test'),
  ])));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(replyCalls.filter(item => item.message.text.includes('訂位成功')).length, 2);
  const result = await (await service()).json();
  assert.equal(result.guests, 24);
  assert.equal(new Set(result.bookings.flatMap(booking => booking.tableIds)).size, 6);
  assert.equal(result.availability.maxParty, 6);
});

test('經簽章驗證的日期選擇事件會透過 LINE 回傳可選時段', async t => {
  const { send, replyCalls } = await setup(t);
  await send([event('start-booking', '訂位')]);
  const dateAction = replyCalls[0]?.message.quickReply?.items[0].action;
  assert.equal(dateAction?.mode, 'date');
  const dateEvent = {
    ...event('pick-date', ''),
    type: 'postback',
    message: undefined,
    postback: { data: dateAction.data, params: { date: '2027-01-12' } },
  };
  assert.equal((await send([dateEvent])).status, 200);
  assert.equal(replyCalls[1]?.message.quickReply.items.length, 6);
});

test('新訂位使用互不重複的六位數字，並可持該號碼取消', async t => {
  const { send, service, replyCalls } = await setup(t);
  await send([event('short-a', '訂位 2027-01-12 11:30 2 林小安 guest@example.test'),
    event('short-b', '訂位 2027-01-12 11:30 2 王小明 guest2@example.test')]);
  const { bookings } = await (await service()).json();
  assert.equal(bookings.length, 2);
  for (const booking of bookings) assert.match(booking.id, /^\d{6}$/);
  assert.notEqual(bookings[0].id, bookings[1].id);
  assert.match(replyCalls[0].message.text, new RegExp('訂位編號 ' + bookings[0].id));
  await send([event('cancel-short', '取消 ' + bookings[0].id)]);
  assert.match(replyCalls[2].message.text, /已取消訂位/);
  assert.equal((await (await service()).json()).parties, 1);
});

test('正式訂位在入座前兩小時和半小時以 Gmail 提醒，重啟不重寄', async t => {
  let now = new Date('2027-01-12T09:00:00+08:00');
  const reminders = [];
  const driver = await setup(t, {
    clock: () => now,
    reminderIntervalMs: 10,
    sendReminder: async (message, stillCurrent) => {
      if (!stillCurrent()) return;
      reminders.push(message);
      return 'sent';
    },
  });
  const { send, server, start, replyCalls } = driver;
  await send([
    event('email', '訂位 2027-01-12 11:30 2 王小明 guest@example.test'),
    event('phone', '訂位 2027-01-12 11:30 2 林小安 0912000000'),
    event('cancelled-email', '訂位 2027-01-12 11:30 2 張小華 cancelled@example.test'),
    event('reschedule-email', '訂位 2027-01-12 11:30 2 張小華 moved@example.test'),
  ]);
  const id = index => /訂位編號 (\d+)/.exec(replyCalls[index].message.text)[1];
  const bookingId = id(0);
  await send([
    event('cancel-email', '取消 ' + id(2)),
    event('move-email', '改期 ' + id(3) + ' 2027-01-12 12:00 3'),
  ]);
  assert.match(replyCalls[0].message.text, /入座前 2 小時和 30 分鐘/);
  await delay(35);
  assert.equal(reminders.length, 0);

  async function waitForCount(count) {
    for (let i = 0; i < 100 && reminders.length < count; i++) await delay(10);
    assert.equal(reminders.length, count);
  }

  now = new Date('2027-01-12T09:30:00+08:00');
  await waitForCount(1);
  assert.equal(reminders[0].to, 'guest@example.test');
  assert.match(reminders[0].subject, /2 小時/);
  assert.match(reminders[0].body, new RegExp(bookingId));
  await new Promise(resolve => server.close(resolve));
  await start();
  await delay(35);
  assert.equal(reminders.length, 1);

  now = new Date('2027-01-12T11:00:00+08:00');
  await waitForCount(3);
  assert.ok(reminders.some(item => item.to === 'guest@example.test' && /30 分鐘/.test(item.subject)));
  assert.ok(reminders.some(item => item.to === 'moved@example.test' && /入座時間 12:00/.test(item.body)));
  now = new Date('2027-01-12T11:30:00+08:00');
  await waitForCount(4);
  assert.equal(reminders[3].to, 'moved@example.test');
  assert.match(reminders[3].subject, /30 分鐘/);
});
