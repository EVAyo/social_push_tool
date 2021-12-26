import got from 'got';
import merge from 'deepmerge';

async function send(userOptions = {}, userBody = {}) {
  const options = merge({
    apiBase: `http://localhost:5700`,
    token: process.env.GO_QCHTTP_TOKEN,
    method: `send_guild_channel_msg`,
    requestOptions: {
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
  }, userOptions);

  // if (!options.token) { throw new Error(`Telegram bot token is missing`) };

  const payload = {
    json: userBody,
  }

  try {
    const resp = await got.post(`${options.apiBase}/${options.method}`, {
      ...payload,
      ...options.requestOptions
    });

    return resp;
  } catch (err) {
    console.log(err);
  }
}

export default send;
