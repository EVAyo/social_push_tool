import { equal } from 'assert/strict';
import dotenv from 'dotenv'
import extract from './index.js';

dotenv.config()

const options = {
  cookies: process.env.DOUYIN_COOKIES
}

const resp = await extract(`https://www.douyin.com/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c`, options);
const liveDesktopResp = await extract(`https://live.douyin.com/820648166099`, options);

export function jsonContentExists() {
  // Douyin trends to change object key regularly. (ie. C_10, C_12, C_14)
  // I need to find a static property to pin specific object
  let data = {};
  for (const obj in resp) {
    if (resp[obj].hasOwnProperty('uid')) {
      data = resp[obj];
    }
  }

  equal(data?.uid, 'MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c');
};

export function jsonLiveDesktopContentExists() {
  equal(liveDesktopResp?.location, '/820648166099');
};
