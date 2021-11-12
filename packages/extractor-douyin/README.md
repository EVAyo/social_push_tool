# @a-soul/extractor-douyin

Pure `RENDER_DATA` data extractor/scraper for Douyin without using API.

## Features

- Simple, fast, ESM by default
- Minimal dependencies, HTTPS requests by [got](https://github.com/sindresorhus/got)

## Usage

```js
import extract from '@a-soul/extractor-douyin';

const url = `https://www.douyin.com/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c`;
const resp = await extract(url);

console.log(resp._location);
//=> /user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c
```

## Options

```js
const options = {
  mobileUserAgent: `got`,
  desktopUserAgent: `got`,
  requestOptions: {
    timeout: {
      request: 3000
    },
    retry: {
      limit: 3,
    }
  }
}
await extract(url, options);
```

## License

AGPL-3.0
