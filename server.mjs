import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleLineMessage } from './site/line.js?v=3';
import { cancelBooking, getService, setArrival } from './site/reservations.js?v=3';

const staticFiles = new Map([
  ['/admin', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['app', 'reservations', 'line'].map(name => [
    '/' + name + '.js', [name + '.js', 'text/javascript; charset=utf-8'],
  ]),
]);
const MAX_REQUEST_BYTES = 128_000;
const EVENT_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

function safeEqual(expected, actual) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { bookings: [], locationRequests: {}, events: {} };
  }
}

function persist(file, next) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tempFile = file + '.tmp';
  writeFileSync(tempFile, JSON.stringify(next), { mode: 0o600 });
  renameSync(tempFile, file);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_REQUEST_BYTES) chunks.push(chunk);
  }
  if (size > MAX_REQUEST_BYTES) throw new HttpError(413, '請求內容過大。');
  return Buffer.concat(chunks);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parse(raw) {
  try {
    const data = JSON.parse(raw.toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Report the same client error for syntactically invalid JSON.
  }
  throw new HttpError(400, '無效的 JSON 請求。');
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function replyToMessagingApi(token, message, accessToken) {
  const result = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken: token, messages: [message] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new HttpError(502, 'LINE 回覆服務暫時無法使用。');
}

export function createServer({
  dataFile = resolve('data/reservations.json'), adminKey = process.env.ADMIN_KEY,
  lineSecret = process.env.LINE_CHANNEL_SECRET, accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN,
  clock = () => new Date(),
  replyToLine = accessToken && ((token, message) => replyToMessagingApi(token, message, accessToken)),
} = {}) {
  let state = loadState(dataFile);
  const sending = new Set();

  function commit(next) {
    persist(dataFile, next);
    state = next;
  }

  async function processEvent(event) {
    if (event?.type !== 'message' || event.mode !== 'active' || event.source?.type !== 'user' ||
        typeof event.source.userId !== 'string' || typeof event.replyToken !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(event.webhookEventId ?? '') || !event.message) return;
    const id = event.webhookEventId;
    const user = 'line:' + event.source.userId;
    const now = clock();
    if (!Object.hasOwn(state.events, id)) {
      const next = structuredClone(state);
      for (const [key, value] of Object.entries(next.events)) {
        if (value.at <= +now - EVENT_HISTORY_MS) delete next.events[key];
      }
      for (const [key, value] of Object.entries(next.locationRequests)) {
        if (value.until <= +now) delete next.locationRequests[key];
      }
      const message = handleLineMessage(next, event.message, {
        user, now, createId: () => 'R-' + randomUUID().split('-').join('').toUpperCase(),
      });
      Object.defineProperty(next.events, id, {
        value: { at: +now, message }, writable: true, enumerable: true, configurable: true,
      });
      commit(next);
    }
    const message = state.events[id].message;
    if (!message || sending.has(id)) return;
    sending.add(id);
    try {
      await replyToLine(event.replyToken, message);
      const next = structuredClone(state);
      if (Object.hasOwn(next.events, id)) {
        delete next.events[id].message;
        commit(next);
      }
    } finally {
      sending.delete(id);
    }
  }

  return createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const { method, url } = request;
    try {
      const { pathname, searchParams } = new URL(url, 'http://localhost');
      if (method === 'GET' && pathname === '/') {
        response.writeHead(302, { Location: '/admin' }).end();
        return;
      }
      if (method === 'GET' && staticFiles.has(pathname)) {
        const [file, type] = staticFiles.get(pathname);
        response.writeHead(200, { 'Content-Type': type }).end(
          readFileSync(new URL('./site/' + file, import.meta.url))
        );
        return;
      }
      if (method === 'GET' && pathname === '/health') return json(response, 200, { ok: true });
      if (pathname.startsWith('/api/admin/')) {
        if (!adminKey) throw new HttpError(503, '業主金鑰尚未設定。');
        if (!safeEqual('Bearer ' + adminKey, request.headers.authorization)) {
          throw new HttpError(401, '業主金鑰不正確。');
        }
        if (method === 'GET' && pathname === '/api/admin/service') {
          try {
            const service = getService(state.bookings, searchParams.get('date'), searchParams.get('time'), clock());
            service.bookings = service.bookings.map(({ owner, ...booking }) => booking);
            return json(response, 200, service);
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        }
        if (method === 'POST' && pathname === '/api/admin/status') {
          const { id, status } = parse(await readBody(request));
          const next = structuredClone(state);
          try {
            if (status === 'cancelled') cancelBooking(next.bookings, id);
            else setArrival(next.bookings, id, status, clock());
          } catch (error) {
            throw new HttpError(400, error.message);
          }
          commit(next);
          return json(response, 200, { ok: true });
        }
      }
      if (method === 'POST' && pathname === '/line/webhook') {
        if (!lineSecret || !replyToLine) throw new HttpError(503, 'LINE Webhook 尚未設定。');
        const raw = await readBody(request);
        const expected = createHmac('sha256', lineSecret).update(raw).digest('base64');
        if (!safeEqual(expected, request.headers['x-line-signature'])) {
          throw new HttpError(401, 'LINE Webhook 簽章無效。');
        }
        const { events } = parse(raw);
        if (!Array.isArray(events)) throw new HttpError(400, '缺少 LINE 事件清單。');
        for (const event of events) await processEvent(event);
        return json(response, 200, { ok: true });
      }
      throw new HttpError(404, '找不到頁面。');
    } catch (error) {
      if (error instanceof HttpError) return json(response, error.status, { error: error.message });
      console.error('Server request failed:', error.code ?? error.name);
      return json(response, 500, { error: '伺服器暫時無法處理請求。' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  createServer().listen(port, host, () => console.log(`http://${host}:${port}/admin`));
}
