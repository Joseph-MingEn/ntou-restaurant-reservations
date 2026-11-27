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
  const confirmation = send(position).text;
  assert.match(confirmation, /^已收到你的定位。/);
  assert.match(confirmation, /訂位編號 R-001/);
  assert.match(confirmation, /已附到這筆訂位/);
  assert.match(confirmation, /業主後台/);
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

test('LINE 大組訂位收到全部桌號，十三人以上引導聯絡店家', () => {
  const { state, send } = setup();
  const reply = send('訂位 2027-01-12 12:30 5 林小安 guest@example.test');
  assert.match(reply.text, /A01＋B01/);
  assert.match(send('訂位 2027-01-12 12:30 13 林小安 guest@example.test').text, /聯繫店家/);
  assert.equal(state.bookings.length, 1);
});

test('/help 列出所有指令及可用範例，不建立或修改訂位', () => {
  const { state, send } = setup();
  const message = send('/help');
  assert.equal(message.type, 'text');
  for (const command of [
    '/help',
    '查詢 2027-01-12',
    '查詢 2027-01-12 17:00',
    '訂位 2027-01-12 17:00 5 王小明 guest@example.test',
    '我的訂位',
    '改期 訂位編號 2027-01-12 17:30 4',
    '取消 訂位編號',
    '定位 訂位編號',
  ]) assert.ok(message.text.includes(command), '遺漏指令範例 ' + command);
  assert.deepEqual(state, { bookings: [], locationRequests: {} });
});

test('客人先選日期和仍開放的時間，確認資料後才完成訂位', () => {
  const { state, send } = setup();
  const lateMorning = new Date('2027-01-12T11:45:00+08:00');
  const start = send('訂位', 'line-a', lateMorning);
  const dateAction = start.quickReply.items[0].action;
  assert.equal(dateAction.type, 'datetimepicker');
  assert.equal(dateAction.mode, 'date');

  const selectedDate = { type: 'postback', data: dateAction.data, params: { date: '2027-01-12' } };
  const slots = send(selectedDate, 'line-a', lateMorning);
  assert.deepEqual(slots.quickReply.items.map(item => item.action.text), [
    '訂位 2027-01-12 12:30', '訂位 2027-01-12 17:00', '訂位 2027-01-12 17:30', '訂位 2027-01-12 18:00',
  ]);

  const picked = send(slots.quickReply.items[2].action.text, 'line-a', lateMorning);
  assert.match(picked.text, /17:30–19:30/);
  assert.equal(state.bookings.length, 0);
  assert.match(send('確認 5 王小明 guest@example.test', 'line-b', lateMorning).text, /請先/);
  assert.match(send('確認 5 王小明 guest@example.test', 'line-a', lateMorning).text, /訂位成功/);
  assert.equal(state.bookings[0].time, '17:30');
  assert.match(send('確認 5 王小明 guest@example.test', 'line-a', lateMorning).text, /請先/);
});

test('選了時間後，送出時已過截止或無足夠相鄰桌就不建立訂位', () => {
  const { state, send } = setup();
  const cutoff = new Date('2027-01-12T12:00:00+08:00');
  send('訂位 2027-01-12 12:30', 'line-a', new Date(+cutoff - 60_000));
  assert.match(send('確認 2 王小明 guest@example.test', 'line-a', cutoff).text, /截止|重新選擇/);
  send('訂位 2027-01-12 17:00');
  const records = Array.from({ length: 2 }, (_, index) => ({
    id: String(index), date: '2027-01-12', time: '17:00',
    tableIds: index ? ['B04', 'B05', 'B06'] : ['B01', 'B02', 'B03'],
  }));
  state.bookings.push(...records);
  assert.match(send('確認 12 王小明 guest@example.test').text, /相鄰空桌/);
  assert.equal(state.bookings.length, 2);
});

test('口語詢問明天晚餐五點半有沒有五人座時，回覆該時段的容量', () => {
  const { state, send } = setup();
  const answer = send('請問明天晚上五點半，五位，有位嗎？');
  assert.match(answer.text, /2027-01-12/);
  assert.match(answer.text, /17:30–19:30\n5 人可訂/);
  assert.equal(state.bookings.length, 0);
});

test('口語訂位會準備所選時間，再由客人確認資料', () => {
  const { state, send } = setup();
  const first = send('我想訂明晚五點半的位子，六個人');
  assert.match(first.text, /日期 2027-01-12\n用餐時段 17:30–19:30/);
  assert.match(first.text, /確認 6 王小明/);
  assert.equal(state.bookings.length, 0);
  assert.match(send('確認 六位 王小明 guest@example.test').text, /訂位成功/);
  assert.equal(state.bookings[0].party, 6);
});

