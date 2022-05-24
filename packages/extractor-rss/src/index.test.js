import { equal } from 'assert/strict';
import dotenv from 'dotenv'
import extract from './index.js';

dotenv.config()

const options = {}

const resp = await extract(`https://sparanoid.com/feed.xml`, options);

export function jsonContentExists() {
  equal(resp?.feed?.title, 'Sparanoid');
};
