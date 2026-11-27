export const reminderRecipient = contact =>
  typeof contact === 'string' && contact === contact.trim() &&
  /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(contact);

export function createGmailSender({ sender, clientId, clientSecret, refreshToken, request = fetch }) {
  if (![sender, clientId, clientSecret, refreshToken].every(Boolean) || !reminderRecipient(sender)) {
    throw new Error('Gmail 提醒需要完整的寄件地址和 OAuth 設定。');
  }

  let token, expiresAt;
  async function accessToken() {
    if (token && Date.now() < expiresAt) return token;
    const response = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        refresh_token: refreshToken, grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Gmail OAuth 無法授權。');
    const result = await response.json();
    if (!result.access_token) throw new Error('Gmail OAuth 未回傳存取權杖。');
    token = result.access_token;
    expiresAt = Date.now() + (result.expires_in - 60) * 1000;
    return token;
  }

  return async ({ to, subject, body }, stillCurrent) => {
    if (!reminderRecipient(to)) throw new Error('Gmail 收件地址無效。');
    let authorization;
    try {
      authorization = await accessToken();
    } catch {
      console.error('Gmail 提醒暫時無法取得 OAuth 授權。');
      return 'retry';
    }
    if (!stillCurrent()) return 'skipped';
    const lines = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g);
    const subjectBase64 = Buffer.from(subject, 'utf8').toString('base64');
    const mime = [
      'From: ' + sender,
      'To: ' + to,
      'Subject: =?UTF-8?B?' + subjectBase64 + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      ...lines,
      '',
    ].join('\r\n');

    const result = await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
      signal: AbortSignal.timeout(10_000),
    });
    if (result.ok) return 'sent';
    if (result.status === 401) token = undefined;
    console.error('Gmail 提醒寄送狀態', result.status);
    // Server failures and timeouts can occur after submission. Do not resend an uncertain delivery.
    if ([401, 403, 429].includes(result.status)) return 'retry';
    return 'unconfirmed';
  };
}
