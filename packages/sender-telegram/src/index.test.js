import { equal } from 'assert/strict';
import extract from './index.js';

const options = {
  // define `token` in GitHub secrets
  method: `sendMessage`,
  body: {
    chat_id: `41205411`,
    text: `Test from @a-soul/sender-telegram`,
    disable_notification: true
  },
};

const resp = await extract(options);

export function requestOk() {
  equal(JSON.parse(resp.body).ok, true);
};
