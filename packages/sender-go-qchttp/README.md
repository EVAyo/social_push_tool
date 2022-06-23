# @sparanoid/eop-sender-telegram

Send processed data to Telegram

## Features

- Simple, fast, ESM by default
- Minimal dependencies, HTTPS requests by [got](https://github.com/sindresorhus/got)

## Usage

```js
import send from '@sparanoid/eop-sender-telegram';

const options = {
  payload: `json`, // `json` or `form`
  token: '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789',
  method: `sendMessage`,
};

const resp = await send(options, {
  chat_id: `1234567`,
  text: `Test from @sparanoid/eop-sender-telegram`
});

JSON.parse(resp.body).ok
//=> true
```

## License

AGPL-3.0
