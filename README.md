# A-SOUL

Full-featured social media monitor that extracts data from a variety of services and pushes updates to Telegram or other platforms

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
- [x] ddstats
- [x] tapechat
- [x] afdian

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
docker run --init \
  -v $(pwd)/config.js:/app/config.js:ro \
  -v $(pwd)/db:/app/db \
  sparanoid/a-soul -c config.js --color
  # ...or use ghcr.io registry
  ghcr.io/sparanoid/a-soul -c config.js --color
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

Your full `config.js` configuration may look like:

```js
export default {
  // Loop interval in milliseconds
  loopInterval: 60 * 1000,

  // A small amount of time to wait inserted before each account
  loopPauseTimeBase: 1000,

  // Math.random() time factor for `loopPauseTimeBase`
  loopPauseTimeRandomFactor: 2000,

  // 24 hours, if latest post older than this value, do not send notifications
  douyinBotThrottle: 24 * 3600 * 1000,
  douyinLiveBotThrottle: 1200 * 1000, // 20 mins

  // 65 mins, bilibili sometimes got limit rate for 60 mins.
  bilibiliBotThrottle: 65 * 60 * 1000,
  bilibiliLiveBotThrottle: 65 * 60 * 1000,

  weiboBotThrottle: 3600 * 1000,
  ddstatsBotThrottle: 3600 * 1000,
  tapechatBotThrottle: 3600 * 1000,

   // Custom proxy to bypass bilibili API rate limit
  rateLimitProxy: 'http://10.2.1.2:7890',
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
    // See https://github.com/Mrs4s/go-cqhttp to learn how to deploy qo-cqhttp
    // and send updates to QQ Guild
    apiBase: 'http://10.2.1.2:5700',
  },
  accounts: [
    {
      // Use `false` to disable checking this profile
      enabled: false,

      // Slug is used to identify accounts in logs
      slug: '嘉然',

      // Set to `true` to add `slug` at the beginning of the notification.
      // ie: #嘉然. Useful for pushing notifications with multiple accounts in
      // one channel
      showSlug: true,

      // bilibili account UID
      biliId: '672328094',

      // Check bilibili activity comments. Disabled by default
      // This fires another API to monitor comments and replies. It's not
      // recommended to enable this feature if you have a lot of accounts to
      // monitor or you will soon hit API rate limit.
      bilibiliFetchComments: true,

      // Douyin account ID
      douyinId: 'MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c',

      // Douyin live ID is separated and need to be calculated from `douyinId`
      douyinLiveId: '',

      // Weibo account ID
      weiboId: '7595006312',

      // Check Weibo activity comments. Disabled by default
      // This fires another API to monitor comments and replies. It's not
      // recommended to enable this feature if you have a lot of accounts to
      // monitor or you will soon hit API rate limit.
      weiboFetchComments: true,

      // Tape message box account ID. Usually the last part of your message
      // box's URL. ie. https://www.tapechat.net/uu/TDL6BG/EVWKIS0F the
      // `tapechatId` should be `EVWKIS0F`
      tapechatId: 'RQOPYMJQ',

      // Telegram chat/channel ID to receive notifications
      tgChannelId: 41205411,

      // QQ guild ID to receive notifications
      qGuildId: '12345678901234567',

      // QQ guild channel ID to receive notifications, `qGuildId` is also
      // required to identify which channel to be sent
      qGuildChannelId: 1234567,

      // Update Telegram chat/channel photo/avatar when user avatar updates in
      // included sources.
      tgChannelAvatarSource: ['weibo', 'bilibili'],

      // Show custom color output in console. Nothing useful
      color: '#e799b0',

      // Avoid chekcing bilibili live stream. Some accounts may not have live
      // stream ability
      disableBilibiliLive: false,

      // Avoid checking douyin live stream
      disableDouyinLive: false,

      // Disable checking DDStats. Some bilibili accounts may not have DDStats
      // feature enabled
      disableDdstats: false,
    },
    {
      enabled: true,
      slug: '贝拉',
      showSlug: true,
      biliId: '672353429',
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
