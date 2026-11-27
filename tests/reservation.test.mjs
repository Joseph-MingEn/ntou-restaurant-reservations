import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBooking, getAvailability } from '../site/reservations.js';

const date = '2027-01-12';
const now = new Date('2027-01-11T12:00:00+08:00');
const request = { date, time: '11:30', party: 2, name: '林小安', contact: '0912000000' };

test('相鄰入座時間重疊時，下一組使用另一桌', () => {
  const records = [];
  assert.equal(createBooking(records, request, { now, id: 'A' }).tableId, 'A01');
  assert.equal(createBooking(records, { ...request, time: '12:30' }, { now, id: 'B' }).tableId, 'A02');
  assert.equal(getAvailability(records, date, '12:00', now).seats, 32);
});

test('入座前剛好 30 分鐘即截止，且早一毫秒仍能訂位', () => {
  const records = [];
  const cutoff = new Date('2027-01-12T11:00:00+08:00');
  assert.equal(getAvailability(records, date, '11:30', new Date(+cutoff - 1)).open, true);
  assert.throws(() => createBooking(records, request, { now: cutoff }), /截止/);
  assert.equal(records.length, 0);
});

test('四人桌用完時仍可接十二人，相鄰兩人桌最多接六人', () => {
  const records = [];
  for (let index = 1; index <= 6; index++) {
    createBooking(records, { ...request, party: 4 }, { now, id: String(index) });
  }
  const { seats, two, four, maxParty } = getAvailability(records, date, '12:30', now);
  assert.deepEqual({ seats, two, four, maxParty }, { seats: 12, two: 6, four: 0, maxParty: 6 });
  assert.throws(() => createBooking(records, { ...request, party: 7 }, { now }), /空桌/);
  assert.equal(getAvailability(records, date, '17:00', now).seats, 36);
  assert.equal(getAvailability(records, '2027-01-13', '11:30', now).seats, 36);
});

test('拒絕溢位日期、未開放時間、人數和無效聯絡資料', () => {
  for (const change of [
    { date: '2027-02-30' }, { time: '13:00' }, { party: 13 }, { party: 1.5 },
    { name: ' ' }, { contact: '123' },
  ]) assert.throws(() => createBooking([], { ...request, ...change }, { now }));
});

test('取消一組立即釋出桌位並扣除餐期備餐量', async () => {
  const { cancelBooking, getService } = await import('../site/reservations.js');
  const records = [];
  createBooking(records, request, { now, id: 'A', owner: 'line-a' });
  createBooking(records, { ...request, time: '12:30', party: 3 }, { now, id: 'B' });
  assert.throws(() => cancelBooking(records, 'A', 'line-b'), /找不到/);
  cancelBooking(records, 'A', 'line-a');
  const service = getService(records, date, '11:30', now);
  assert.equal(service.guests, 3);
  assert.equal(service.parties, 1);
  assert.deepEqual(service.arrivals.map(slot => slot.guests), [0, 0, 3]);
  assert.equal(service.availability.seats, 32);
});

test('業主可記錄報到和未到，未到會釋出桌位和備餐量', async () => {
  const { getService, setArrival } = await import('../site/reservations.js');
  const records = [];
  createBooking(records, request, { now, id: 'A' });
  createBooking(records, request, { now, id: 'B' });
  assert.throws(() => setArrival(records, 'B', 'no-show', now), /入座時間/);
  const start = new Date('2027-01-12T11:31:00+08:00');
  setArrival(records, 'A', 'arrived', start);
  setArrival(records, 'B', 'no-show', start);
  const service = getService(records, date, '12:30', start);
  assert.equal(service.guests, 2);
  assert.equal(service.availability.seats, 34);
  assert.deepEqual(service.bookings.map(item => item.status), ['arrived', 'no-show']);
});

test('五人優先用相鄰的兩人桌與四人桌，兩張桌都完整保留', () => {
  const records = [];
  const booking = createBooking(records, { ...request, party: 5 }, { now, id: 'A' });
  assert.deepEqual(booking.tableIds, ['A01', 'B01']);
  const info = getAvailability(records, date, '12:30', now);
  assert.equal(info.seats, 30);
  assert.equal(info.maxParty, 12);
});

test('空桌分散時，總空位達五人也不能預約五人', () => {
  const records = ['A02', 'A04', 'A06', 'B01', 'B03', 'B05'].map(tableId => ({ ...request, tableId }));
  const info = getAvailability(records, date, '11:30', now);
  assert.equal(info.seats, 18);
  assert.equal(info.maxParty, 4);
  assert.throws(() => createBooking(records, { ...request, party: 5 }, { now }), /相鄰/);
});

test('依選取時間區分預約中、用餐中與空桌，取消的桌不占位', async () => {
  const { cancelBooking, getSeatAssignments } = await import('../site/reservations.js');
  const records = [];
  const early = createBooking(records, { ...request, time: '11:30' }, { now, id: 'early' });
  const cancelled = createBooking(records, { ...request, time: '11:30' }, { now, id: 'cancelled' });
  const current = createBooking(records, { ...request, time: '12:00' }, { now, id: 'current' });
  const later = createBooking(records, { ...request, time: '12:30' }, { now, id: 'later' });
  cancelBooking(records, 'cancelled');
  const noon = getSeatAssignments(records, request.date, '12:00');
  assert.equal(noon.get(early.tableId).status, 'dining');
  assert.equal(noon.get(current.tableId).status, 'dining');
  assert.equal(noon.get(later.tableId).status, 'reserved');
  assert.equal(noon.has(cancelled.tableId), false);
  assert.equal(getSeatAssignments(records, request.date, '12:30').get(later.tableId).status, 'dining');
  assert.equal(getSeatAssignments(records, request.date, '17:00').size, 0);
});

test('單日餐費以午晚餐有效訂位人數合計，未輸入費用時可顯示人數', async () => {
  const { estimateDailyMealCost } = await import('../site/reservations.js');
  assert.deepEqual(estimateDailyMealCost(9, 3, 125.75), { guests: 12, amount: 1509 });
  assert.deepEqual(estimateDailyMealCost(9, 3, NaN), { guests: 12, amount: null });
  assert.deepEqual(estimateDailyMealCost(0, 0, 110), { guests: 0, amount: 0 });
  assert.deepEqual(estimateDailyMealCost(2, 1, 0), { guests: 3, amount: 0 });
});
