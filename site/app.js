import {
  DEFAULT_OPERATIONS, MAX_PARTY, MEALS, TIMES, bookingTables, cancelBooking, createBooking, createBookingNumber, diningTime, endTime, estimateOperations, getAvailability, getSeatAssignments, getService, isActive, setArrival, today,
} from './reservations.js?v=17';
import { handleLineMessage } from './line.js?v=18';

const byId = id => document.getElementById(id);
const demo = location.pathname !== '/admin';
const storeKey = 'ntou-restaurant-reservations-demo-v1';
const sampleDate = today(new Date(Date.now() + 86_400_000));
const guest = 'line:demo-customer';
const dateInput = byId('service-date');
const timeSelect = byId('service-time');
const reserveForm = byId('reserve-form');
const guestDate = reserveForm.elements.namedItem('date');
const guestTime = reserveForm.elements.namedItem('time');
const guestParty = reserveForm.elements.namedItem('party');
const adminFeedback = byId('admin-status');
const operationsKey = storeKey + '-operation-settings';
const costFields = byId('cost-fields');
const operationsInputs = {
  price: byId('guest-price'), food: byId('food-cost'), staffCount: byId('staff-count'),
};
const costBasis = { month: '每月', day: '每日', guest: '每位客人' };
const amountIds = ['daily-revenue', 'daily-cost', 'daily-profit', 'daily-margin', 'daily-break-even'];
const currency = new Intl.NumberFormat('zh-TW', {
  style: 'currency', currency: 'TWD', minimumFractionDigits: 0, maximumFractionDigits: 2,
});
let dailyMeals;
const messages = byId('messages');
const mealButtons = [...document.querySelectorAll('[data-meal]')];
let mealKey = 'lunch';
let adminKey = '';
let renderEpoch = 0;
let lastService = '';
let currentService;
let animationMode = false;
let playback;
let demoState;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function announce(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function newDemo() {
  const bookings = [];
  const samplePeople = ['陳小姐', '李先生', '謝小姐', '鄭先生', '張小姐', '林先生'];
  const parties = [2, 3, 2, 4, 4, 2];
  for (const [index, name] of samplePeople.entries()) {
    createBooking(bookings, {
      name, date: sampleDate, time: MEALS.lunch.times[Math.floor(index / 2)], party: parties[index],
      contact: 'guest' + (index + 1) + '@example.test',
    }, { id: 'DEMO-' + (index + 1), owner: 'sample' });
  }
  return { bookings, locationRequests: {} };
}

function readDemo() {
  try {
    const saved = localStorage.getItem(storeKey);
    if (saved) return JSON.parse(saved);
  } catch {
    announce(adminFeedback, '瀏覽器儲存無法使用，展示只能在本頁暫存。');
  }
  return demoState ?? newDemo();
}

async function changeDemo(transform) {
  const update = () => {
    const next = structuredClone(readDemo());
    const result = transform(next);
    demoState = next;
    try {
      localStorage.setItem(storeKey, JSON.stringify(next));
    } catch {
      announce(adminFeedback, '瀏覽器儲存無法使用，重新整理會清除本頁的變更。');
    }
    return result;
  };
  if (navigator.locks) return navigator.locks.request(storeKey, update);
  return update();
}

function fillTimes(select, times, showEnd = false) {
  select.replaceChildren(...times.map(time => new Option(showEnd ? time + '–' + endTime(time) : time, time)));
}

function metric(label, value, unit, hint) {
  const card = element('div', undefined, 'metric');
  const figure = element('p', String(value), 'metric-value');
  figure.append(element('small', unit));
  card.append(element('p', label, 'metric-label'), figure, element('p', hint, 'metric-note'));
  return card;
}

function drawService(service) {
  currentService = service;
  const { availability, arrivals, guests, parties } = service;
  const tableStates = getSeatAssignments(service.bookings, dateInput.value, timeSelect.value);
  const slotStatus = !availability.open ? '已截止' : availability.seats ? '開放訂位' : '額滿';
  byId('metrics').replaceChildren(
    metric('備餐人數', guests, '人', '整個餐期有效訂位'),
    metric('訂位組數', parties, '組', '含已報到的組別'),
    metric('尚可接待', availability.open ? availability.seats : 0, '人', availability.open ? '空桌可接待的總座位' : '此入座時間已截止'),
    metric('最大單組', availability.open ? availability.maxParty : 0, '人', availability.open ? '可用相鄰桌能容納的人數' : '此入座時間已截止'),
  );
  byId('slot-info').textContent =
    timeSelect.value + '–' + endTime(timeSelect.value) + ' · ' + slotStatus;
  byId('tables').replaceChildren(...[2, 4].map(capacity => {
    const group = element('div', undefined, 'table-group');
    const heading = element('h3', capacity === 2 ? '兩人桌' : '四人桌');
    heading.append(element('span', '剩 ' + (capacity === 2 ? availability.two : availability.four) + ' / 6 張'));
    const list = element('ul', undefined, 'table-grid');
    for (const table of availability.tables.filter(item => item.capacity === capacity)) {
      const status = tableStates.get(table.id)?.status ?? 'free';
      const chip = element('li', table.id, 'table-chip ' + status);
      chip.append(element('span', TABLE_LABELS[status], 'table-chip-status'));
      list.append(chip);
    }
    group.append(heading, list);
    return group;
  }));
  byId('arrivals').replaceChildren(...arrivals.map(({ time, guests: count }) => {
    const row = element('div', undefined, 'arrival-row');
    const bar = element('meter');
    bar.max = 36;
    bar.value = count;
    bar.setAttribute('aria-label', time + ' 已訂 ' + count + ' 人');
    const slot = element('button', time, 'arrival-time');
    slot.type = 'button';
    slot.setAttribute('aria-pressed', String(time === timeSelect.value));
    slot.addEventListener('click', () => {
      stopPlayback();
      timeSelect.value = time;
      void refreshAdmin();
    });
    row.append(slot, bar, element('span', count + ' 人'));
    return row;
  }));
  drawSlotGuests(service);
}

const TABLE_LABELS = { dining: '用餐中', reserved: '預約中', free: '空桌' };

function drawSlotGuests(service) {
  const time = timeSelect.value;
  const window = time + '–' + endTime(time);
  const summary = byId('guest-summary');
  if (animationMode) {
    const assignments = getSeatAssignments(service.bookings, dateInput.value, time);
    const totals = { dining: 0, reserved: 0 };
    for (const { status, guests } of assignments.values()) totals[status] += guests;
    summary.textContent = window + ' · 用餐中 ' + totals.dining + ' 人 · 預約中 ' + totals.reserved + ' 人';
    drawGuestMap(service.availability.tables, assignments);
  } else {
    const bookings = service.bookings.filter(booking => booking.time === time);
    const active = bookings.filter(isActive);
    const guests = active.reduce((sum, booking) => sum + booking.party, 0);
    summary.textContent = window + ' · ' + active.length + ' 組 · ' + guests + ' 人';
    const rows = bookings.map(bookingRow);
    byId('booking-list').replaceChildren(...(rows.length ? rows : [element('li', '這個入座時間尚無訂位。', 'empty')]));
  }
}

function drawGuestMap(tables, assignments) {
  for (const status of Object.keys(TABLE_LABELS)) {
    const count = tables.filter(table => (assignments.get(table.id)?.status ?? 'free') === status).length;
    byId('map-count-' + status).textContent = TABLE_LABELS[status] + ' ' + count + ' 桌';
  }
  const map = byId('guest-map');
  map.replaceChildren(...[2, 4].map(capacity => {
    const section = element('div');
    section.append(element('h3', capacity === 2 ? '兩人桌' : '四人桌'));
    const grid = element('ul', undefined, 'guest-map-grid');
    for (const table of tables.filter(item => item.capacity === capacity)) {
      const assignment = assignments.get(table.id);
      const status = assignment?.status ?? 'free';
      const tile = element('li', undefined, 'guest-table ' + status);
      const title = element('strong', table.id);
      const note = element('strong', TABLE_LABELS[status], 'table-map-status');
      const people = element('div', undefined, 'seats');
      people.setAttribute('aria-hidden', 'true');
      for (let seat = 0; seat < capacity; seat++) {
        const seated = status === 'dining' && seat < assignment.guests;
        const dot = element('i', undefined, seated ? 'occupied-seat' : '');
        if (seated) dot.style.setProperty('--seat-delay', (seat * 75) + 'ms');
        people.append(dot);
      }
      tile.append(title, people, note);
      if (assignment) tile.append(element('span', assignment.guests + ' 人'));
      if (assignment?.combined) tile.append(element('small', '併桌'));
      grid.append(tile);
    }
    section.append(grid);
    return section;
  }));
}

function stopPlayback() {
  clearInterval(playback);
  playback = undefined;
  byId('play-slots').textContent = '播放時段';
}

byId('play-slots').addEventListener('click', () => {
  if (playback !== undefined) {
    stopPlayback();
    return;
  }
  const times = MEALS[mealKey].times;
  let index = 0;
  timeSelect.value = times[index];
  void refreshAdmin();
  byId('play-slots').textContent = '暫停播放';
  playback = setInterval(() => {
    index++;
    if (index === times.length) {
      stopPlayback();
      return;
    }
    timeSelect.value = times[index];
    void refreshAdmin();
  }, 2600);
});

for (const [id, mode] of [['guest-list-mode', false], ['guest-map-mode', true]]) {
  byId(id).addEventListener('click', () => {
    animationMode = mode;
    byId('guest-list-mode').setAttribute('aria-pressed', String(!mode));
    byId('guest-map-mode').setAttribute('aria-pressed', String(mode));
    byId('guest-list-view').hidden = mode;
    byId('guest-map-view').hidden = !mode;
    if (!mode) stopPlayback();
    if (currentService) drawSlotGuests(currentService);
  });
}

function bookingRow(booking) {
  const row = element('li', undefined, 'booking-row');
  const arrival = element('div');
  arrival.append(element('strong', booking.time + '–' + endTime(booking.time)), element('p', bookingTables(booking).join('＋') + ' 桌 · ' + booking.party + ' 人'));
  const name = element('div');
  name.append(element('strong', booking.name), element('p', booking.id));
  const contact = element('div');
  contact.append(element('p', booking.contact));
  if (booking.location) {
    const link = element('a', '查看分享的定位');
    link.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(
      booking.location.latitude + ',' + booking.location.longitude
    );
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    contact.append(link);
  }
  const state = element('div');
  const confirmed = !booking.cancelled && !booking.status;
  const label = booking.cancelled ? '已取消' : ({ arrived: '已報到', 'no-show': '未到' }[booking.status] ?? '已確認');
  state.append(element('strong', label));
  if (confirmed) {
    const actions = element('div', undefined, 'booking-actions');
    const start = diningTime(booking.date, booking.time);
    const now = Date.now();
    if (now >= start - 1_800_000 && now < start + 7_200_000) actions.append(statusButton(booking, 'arrived', '報到'));
    if (now >= start) actions.append(statusButton(booking, 'no-show', '記為未到'));
    actions.append(statusButton(booking, 'cancelled', '取消'));
    state.append(actions);
  }
  row.append(arrival, name, contact, state);
  return row;
}

function statusButton(booking, status, label) {
  const button = element('button', label);
  button.type = 'button';
  button.setAttribute('aria-label', label + ' ' + booking.name + '的訂位');
  button.addEventListener('click', async () => {
    if ((status === 'cancelled' || status === 'no-show') && !window.confirm(label + '「' + booking.name + '」的訂位？')) return;
    button.disabled = true;
    announce(adminFeedback, '');
    try {
      if (demo) {
        await changeDemo(state => status === 'cancelled'
          ? cancelBooking(state.bookings, booking.id)
          : setArrival(state.bookings, booking.id, status));
      } else {
        await api('/api/admin/status', { method: 'POST', body: JSON.stringify({ id: booking.id, status }) });
      }
      await refreshAdmin();
      announce(adminFeedback, '訂位狀態已更新。');
    } catch (error) {
      announce(adminFeedback, error.message);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '讀取失敗，請稍後再試。');
  return result;
}

function loadOperations() {
  const defaults = structuredClone(DEFAULT_OPERATIONS);
  try {
    const saved = JSON.parse(localStorage.getItem(operationsKey));
    if (saved && Array.isArray(saved.costs) && saved.costs.length >= defaults.costs.length &&
        saved.costs.every(item => typeof item?.name === 'string' && Object.hasOwn(costBasis, item.basis)) &&
        estimateOperations('2026-01-01', 0, saved)) return saved;
  } catch {
    // Use the configured defaults when storage cannot be read.
  }
  return defaults;
}

const operations = loadOperations();
const percent = new Intl.NumberFormat('zh-TW', { style: 'percent', maximumFractionDigits: 2 });

function drawOperations() {
  const date = dateInput.value;
  const { lunch, dinner } = dailyMeals ?? {};
  const guests = lunch + dinner;
  const estimate = dailyMeals && estimateOperations(date, guests, operations);
  const count = byId('meal-budget-count');
  const breakdown = byId('cost-breakdown');
  announce(byId('operations-feedback'), dailyMeals && !estimate ? '請填寫有效的金額與員工人數。' : '');
  count.textContent = dailyMeals
    ? '全天 ' + guests + ' 人 · 月費按 ' + (estimate?.days ?? '當月實際') + ' 天攤提 · 新台幣'
    : '請指定營業日期';
  if (!estimate) {
    for (const id of amountIds) byId(id).textContent = '—';
    breakdown.replaceChildren();
    return;
  }
  byId('daily-revenue').textContent = currency.format(estimate.revenue);
  byId('daily-cost').textContent = currency.format(estimate.cost);
  const profit = byId('daily-profit');
  profit.textContent = currency.format(estimate.profit);
  profit.classList.toggle('negative', estimate.profit < 0);
  byId('daily-margin').textContent = estimate.margin === null ? '—' : percent.format(estimate.margin);
  byId('daily-break-even').textContent = estimate.breakEven === null ? '無法靠增加客人打平' : estimate.breakEven + ' 人';
  breakdown.replaceChildren(...estimate.items.map(item => {
    const row = element('div');
    row.append(element('dt', item.name), element('dd', currency.format(item.total)));
    return row;
  }));
}

function saveOperations() {
  drawOperations();
  if (!estimateOperations('2026-01-01', 0, operations)) return;
  try {
    localStorage.setItem(operationsKey, JSON.stringify(operations));
  } catch {
    // Changes can still be used during this visit.
  }
}

for (const [key, input] of Object.entries(operationsInputs)) {
  input.value = operations[key];
  input.addEventListener('input', () => {
    operations[key] = input.valueAsNumber;
    saveOperations();
  });
}

function drawCostFields() {
  const defaultsCount = DEFAULT_OPERATIONS.costs.length;
  costFields.replaceChildren(...operations.costs.map((item, index) => {
    const custom = index >= defaultsCount;
    const row = element('div', undefined, 'cost-field');
    if (custom) {
      const name = element('input');
      name.value = item.name;
      name.maxLength = 40;
      name.setAttribute('aria-label', '自訂成本名稱');
      name.addEventListener('input', () => {
        item.name = name.value.trim() || '自訂成本';
        saveOperations();
      });
      row.append(name);
    } else {
      row.append(element('strong', item.name + (index === 0 ? '（每位員工）' : '')));
    }

    const amount = element('input');
    amount.type = 'number';
    amount.min = '0';
    amount.step = '0.01';
    amount.inputMode = 'decimal';
    amount.value = Number.isFinite(item.amount) ? item.amount : '';
    amount.setAttribute('aria-label', item.name + '金額（元）');
    amount.addEventListener('input', () => {
      item.amount = amount.valueAsNumber;
      saveOperations();
    });

    const basis = element('select');
    basis.setAttribute('aria-label', item.name + '計費方式');
    basis.replaceChildren(...Object.entries(costBasis).map(([value, label]) => new Option(label, value)));
    basis.value = item.basis;
    basis.addEventListener('change', () => {
      item.basis = basis.value;
      saveOperations();
    });
    row.append(amount, basis);
    if (custom) {
      const remove = element('button', '移除', 'secondary');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除此成本');
      remove.addEventListener('click', () => {
        operations.costs.splice(index, 1);
        drawCostFields();
        saveOperations();
      });
      row.append(remove);
    }
    return row;
  }));
}

byId('add-cost').addEventListener('click', () => {
  operations.costs.push({ name: '自訂成本', amount: 0, basis: 'day' });
  drawCostFields();
  saveOperations();
  costFields.lastElementChild.querySelector('input').focus();
});
drawCostFields();

async function refreshAdmin() {
  if (!demo && !adminKey) return false;
  const epoch = ++renderEpoch;
  const date = dateInput.value;
  const time = timeSelect.value;
  if (!date || !time) {
    dailyMeals = undefined;
    drawOperations();
    byId('admin-data').hidden = !time;
    announce(adminFeedback, '請指定營業日期。');
    return false;
  }
  try {
    const selectedMeal = MEALS.lunch.times.includes(time) ? 'lunch' : 'dinner';
    const otherMeal = selectedMeal === 'lunch' ? 'dinner' : 'lunch';
    const otherTime = MEALS[otherMeal].times[0];
    const records = demo ? readDemo().bookings : undefined;
    const loadService = start => demo ? getService(records, date, start) :
      api('/api/admin/service?' + new URLSearchParams({ date, time: start }));
    const [service, otherService] = await Promise.all([loadService(time), loadService(otherTime)]);
    if (epoch !== renderEpoch) return false;
    dailyMeals = { [selectedMeal]: service.guests, [otherMeal]: otherService.guests };
    drawOperations();
    const snapshot = JSON.stringify([date, time, Math.floor(Date.now() / 60_000), service]);
    if (lastService !== snapshot) {
      drawService(service);
      lastService = snapshot;
    }
    byId('admin-data').hidden = false;
    return true;
  } catch (error) {
    if (epoch === renderEpoch) {
      dailyMeals = undefined;
      drawOperations();
      announce(adminFeedback, error.message);
    }
    return false;
  }
}

function showAvailability() {
  if (!guestDate.value) {
    byId('guest-availability').textContent = '請先選擇日期。';
    return;
  }
  const info = getAvailability(readDemo().bookings, guestDate.value, guestTime.value);
  const available = info.open && info.maxParty >= Number(guestParty.value);
  byId('guest-availability').textContent = !info.open
    ? '此入座時間已截止。'
    : available ? '可安排這組人數 · 空桌總共可接 ' + info.seats + ' 人。' : '這組人數目前沒有合適的空桌。';
}

function addBubble(text, customer = false) {
  messages.append(element('p', text, 'bubble' + (customer ? ' user' : '')));
  messages.scrollTop = messages.scrollHeight;
}

function drawChatChoices(response) {
  const choices = byId('chat-choices');
  choices.replaceChildren();
  for (const { action } of response.quickReply?.items ?? []) {
    if (action.type === 'message') {
      const button = element('button', action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        void sendChat({ type: 'text', text: action.text }, action.label).catch(error => addBubble(error.message));
      });
      choices.append(button);
    }
    if (action.type === 'datetimepicker') {
      const form = element('form', undefined, 'form-row');
      const input = element('input');
      input.type = 'date';
      input.setAttribute('aria-label', action.label);
      input.min = action.min;
      input.value = action.initial;
      input.required = true;
      const submit = element('button', '確定日期');
      submit.type = 'submit';
      form.append(input, submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const date = input.value;
        void sendChat({ type: 'postback', data: action.data, params: { date } }, '選擇 ' + date)
          .catch(error => addBubble(error.message));
      });
      choices.append(form);
    }
  }
  choices.hidden = !choices.childElementCount;
}

async function sendChat(message, shown = message.text) {
  if (shown) addBubble(shown, true);
  const response = await changeDemo(state => handleLineMessage(state, message, {
    user: guest, createId: () => createBookingNumber(state.bookings),
  }));
  addBubble(response.text);
  drawChatChoices(response);
  byId('quick-location').hidden = !(readDemo().locationRequests[guest]?.until > Date.now());
  showAvailability();
  await refreshAdmin();
  return response.text;
}

function navigate() {
  const lineSelected = demo && location.hash === '#line';
  if (lineSelected) stopPlayback();
  byId('line').hidden = !lineSelected;
  byId('admin').hidden = lineSelected;
  byId('nav-admin').toggleAttribute('aria-current', !lineSelected);
  byId('nav-line').toggleAttribute('aria-current', lineSelected);
  if (lineSelected) {
    byId('nav-line').setAttribute('aria-current', 'page');
    messages.scrollTop = messages.scrollHeight;
  } else {
    byId('nav-admin').setAttribute('aria-current', 'page');
    void refreshAdmin();
  }
}

fillTimes(timeSelect, MEALS[mealKey].times);
dateInput.value = demo ? sampleDate : today();
for (const [id, event] of [[dateInput, 'change'], [timeSelect, 'change']]) {
  id.addEventListener(event, () => {
    stopPlayback();
    announce(adminFeedback, '');
    void refreshAdmin();
  });
}
for (const button of mealButtons) {
  button.addEventListener('click', () => {
    stopPlayback();
    mealKey = button.dataset.meal;
    for (const item of mealButtons) item.setAttribute('aria-pressed', String(item === button));
    fillTimes(timeSelect, MEALS[mealKey].times);
    announce(adminFeedback, '');
    void refreshAdmin();
  });
}
window.addEventListener('hashchange', navigate);
setInterval(() => {
  if (!byId('admin').hidden) void refreshAdmin();
  if (demo && !byId('line').hidden) showAvailability();
}, 15_000);

if (demo) {
  demoState = readDemo();
  await changeDemo(() => {});
  guestDate.min = today();
  guestDate.value = sampleDate;
  fillTimes(guestTime, TIMES, true);
  guestParty.replaceChildren(...Array.from({ length: MAX_PARTY }, (_, index) => new Option(index + 1, index + 1)));
  guestParty.value = '2';
  for (const input of [guestDate, guestTime, guestParty]) {
    input.addEventListener('change', () => {
      announce(byId('guest-status'), '');
      showAvailability();
    });
  }
  showAvailability();
  addBubble('你好！可以直接問「明天晚上五點半，五位，有位嗎？」。每組最多用餐兩小時，入座前 30 分鐘截止。輸入 /help 可查看所有指令。');
  const sendText = text => sendChat({ type: 'text', text }).catch(error => addBubble(error.message));
  byId('quick-help').addEventListener('click', () => void sendText('/help'));
  byId('quick-find').addEventListener('click', () => void sendText('查詢 ' + (guestDate.value || sampleDate)));
  byId('quick-mine').addEventListener('click', () => void sendText('我的訂位'));
  byId('quick-book').addEventListener('click', () => void sendText('訂位'));
  byId('quick-location').hidden = !(readDemo().locationRequests[guest]?.until > Date.now());
  byId('quick-location').addEventListener('click', () => void sendChat(
    { type: 'location', latitude: 25.149, longitude: 121.774 }, '已傳送示例定位'
  ).catch(error => addBubble(error.message)));
  byId('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = byId('chat-input');
    const text = input.value.trim();
    if (text) void sendText(text);
    input.value = '';
  });
  reserveForm.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(reserveForm);
    const customer = data.get('customer');
    if (/[|｜]/.test(customer)) {
      announce(byId('guest-status'), '姓名請使用文字與空格。');
      return;
    }
    const button = reserveForm.querySelector('button');
    button.disabled = true;
    try {
      const command = ['訂位', data.get('date'), data.get('time'), data.get('party'), customer, '|', data.get('contact')].join(' ');
      const feedback = await sendChat({ type: 'text', text: command });
      announce(byId('guest-status'), feedback);
    } catch (error) {
      announce(byId('guest-status'), error.message);
    } finally {
      button.disabled = false;
    }
  });
  window.addEventListener('storage', event => {
    if (event.key !== storeKey) return;
    showAvailability();
    void refreshAdmin();
  });
} else {
  byId('navigation').hidden = true;
  byId('demo-note').hidden = true;
  byId('admin-data').hidden = true;
  byId('login').hidden = false;
  byId('login').addEventListener('submit', async event => {
    event.preventDefault();
    const input = byId('admin-key');
    adminKey = input.value;
    announce(adminFeedback, '');
    if (await refreshAdmin()) {
      input.value = '';
      byId('login').hidden = true;
      dateInput.focus();
    } else {
      adminKey = '';
    }
  });
}
navigate();
