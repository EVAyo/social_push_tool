# @a-soul/extractor-tiktok

Pure `__NEXT_DATA__` data extractor/scraper for TikTok without using API.

## Features

- Simple, fast, ESM by default
- Minimal dependencies, HTTPS requests by [got](https://github.com/sindresorhus/got)

## Usage

```js
import extract from '@a-soul/extractor-tiktok';

const url = `https://www.tiktok.com/@minatoaqua`;
const resp = await extract(url);

console.log(resp.query.uniqueId);
//=> minatoaqua
```

## License

AGPL-3.0
