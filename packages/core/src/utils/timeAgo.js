import { formatDistanceToNowStrict } from 'date-fns';
// https://github.com/date-fns/date-fns/issues/2964
import { enUS, ja, zhCN, zhTW } from 'date-fns/locale/index.js';

const locales = {
  en_us: enUS,
  ja: ja,
  zh_cn: zhCN,
  zh_tw: zhTW,
};

export function timeAgo(timestamp, locale = 'en_us', suffix = true) {
  return formatDistanceToNowStrict(new Date(timestamp), {
    addSuffix: suffix,
    locale: locales[locale],
  });
}
