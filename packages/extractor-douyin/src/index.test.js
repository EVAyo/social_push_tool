import { equal } from 'assert/strict';
import extract from './index.js';

const resp = await extract(`https://www.douyin.com/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c`);
const liveDesktopResp = await extract(`https://live.douyin.com/820648166099`);
const liveMobileResp = await extract(`https://webcast.amemv.com/webcast/reflow/6996256987986021157`);

export function jsonContentExists() {
  equal(resp?._location, '/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c');
};

export function jsonLiveDesktopContentExists() {
  equal(liveDesktopResp?.location, '/820648166099');
};

export function jsonLiveMobileContentExists() {
  equal(liveMobileResp?.['/webcast/reflow/:id']?.room?.owner?.web_rid, '820648166099');
};