test('要求 19:59 入座時，說明 18:00 最晚入座、17:30 截止及可選時段', () => {
  const { state, send } = setup();
  const answer = send('訂位 2026-11-28 19:59', 'line-a', new Date('2026-11-27T14:00:00+08:00'));
  assert.match(answer.text, /晚餐營業到 20:00/);
  assert.match(answer.text, /最晚 18:00 入座/);
  assert.match(answer.text, /提早 1 小時 59 分鐘/);
  assert.match(answer.text, /17:30 前完成訂位/);
  assert.match(answer.text, /入座前 30 分鐘/);
  assert.ok(answer.quickReply.items.some(item => item.action.text === '訂位 2026-11-28 18:00'));
  assert.equal(state.bookings.length, 0);
});

test('未開放的非整點時段回覆可選時段及各自的訂位截止', () => {
  const { send } = setup();
  const answer = send('明天晚上 17:40 能訂嗎？');
  assert.match(answer.text, /每 30 分鐘/);
  assert.match(answer.text, /17:30–19:30[\s\S]*?17:00 前/);
  assert.match(answer.text, /18:00–20:00[\s\S]*?17:30 前/);
});

test('用口語詢問截止，回覆確切的截止時間而不建立訂位草稿', () => {
  const { state, send } = setup();
  assert.match(send('明天晚上六點要提前多久訂位？').text, /17:30 前/);
  assert.equal(state.bookingDrafts, undefined);
});

test('口語「五點五位有空嗎」將第二個五辨識為人數，且只查詢空位', () => {
  const { state, send } = setup();
  assert.match(send('明天晚上五點五位有空嗎？').text, /17:00–19:00\n5 人可訂/);
  assert.equal(state.bookingDrafts, undefined);
});

test('查位回覆逐項換行，多個時段之間留空行', () => {
  const { send } = setup();
  const answer = send('請問明天晚上五點半，五位，有位嗎？');
  assert.equal(answer.text, [
    '2027-01-12', '', '17:30–19:30', '5 人可訂', '最大單組 12 人',
    '兩人桌剩 6 張', '四人桌剩 6 張', '請在 17:00 前訂位',
  ].join('\n'));
  assert.match(send('查詢 2027-01-12').text, /11:00 前訂位\n\n12:00–14:00/);
});

test('建立、查詢本人訂位及改期的結果，各欄位分行', () => {
  const { send } = setup();
  const created = send('訂位 2027-01-12 12:30 2 林小安 guest@example.test').text;
  assert.match(created, /^訂位成功！\n\n訂位編號 R-001\n用餐日期 2027-01-12\n用餐時段 12:30–14:30\n人數 2 人\n桌號 A01\n\n用餐地點\n/);
  send('訂位 2027-01-13 12:30 2 林小安 guest@example.test');
  assert.match(send('我的訂位').text, /桌號 A01\n\n訂位編號 R-001\n用餐日期 2027-01-13/);
  assert.match(send('改期 R-001 2027-01-12 17:30 2').text, /^改期成功！\n\n訂位編號 R-001\n用餐日期 2027-01-12\n用餐時段 17:30–19:30/);
});

test('/help 的定位小節清楚說明選填、用途與手機操作步驟', () => {
  const { send } = setup();
  const text = send('/help').text;
  assert.match(text, /【查空位】\n查詢 2027-01-12\n查詢 2027-01-12 17:00\n也可以問/);
  const location = text.split('【分享定位（選填）】\n')[1]?.split('\n\n')[0] ?? '';
  assert.match(location, /找不到餐廳/);
  assert.match(location, /業主後台/);
  assert.match(location, /1\. 傳送「定位 訂位編號」/);
  assert.match(location, /2\. 在 10 分鐘內，用手機 LINE 點「分享定位」/);
});

test('可在 LINE 查台北 101 地址，訂位成功、查訂位和改期也提供同一個地圖', () => {
  const { state, send } = setup();
  const venue = send('餐廳地址');
  assert.match(send('/help').text, /餐廳地址/);
  assert.match(venue.text, /台北 101\n台北市信義區信義路五段7號/);
  const map = new URL(venue.text.split('\n').at(-1));
  assert.equal(map.hostname, 'www.google.com');
  assert.match(map.searchParams.get('query'), /台北 101.*信義路五段7號/);
  assert.equal(state.bookings.length, 0);
  for (const command of [
    '訂位 2027-01-12 17:00 2 林小安 guest@example.test',
    '我的訂位',
    '改期 R-001 2027-01-12 17:30 2',
  ]) assert.ok(send(command).text.includes(venue.text), command);
});
