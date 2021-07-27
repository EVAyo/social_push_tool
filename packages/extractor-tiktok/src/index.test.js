import { equal } from 'assert/strict';
import extract from './index.js';

const url = `https://www.tiktok.com/@minatoaqua`;
const resp = await extract(url);

export function jsonContentExists() {
  equal(resp.query.uniqueId, 'minatoaqua');
};
