# A-SOUL

Extract data from services and push updates to Telegram or other platforms

## Features

- Monitor several services at the same time
- Support retry on failed connections
- Proxy support to avoid API rate limit
- Low memory footprint (~ 50 MB)
- ESM by default with minimal dependencies

## Supported Services (and plans)

- [x] bilibili
- [x] bilibili-live
- [x] douyin
- [x] douyin-live
- [ ] instagram
- [ ] tiktok
- [ ] tiktok-live
- [ ] twitter
- [x] weibo
- [ ] youtube
- [ ] youtube-live
- [ ] general-rss
- [ ] github

## Supported Senders

- [x] telegram

## System Requirements

- Node.js >= 16

## Usage

```bash
# Show general help
npx @a-soul/core -h

# Start from specific config file
npx @a-soul/core run -c config.js
```

## Configurations

Minimal `config.js`:

```js
{
  accounts: [
    {
      enabled: true,
      slug: '嘉然',
      biliId: '672328094',
    },
  ]
}
```

Your full `config.js` file may look like:

```js
{
  rateLimitProxy: 'http://10.2.1.2:7890',
  pluginOptions: {
    gotOptions: {
      timeout: {
        request: 3000
      },
    },
    cookies: {
      douyin: ``,
      // get `SESSDATA` cookie from https://www.bilibili.com/
      bilibili: `SESSDATA=XXX`,
      // get `SUB` cookie from https://m.weibo.cn/
      weibo: `SUB=XXX`,
    }
  },
  telegram: {
    enabled: true,
    token: ''
  },
  accounts: [
    {
      enabled: false,
      slug: '嘉然',
      biliId: '672328094',
      biliLiveId: '22637261',
      douyinId: 'MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c',
      douyinLiveId: '',
      weiboId: '7595006312',
      tgChannelID: 41205411,
      color: '#e799b0',
    },
    {
      enabled: true,
      slug: '贝拉',
      biliId: '672353429',
      biliLiveId: '22632424',
      douyinId: 'MS4wLjABAAAAlpnJ0bXVDV6BNgbHUYVWnnIagRqeeZyNyXB84JXTqAS5tgGjAtw0ZZkv0KSHYyhP',
      douyinLiveId: '820648166099',
      weiboId: '7594710405',
      tgChannelID: '41205411',
      color: '#bd7d74',
    },
  ]
}
```

## Development

You need to have [Yarn](https://yarnpkg.com/) installed first

```bash
# Install dependencies
yarn install

# Create config file
vi config.js

# Execute locally
yarn run start --once --verbose
```

## License

AGPL-3.0
