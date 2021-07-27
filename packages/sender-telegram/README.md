# @a-soul/sender-telegram

Send processed data to Telegram

## Features

- Simple, fast, ESM by default
- Minimal dependencies, HTTPS requests by [got](https://github.com/sindresorhus/got)

## Usage

```js
import send from '@a-soul/sender-telegram';

const options = {
  token: '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789',
  method: `sendMessage`,
  body: {
    chat_id: `1234567`,
    text: `Test from @a-soul/sender-telegram`
  },
};

const resp = await send(options);

JSON.parse(resp.body).ok
//=> true
```

## License

AGPL-3.0
