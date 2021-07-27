import { equal } from 'assert/strict';
import extract from './index.js';

const url = `https://www.douyin.com/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c`;
const resp = await extract(url);

export function jsonContentExists() {
  equal(resp._location, '/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c');
};
