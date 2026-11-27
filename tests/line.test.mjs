import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLineMessage } from '../site/line.js';
import { getService } from '../site/reservations.js';

const now = new Date('2027-01-11T12:00:00+08:00');
const setup = () => {
  const state = { bookings: [], locationRequests: {} };
  const send = (message, user = 'line-a', time = now) => handleLineMessage(
    state, typeof message === 'string' ? { type: 'text', text: message } : message,
    { user, now: time, createId: () => 'R-001' }
  );
  return { state, send };
};

test('LINE 建立訂位後，業主的同餐期備餐量更新', () => {
  const { state, send } = setup();
  const reply = send('訂位 2027-01-12 12:30 3 林小安 guest@example.test');
  assert.match(reply.text, /R-001/);
  assert.match(reply.text, /12:30–14:30/);
  assert.equal(getService(state.bookings, '2027-01-12', '11:30', now).guests, 3);
});

test('定位須選取本人訂位，且只能在十分鐘內提交一次', () => {
  const { state, send } = setup();
  const position = { type: 'location', latitude: 25.15, longitude: 121.77 };
  send('訂位 2027-01-12 12:30 3 林小安 guest@example.test');
  assert.match(send('定位 R-001', 'line-b').text, /找不到/);
  assert.match(send(position).text, /請先/);
  assert.equal(send('定位 R-001').quickReply.items[0].action.type, 'location');
  assert.match(send(position, 'line-a', new Date(+now + 600_000)).text, /請先/);
  send('定位 R-001');
  assert.match(send(position).text, /收到/);
  assert.match(send(position).text, /請先/);
  assert.equal(state.bookings[0].location.longitude, 121.77);
  assert.match(send('取消 R-001').text, /已取消/);
  assert.equal(state.bookings[0].location, undefined);
});

test('可查本人訂位，改期失敗保留原桌，改期成功沿用訂位碼', () => {
  const { state, send } = setup();
  send('訂位 2027-01-12 12:30 3 林小安 guest@example.test');
  assert.match(send('我的訂位').text, /R-001/);
  assert.doesNotMatch(send('我的訂位', 'line-b').text, /R-001/);
  assert.match(send('改期 R-001 2027-01-12 14:00 3').text, /時段/);
  assert.equal(state.bookings[0].time, '12:30');
  assert.match(send('改期 R-001 2027-01-12 17:30 4').text, /改期成功/);
  assert.equal(state.bookings.length, 1);
  assert.equal(state.bookings[0].id, 'R-001');
  assert.equal(state.bookings[0].time, '17:30');
});
