import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmailSender } from '../gmail.mjs';
import { deliverReminders } from '../reminders.mjs';

test('Gmail 使用 OAuth 和 MIME 寄出繁體中文，寄出前重新檢查訂位', async () => {
  const requests = [];
  const send = createGmailSender({
    sender: 'store@example.test',
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
    request: async (url, options) => {
      requests.push({ url, ...options });
      return Response.json(requests.length === 1
        ? { access_token: 'testing', expires_in: 3600 } : { id: 'sent-id' });
    },
  });
  const reminder = { to: 'guest@example.test', subject: '入座前 30 分鐘', body: '訂位編號 123456' };
  assert.equal(await send(reminder, () => false), 'skipped');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.get('grant_type'), 'refresh_token');
  assert.equal(await send(reminder, () => true), 'sent');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  const mime = Buffer.from(JSON.parse(requests[1].body).raw, 'base64url').toString();
  assert.match(mime, /^From: store@example\.test\r\nTo: guest@example\.test\r\n/);
  assert.ok(mime.includes(Buffer.from(reminder.subject).toString('base64')));
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), reminder.body);
  await assert.rejects(send({ ...reminder, to: 'invalid@domain.test\n' }, () => true), /收件地址無效/);
  assert.equal(requests.length, 2);
});

test('排程僅補當前提醒，排除已報到、取消、未到及電話訂位', async () => {
  let state = { bookings: [
    { id: '1', contact: 'valid@example.test', time: '11:30', date: '2027-01-12', party: 2 },
    ...[
      { status: 'arrived' }, { status: 'no-show' }, { cancelled: true }, { contact: '0912000000' },
    ].map((fields, index) => ({
      id: String(index + 2), contact: 'skip@example.test', time: '11:30', date: '2027-01-12', party: 2,
      ...fields,
    })),
  ] };
  let now = new Date('2027-01-12T11:03:00+08:00');
  const deliveries = [];
  const run = () => deliverReminders({
    getState: () => state, commit: next => { state = next; }, clock: () => now,
    sendReminder: async (message, stillCurrent) => {
      assert.ok(stillCurrent());
      deliveries.push(message);
      return deliveries.length === 1 ? 'retry' : 'sent';
    },
  });
  await run();
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].subject, /30 分鐘/);
  assert.equal(deliveries[0].to, 'valid@example.test');
  assert.match(deliveries[0].body, /台北 101\r\n台北市信義區信義路五段7號/);
  now = new Date(+now + 4 * 60_000);
  await run();
  assert.equal(deliveries.length, 1);
  now = new Date(+now + 60_000);
  await run();
  await run();
  assert.equal(deliveries.length, 2);
  assert.match(deliveries[1].subject, /30 分鐘/);
});
