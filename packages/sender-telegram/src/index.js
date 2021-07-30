import got from 'got';
import merge from 'deepmerge';

async function send(userOptions = {}) {
  const options = merge({
    apiBase: `https://api.telegram.org/bot`,
    token: process.env.TELEGRAM_TOKEN,
    method: `sendMessage`,
    gotOptions: {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
      },
      retry: {
        limit: 3,
        methods: [
          'POST',
          'OPTIONS',
        ],
        statusCodes: [
          400,
          408,
          413,
          429,
          500,
          502,
          503,
          504,
          521,
          522,
          524
        ],
      }
    },
    body: {
      chat_id: ``,
      text: `Test from @a-soul/sender-telegram`,
    },
  }, userOptions);

  if (!options.token) { throw new Error(`Telegram bot token is missing`) };

  try {
    const resp = await got.post(`${options.apiBase}${options.token}/${options.method}`, {
      json: options.body,
      ...options.gotOptions
    });

    return resp;
  } catch (err) {
    console.log(err.response.body);
  }
}

export default send;
