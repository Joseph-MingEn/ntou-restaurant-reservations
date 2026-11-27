import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';

const key = 'test-admin-key';
const secret = 'test-line-secret';
const event = (webhookEventId, text) => ({
  webhookEventId, type: 'message', replyToken: webhookEventId, mode: 'active',
  source: { type: 'user', userId: 'U123' }, message: { type: 'text', text },
});

async function setup(t) {
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
