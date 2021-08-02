import { equal } from 'assert/strict';
import extract from './index.js';

const resp = await extract(`https://www.douyin.com/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c`);
const liveResp = await extract(`https://webcast.amemv.com/webcast/reflow/6988103996141488910`);

export function jsonContentExists() {
  equal(resp?._location, '/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c');
};

export function jsonLiveContentExists() {
  equal(liveResp?.['/webcast/reflow/:id']?.room?.owner?.short_id, 3819974253);
};
