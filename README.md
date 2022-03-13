# A-SOUL

Extract data from services and push updates to Telegram or other platforms

- [Docker Hub](https://hub.docker.com/r/sparanoid/a-soul)
- [ghcr.io](https://github.com/users/sparanoid/packages/container/package/a-soul)

## Features

- Monitor several services at the same time
- Support retry on failed connections
- Proxy support to avoid API rate limit
- Low memory footprint (About 50 MB for a single account, 120 MB for 20 accounts with multiple services)
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
- [x] go-cqhttp (QQ Guild)

## System Requirements

- Node.js >= 16

## Usage

Run with npx:

```bash
# Show general help
npx @a-soul/core -h

# Start from specific config file
npx @a-soul/core run -c config.js
```

Run with Docker:

```bash
docker run \
  -v $(pwd)/config.js:/app/config.js:ro \
  -v $(pwd)/db:/app/db \
  -v $(pwd)/cache:/app/cache \
  sparanoid/a-soul -c config.js --color
```

## Configurations

Minimal `config.js`:

```js
export default {
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
export default {
  loopInterval: 60 * 1000, // ms
  douyinBotThrottle: 24 * 3600 * 1000, // 24 hours, if latest post older than this value, do not send notifications
  douyinLiveBotThrottle: 1200 * 1000, // 20 mins
  bilibiliBotThrottle: 65 * 60 * 1000, // 65 mins, bilibili sometimes got limit rate for 60 mins.
  bilibiliLiveBotThrottle: 65 * 60 * 1000,
  weiboBotThrottle: 3600 * 1000,
  rateLimitProxy: 'http://10.2.1.2:7890', // Custom proxy to bypass bilibili API rate limit
  pluginOptions: {
    requestOptions: {
      timeout: {
        request: 3000
      },
    },
    customCookies: {
      // Nov 11, 2021
      // Douyin main site now requires `__ac_nonce` and `__ac_signature` to work
      douyin: `__ac_nonce=XXX; __ac_signature=XXX;`,
      // get `SESSDATA` cookie from https://www.bilibili.com/
      bilibili: `SESSDATA=XXX`,
      // get `SUB` cookie from https://m.weibo.cn/
      weibo: `SUB=XXX`,
    }
  },
  telegram: {
    enabled: true,
    apiBase: 'https://api.telegram.org/bot',
    token: ''
  },
  qGuild: {
    enabled: true,
    // go-cqhttp endpoint
    // See https://github.com/Mrs4s/go-cqhttp to learn how to deploy qo-cqhttp and send updates to QQ Guild
    apiBase: 'http://10.2.1.2:5700',
  },
  accounts: [
    {
      // Use `false` to disable checking this profile
      enabled: false,
      slug: '嘉然',
      // Set to `true` to add `slug` at the beginning of the notification. ie: #嘉然
      // Useful for pushing notifications with multiple accounts in one channel
      showSlug: true,
      biliId: '672328094',
      biliLiveId: '22637261',
      douyinId: 'MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c',
      douyinLiveId: '',
      weiboId: '7595006312',
      tgChannelId: 41205411,
      qGuildId: '12345678901234567',
      qGuildChannelId: 1234567,
      // Show custom color output in console. Nothing useful
      color: '#e799b0',
    },
    {
      enabled: true,
      slug: '贝拉',
      showSlug: true,
      biliId: '672353429',
      biliLiveId: '22632424',
      douyinId: 'MS4wLjABAAAAlpnJ0bXVDV6BNgbHUYVWnnIagRqeeZyNyXB84JXTqAS5tgGjAtw0ZZkv0KSHYyhP',
      douyinLiveId: '820648166099',
      weiboId: '7594710405',
      tgChannelId: '41205411',
      color: '#bd7d74',
    },
  ]
}
```

## Development

You need to have [Yarn](https://yarnpkg.com/) installed first:

```bash
# Install dependencies
yarn install

# Create config file
vi config.js

# Execute locally
yarn run start --once --verbose
```

## FAQ

### Why this name?

The original intention of this project was to monitor updates of a Chinese VTuber group [A-SOUL](https://virtualyoutuber.fandom.com/wiki/A-soul).

### Why not executing checks in parallel?

Most services have API limits or rate limits. Executing checks in parallel only make sense with small amount of accounts.

## License

AGPL-3.0
