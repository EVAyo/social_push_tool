#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { setTimeout } from 'timers/promises';
import { setIntervalAsync } from 'set-interval-async/fixed/index.js';

import got from 'got';
import chalk from 'chalk';
import merge from 'deepmerge';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Low, JSONFile } from 'lowdb';
import { HttpsProxyAgent } from 'hpagent';

import { formatDate, stripHtml, convertWeiboUrl } from './utils.js';
import { timeAgo } from './utils/timeAgo.js';

import TelegramBot from '@a-soul/sender-telegram';
import dyExtract from '@a-soul/extractor-douyin';

const argv = yargs(hideBin(process.argv))
  .command('run', 'Extract new posts from services', {
    once: {
      description: 'Only run once',
      type: 'boolean',
    },
    json: {
      description: 'Write JSON response to disk for debugging',
      type: 'boolean',
    }
  })
  .option('config', {
    alias: 'c',
    description: 'User configuration file',
    type: 'string',
  })
  .option('verbose', {
    description: 'Show verbose log',
    type: 'boolean',
  })
  .help()
  .alias('help', 'h')
  .argv;

async function generateConfig() {
  console.log(`cwd`, process.cwd());

  const userConfig = argv.config ? await import(`${process.cwd()}/${argv.config}`) : { default: {}};
  const defaultConfig = {
    loopInterval: 60 * 1000, // n seconds
    pluginOptions: {
      requestOptions: {
        timeout: {
          request: 10000
        }
      }
    },
    douyinBotThrottle: 24 * 3600 * 1000, // seconds, if latest post older than n secs, do not send notifications
    douyinLiveBotThrottle: 1200 * 1000, // 20 mins
    bilibiliBotThrottle: 65 * 60 * 1000, // 65 mins, bilibili sometimes got limit rate for 60 mins.
    bilibiliLiveBotThrottle: 65 * 60 * 1000,
    weiboBotThrottle: 3600 * 1000,
    rateLimitProxy: '',
    telegram: {
      enabled: true,
      silent: false,
      token: '',
    },
    accounts: []
  };

  return merge(defaultConfig, userConfig.default);
}

// Merge default configs and user configs
const config = await generateConfig();
// const userConfig = argv.config ? JSON.parse(fs.readFileSync(argv.config)) : {};

function headerOnDemand(cookie) {
  return {
    headers: {
      Cookie: cookie
    }
  }
}

async function sendTelegram(userOptions, userContent) {
  const options = merge({
    token: config.telegram.token,
    apiBase: config.telegram.apiBase,
    requestOptions: {
      retry: {
        limit: 3,
      }
    },
  }, userOptions);

  try {
    const resp = await TelegramBot(options, userContent);
    return resp?.body && JSON.parse(resp.body);
  } catch (err) {
    console.log(err);
  }
}

// TODO: WIP
async function send(account, messageType, userOptions) {
  const messageTypeMap = {
    text: {
      telegram: 'sendMessage'
    },
    gallery: {
      telegram: 'sendPhoto'
    },
    gallery: {
      telegram: 'sendPhoto'
    },
    video: {
      telegram: 'sendVideo'
    },
  }

  const tgOptions = merge({
    token: config.telegram.token,
    method: messageTypeMap[messageType].telegram,
    body: {
      chat_id: account.tgChannelID,
      text: `Test from @a-soul/sender-telegram`,
      disable_notification: config.telegram.silent
    },
  }, userOptions.telegramOptions);

  const resp = await TelegramBot(tgOptions);
  return resp?.body && JSON.parse(resp.body);
}

async function main(config) {
  // Initial database
  const db = new Low(new JSONFile(path.join(path.resolve(), 'db/db.json')));

  // const url = 'https://www.douyin.com/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c';

  console.log(`\n# Check loop started at ${formatDate(Date.now())} ------------`);

  for (let i = 0; i < config.accounts.length; i++) {
    const account = config.accounts[i];

    const logName = chalk.hex('#000').bgHex(account?.color ?? '#fff');

    function log(msg, type) {
      console.log(`${logName(account.slug)} ${msg}`);
    }

    // Only check enabled account
    if (account?.enabled) {
      // Set random request time to avoid request limit
      await setTimeout(1000 + Math.floor(Math.random() * 2000));

      argv.verbose && log(`is checking...`);

      // Read from database
      await db.read();
      db.data ||= {};
      argv.verbose && log(`db read`);

      // Initial database structure
      db.data[account.slug] ||= {};
      const dbScope = db.data[account.slug];

      // Initialize proxy randomly to avoid bilibili rate limit
      // .5 - 50% true
      const proxyOptions = config?.rateLimitProxy && Math.random() < .5 ? {
        agent: {
          https: new HttpsProxyAgent({
            keepAlive: false,
            keepAliveMsecs: 1000,
            maxSockets: 256,
            maxFreeSockets: 256,
            scheduling: 'lifo',
            proxy: config.rateLimitProxy
          })
        }
      } : {};

      // Fetch Douyin live
      account.douyinLiveId && await dyExtract(`https://live.douyin.com/${account.douyinLiveId}`, config.pluginOptions).then(async resp => {
        const json = resp?.initialState?.roomStore?.roomInfo;

        if (json) {
          const status = json?.room?.status;
          const id_str = json?.room?.id_str;

          if (status === 2) {
            argv.verbose && log(`douyin-live seems started, begin second check...`);

            await dyExtract(`https://webcast.amemv.com/webcast/reflow/${id_str}`, config.pluginOptions).then(async resp => {
              const currentTime = Date.now();
              const json = resp?.['/webcast/reflow/:id'];

              if (json?.room) {
                argv.json && fs.writeFile(`db/${account.slug}-douyin-live.json`, JSON.stringify(json, null, 2), err => {
                  if (err) return console.log(err);
                });

                const {
                  id_str,
                  title,
                  cover,
                  create_time,
                  stream_url,
                } = json.room;

                const {
                  nickname,
                  web_rid,
                  sec_uid,
                  id,
                  short_id,
                  signature,
                  avatar_large,
                  authentication_info,
                } = json.room.owner;

                const liveCover = cover?.url_list?.[0];
                const timestamp = create_time * 1000;
                const streamUrl = Object.values(stream_url.hls_pull_url_map)[0];

                const dbStore = {
                  nickname: nickname,
                  uid: sec_uid,
                  scrapedTime: new Date(currentTime),
                  sign: signature,
                  latestStream: {
                    liveStatus: status,
                    liveStarted: timestamp,
                    liveRoom: id_str,
                    liveTitle: title,
                    liveCover: liveCover,
                    isTgSent: dbScope?.douyin_live?.latestStream?.isTgSent,
                  },
                  streamFormats: stream_url.candidate_resolution,
                  streamUrl: streamUrl,
                };

                if (json?.room?.status === 2) {
                  log(`douyin-live started: ${title} (${timeAgo(timestamp)})`);

                  const tgOptions = {
                    method: 'sendPhoto',
                  };

                  const tgBody = {
                    chat_id: account.tgChannelID,
                    photo: liveCover,
                    caption: `#抖音开播：${title}`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {text: 'Watch', url: `https://webcast.amemv.com/webcast/reflow/${id_str}`},
                          {text: `M3U8`, url: `${streamUrl}`},
                        ],
                        [
                          {text: 'Artwork', url: liveCover},
                          {text: `${nickname}`, url: `https://live.douyin.com/${account.douyinLiveId}`},
                        ],
                      ]
                    },
                  }

                  if (account.tgChannelID && config.telegram.enabled) {

                    if (dbScope?.douyin_live?.latestStream?.isTgSent) {
                      log(`douyin-live notification sent, skipping...`);
                    } else if ((currentTime - timestamp) >= config.douyinLiveBotThrottle) {
                      log(`douyin-live too old, notifications skipped`);
                    } else {
                      // This function should be waited since we rely on the `isTgSent` flag
                      await sendTelegram(tgOptions, tgBody).then(resp => {
                        // log(`telegram post douyin-live success: message_id ${resp.result.message_id}`)
                        dbStore.latestStream.isTgSent = true;
                      })
                      .catch(err => {
                        log(`telegram post douyin-live error: ${err?.response?.body || err}`);
                      });
                    }
                  }
                } else {
                  log(`douyin-live not started yet (2nd check)`);
                  dbStore.latestStream.isTgSent = false;
                }

                // Set new data to database
                dbScope['douyin_live'] = dbStore;
              } else {
                log(`douyin-live stream info corrupted, skipping...`);
              }
            });
          } else {
            // TODO: Simplify make sure isTgSent set to false if not current live on first check
            // Need better solution
            const dbStore = {
              latestStream: {
                isTgSent: false,
              },
            }
            log(`douyin-live not started yet`);
            dbScope['douyin_live'] = dbStore;
          }
        } else {
          log(`douyin-live info corrupted, skipping...`);
        }
      }).catch(err => {
        console.log(err);
      });

      // Fetch Douyin
      account.douyinId && await dyExtract(`https://www.douyin.com/user/${account.douyinId}`, config.pluginOptions).then(async resp => {
        const currentTime = Date.now();

        // Douyin trends to change object key regularly. (ie. C_10, C_12, C_14)
        // I need to find a static property to pin specific object
        let json = {};
        for (const obj in resp) {
          if (resp[obj].hasOwnProperty('uid')) {
            json = resp[obj];
          }
        }

        const userMeta = json?.user?.user;
        const posts = json?.post?.data;

        if (userMeta && posts?.length > 0) {
          const {
            uid,
            secUid,
            nickname,
            desc: sign,
            avatarUrl: avatar,
            followingCount: following,
            followerCount: followers,
          } = userMeta;

          argv.json && fs.writeFile(`db/${account.slug}-douyin.json`, JSON.stringify(json, null, 2), err => {
            if (err) return console.log(err);
          });

          // Sort all posts by `createTime` to avoid sticky (aka. 置顶) posts and get the latest one
          // const post = posts[i]; // Used to store in array and detect `isTop` in loop
          const post = posts.sort((a, b) => b.createTime - a.createTime)?.[0];

          // If latest post exists
          if (post) {
            const {
              awemeId: id,
              authorInfo: postAuthorMeta,
              desc: title,
              textExtra: tags,
              tag: postMeta,
              shareInfo: {
                shareUrl
              },
              stats,
            } = post;
            const timestamp = post.createTime * 1000;
            const cover = `https:${post?.video.dynamicCover}`;
            const videoUrl = `https:${post?.video?.playAddr[0].src}`;

            const dbStore = {
              nickname: nickname,
              uid: uid,
              scrapedTime: new Date(currentTime),
              sign: sign,
              following: following,
              followers: followers,
              latestPost: {
                id: id,
                title: title,
                timestamp: new Date(timestamp),
                timestampUnix: timestamp,
                timeAgo: timeAgo(timestamp),
                cover: cover,
                videoUrl: videoUrl,
                shareUrl: shareUrl,
              }
            };

            const tgOptions = {
              method: 'sendVideo',
            };

            const tgBody = {
              chat_id: account.tgChannelID,
              video: videoUrl,
              caption: `#抖音视频：${title} #${id}`,
              reply_markup: {
                inline_keyboard: [
                  [
                    {text: 'Watch', url: shareUrl},
                    {text: 'Artwork', url: cover},
                    {text: `${nickname}`, url: `https://www.douyin.com/user/${secUid}`},
                  ],
                ]
              },
            }
            // Check if this is a new post compared to last scrap
            if (id !== dbScope?.douyin?.latestPost?.id && timestamp > dbScope?.douyin?.latestPost?.timestampUnix) {
              log(`douyin got update: ${id} (${timeAgo(timestamp)}) ${title}`);

              // Send bot message
              if (account.tgChannelID && config.telegram.enabled) {

                if ((currentTime - timestamp) >= config.douyinBotThrottle) {
                  log(`douyin latest post too old, notifications skipped`);
                } else {
                  await sendTelegram(tgOptions, tgBody).then(resp => {
                    // log(`telegram post douyin success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post douyin error: ${err?.response?.body || err}`);
                  });
                }
              }
            } else {
              log(`douyin no update. latest: ${id} (${timeAgo(timestamp)})`);
            }

            // Set new data to database
            dbScope['douyin'] = dbStore;
          }
        } else {
          log(`douyin scraped data corrupted, skipping...`);
        }
      }).catch(err => {
        console.log(err);
      });

      // Fetch bilibili live
      account.biliId && await got(`https://api.bilibili.com/x/space/acc/info?mid=${account.biliId}`, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data;
          const {
            live_room: room,
            fans_medal, // 直播间粉丝牌
            official, // 认证状态
            vip, // 大会员状态
            pendant, // 粉丝装扮
            nameplate, // 个人勋章
            mid: uid,
            name: nickname,
            sign,
            face: avatar,
          } = data;

          const {
            liveStatus,
            roomid: liveId,
            url: liveRoom,
            title: liveTitle,
            cover: liveCover,
          } = room;

          // Avatar URL is not reliable, URL may change because of CDN
          const avatarHash = avatar && new URL(avatar);

          // Space API ocassionally returns a default name (bilibili). Skip processing when ocurrs
          if (nickname === 'bilibili') {
            log(`data valid but content is corrupt. nickname === 'bilibili'`);
            return;
          }

          argv.json && fs.writeFile(`db/${account.slug}-bilibili-user.json`, JSON.stringify(json, null, 2), err => {
            if (err) return console.log(err);
          });

          const dbStore = {
            nickname: nickname,
            uid: uid,
            scrapedTime: new Date(currentTime),
            avatar: avatarHash?.pathname,
            sign: sign,
            latestStream: {
              liveStatus: liveStatus,
              liveRoom: liveRoom,
              liveTitle: liveTitle,
              liveCover: liveCover,
              isTgSent: dbScope?.bilibili_live?.latestStream?.isTgSent,
            },
            fans_medal: fans_medal,
            official: official,
            vip: vip,
            pendant: pendant,
            nameplate: nameplate,
          };

          const tgOptions = {
            method: 'sendPhoto',
          };

          const tgBody = {
            chat_id: account.tgChannelID,
            photo: liveCover,
            caption: `#b站开播：${liveTitle}`,
            reply_markup: {
              inline_keyboard: [
                [
                  {text: 'Watch', url: liveRoom},
                  {text: 'Artwork', url: liveCover},
                  {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                ],
              ]
            },
          };

          // If user nickname update
          if (nickname !== 'bilibili' && nickname !== dbScope?.bilibili_live?.nickname && dbScope?.bilibili_live?.nickname) {
            log(`bilibili-live user nickname updated: ${nickname}`);

            if (account.tgChannelID && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelID,
                text: `#b站昵称更新\n新：${nickname}\n旧：${dbScope?.bilibili_live?.nickname}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live::nickname success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::nickname error: ${err?.response?.body || err}`);
              });
            }
          }

          // If user sign update
          if (nickname !== 'bilibili' && sign !== dbScope?.bilibili_live?.sign && dbScope?.bilibili_live?.sign) {
            log(`bilibili-live user sign updated: ${sign}`);

            if (account.tgChannelID && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelID,
                text: `#b站签名更新\n新：${sign}\n旧：${dbScope?.bilibili_live?.sign}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live::sign success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::sign error: ${err?.response?.body || err}`);
              });
            }
          }

          // If user avatar update
          if (nickname !== 'bilibili' && avatarHash?.pathname !== dbScope?.bilibili_live?.avatar && dbScope?.bilibili_live?.avatar) {
            log(`bilibili-live user avatar updated: ${avatar}`);

            if (account.tgChannelID && config.telegram.enabled) {

              await sendTelegram({ method: 'sendPhoto' }, {
                chat_id: account.tgChannelID,
                photo: avatar,
                caption: `#b站头像更新，老头像：${dbScope?.bilibili_live?.avatar}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live::avatar success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::avatar error: ${err?.response?.body || err}`);
              });
            }
          }

          // 1: live
          // 0: not live
          if (room?.liveStatus === 1) {

            // Deprecated v1 API, may be changed in the future
            await got(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${liveId}`, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
              const json = JSON.parse(resp.body);

              if (json?.code === 0) {
                const data = json.data;
                const timestamp = data.live_time * 1000;

                argv.json && fs.writeFile(`db/${account.slug}-bilibili-live.json`, JSON.stringify(json, null, 2), err => {
                  if (err) return console.log(err);
                });

                // Always returns -62170012800 when stream not start
                if (data.live_time > 0) {
                  dbStore.latestStream.timestamp = new Date(timestamp);
                  dbStore.latestStream.timestampUnix = timestamp;
                  dbStore.latestStream.timeAgo = timeAgo(timestamp);

                  log(`bilibili-live started: ${liveTitle} (${timeAgo(timestamp)})`);
                }

                if (account.tgChannelID && config.telegram.enabled) {

                  if (dbScope?.bilibili_live?.latestStream?.isTgSent) {
                    log(`bilibili-live notification sent, skipping...`);
                  } else if ((currentTime - timestamp) >= config.bilibiliLiveBotThrottle) {
                    log(`bilibili-live too old, notifications skipped`);
                  } else {
                    // This function should be waited since we rely on the `isTgSent` flag
                    await sendTelegram(tgOptions, tgBody).then(resp => {
                      // log(`telegram post bilibili-live success: message_id ${resp.result.message_id}`)
                      dbStore.latestStream.isTgSent = true;
                    })
                    .catch(err => {
                      log(`telegram post bilibili-live error: ${err?.response?.body || err}`);
                    });
                  }
                }
              } else {
                log('bilibili-live stream info corrupted, skipping...');
              };
            })
            .catch(err => {
              log(`bilibili-live stream info request error: ${err?.response?.body || err}`);
            });
          } else {
            log(`bilibili-live not started yet`);
            dbStore.latestStream.isTgSent = false;
          }

          // Set new data to database
          dbScope['bilibili_live'] = dbStore;
        } else {
          log('bilibili-live user info corrupted, skipping...');
        }
      })
      .catch(err => {
        log(`bilibili-live user info request error: ${err?.response?.body || err}`);
      });

      // Fetch bilibili microblog (dynamics)
      account.biliId && await got(`https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${account.biliId}&offset_dynamic_id=0&need_top=0&platform=web`, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data;
          const cards = data?.cards;

          if (cards) {
            const card = cards[0];

            const cardMeta = card.desc;
            const cardJson = JSON.parse(card.card);

            const {
              uid,
              type,
              orig_type: origType,
              dynamic_id_str: dynamicId,
              user_profile: user
            } = cardMeta;
            const timestamp = cardMeta.timestamp * 1000;

            argv.json && fs.writeFile(`db/${account.slug}-bilibili-mblog.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            const dbStore = {
              scrapedTime: new Date(currentTime),
              user: user,
              latestDynamic: {
                id: dynamicId,
                type: type,
                timestamp: new Date(timestamp),
                timestampUnix: timestamp,
                timeAgo: timeAgo(timestamp),
              }
            };

            // NOTE: card content (mblog content) is escaped inside JSON,
            // uncomment the following to output parsed JSON for debugging
            // if (account.slug === '测试账号') {
            //   log(`cardJson`);
            //   console.log(cardJson);
            // };

            // If latest post is newer than the one in database
            if (dynamicId !== dbScope?.bilibili_mblog?.latestDynamic?.id && timestamp > dbScope?.bilibili_mblog?.latestDynamic?.timestampUnix) {
              const tgOptions = {
                method: 'sendMessage',
              };

              const tgBody = {
                chat_id: account.tgChannelID,
                text: `${user.info.uname} #b站动态`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: 'View', url: `https://t.bilibili.com/${dynamicId}`},
                      {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              };

              // Check post type
              // https://www.mywiki.cn/dgck81lnn/index.php/%E5%93%94%E5%93%A9%E5%93%94%E5%93%A9API%E8%AF%A6%E8%A7%A3
              //
              // Forwarded post (think retweet)
              if (type === 1) {
                const originJson = JSON.parse(cardJson?.origin);

                // console.log(originJson);

                // Column post
                if (originJson?.origin_image_urls) {
                  tgOptions.method = 'sendPhoto';
                  tgBody.photo = `${originJson?.origin_image_urls}`;
                  tgBody.caption = `#b站专栏转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.author.name}\n被转标题：${originJson.title}\n\n${originJson.summary}`;
                }

                // Text with gallery
                else if (originJson?.item?.description && originJson?.item?.pictures) {
                  // console.log(originJson?.item.pictures);

                  // NOTE: Change the following to `> 1` to enable
                  if (originJson?.item?.pictures_count > 99) {
                    // TODO: sendMediaGroup doesn't support reply_markup. You have to use a seperate message
                    tgOptions.method = 'sendMediaGroup';
                    tgBody.media = originJson?.item?.pictures.map((pic, idx) => ({
                      type: 'photo',
                      // Limit image size with original server and webp: failed (Bad Request: group send failed)
                      // media: pic.img_width > 1036 || pic.img_height > 1036 ? `${pic.img_src}@1036w.webp` : `${pic.img_src}`,

                      // Use wp.com proxy to serve image: failed (Bad Request: group send failed)
                      // media: `https://i0.wp.com/${pic.img_src.replace('https://').replace('http://')}?w=200`,

                      // Use my own proxy and webp prefix from bilibili: sucess
                      media: `https://experiments.sparanoid.net/imageproxy/1000x1000,fit/${pic.img_src}@1036w.webp`,
                    }));

                    // Only apply caption to the first image to make it auto shown on message list
                    tgBody.media[0].caption = `#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.name}\n被转内容：${originJson.item.description}`;

                    // Debug payload
                    // console.log(tgBody.media);
                    // tgBody.media = [
                    //   {
                    //     type: 'photo',
                    //     media: `https://i0.hdslb.com/bfs/album/e2052046af707d686783ca5c78533e04e6ef4b86.jpg`,
                    //   },
                    //   {
                    //     type: 'photo',
                    //     media: `https://i0.hdslb.com/bfs/album/e2052046af707d686783ca5c78533e04e6ef4b86.jpg`,
                    //   },
                    //   {
                    //     type: 'photo',
                    //     media: `https://i0.hdslb.com/bfs/album/e2052046af707d686783ca5c78533e04e6ef4b86.jpg`,
                    //   },
                    //   {
                    //     type: 'photo',
                    //     media: `https://i0.hdslb.com/bfs/album/e2052046af707d686783ca5c78533e04e6ef4b86.jpg`,
                    //   },
                    // ];
                  } else {
                    tgOptions.method = 'sendPhoto';
                    if (originJson?.item?.pictures[0].img_width > 1200 || originJson?.item?.pictures[0].img_height > 1200) {
                      tgBody.photo = `https://experiments.sparanoid.net/imageproxy/1000x1000,fit/${originJson?.item?.pictures[0].img_src}@1036w.webp`;
                    } else {
                      tgBody.photo = `${originJson?.item?.pictures[0].img_src}`;
                    }
                    tgBody.caption = `#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.name}\n被转内容：${originJson.item.description}`;
                  }
                }

                // Video
                else if (originJson?.duration && originJson?.videos) {
                  tgOptions.method = 'sendPhoto';
                  tgBody.photo = `${originJson?.pic}`;
                  tgBody.caption = `#b站视频转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}`;
                }

                // Plain text
                else {
                  tgBody.text = `#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.uname}\n被转动态：${originJson.item.content}`;
                }

                log(`bilibili-mblog got forwarded post (${timeAgo(timestamp)})`);
              }

              // Gallery post (text post with images)
              else if (type === 2 && cardJson?.item?.pictures.length > 0) {
                const photoCount = cardJson.item.pictures.length;
                const photoCountText = photoCount > 1 ? `（共 ${photoCount} 张）` : ``;
                tgOptions.method = 'sendPhoto';
                tgBody.caption = `#b站相册动态${photoCountText}：${cardJson?.item?.description}`;
                tgBody.photo = cardJson.item.pictures[0].img_src;
                log(`bilibili-mblog got gallery post (${timeAgo(timestamp)})`);
              }

              // Text post
              else if (type === 4) {
                tgBody.text = `#b站动态：${cardJson?.item?.content.trim()}`;
                log(`bilibili-mblog got text post (${timeAgo(timestamp)})`);
              }

              // Video post
              else if (type === 8) {
                tgOptions.method = 'sendPhoto';
                tgBody.photo = cardJson.pic;
                // dynamic: microblog text
                // desc: video description
                tgBody.caption = `#b站视频：${cardJson.title}\n${cardJson.dynamic}\n${cardJson.desc}`,
                tgBody.reply_markup = {
                  inline_keyboard: [
                    [
                      {text: 'View', url: `https://t.bilibili.com/${dynamicId}`},
                      {text: 'Watch Video', url: `${cardJson.short_link}`},
                      {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                };

                log(`bilibili-mblog got video post (${timeAgo(timestamp)})`);
              }

              // VC video post (think ticktok)
              else if (type === 16) {
                log(`bilibili-mblog got vc video post (${timeAgo(timestamp)})`);
              }

              // Column post
              else if (type === 64) {
                tgOptions.method = 'sendPhoto';
                tgBody.photo = cardJson.origin_image_urls[0];
                tgBody.caption = `#b站专栏：${cardJson.title}\n\n${cardJson.summary}`;

                log(`bilibili-mblog got column post (${timeAgo(timestamp)})`);
              }

              // Audio post
              else if (type === 256) {
                log(`bilibili-mblog got audio post (${timeAgo(timestamp)})`);
              }

              // Share audio bookmark
              else if (type === 2048) {
                log(`bilibili-mblog got share audio bookmark (${timeAgo(timestamp)})`);
              }

              // Share video bookmark
              else if (type === 4300) {
                log(`bilibili-mblog got share video bookmark (${timeAgo(timestamp)})`);
              }

              // Others
              else {
                log(`bilibili-mblog got unkown type (${timeAgo(timestamp)})`);
              }

              if (account.tgChannelID && config.telegram.enabled) {

                if ((currentTime - timestamp) >= config.bilibiliBotThrottle) {
                  log(`bilibili-mblog too old, notifications skipped`);
                } else {
                  await sendTelegram(tgOptions, tgBody).then(resp => {
                    // log(`telegram post bilibili-mblog success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post bilibili-mblog error: ${err?.response?.body || err}`);
                  });
                }
              }
            } else if (dynamicId !== dbScope?.bilibili_mblog?.latestDynamic?.id && timestamp < dbScope?.bilibili_mblog?.latestDynamic?.timestampUnix) {
              log(`bilibili-mblog new post older than database. latest: ${dynamicId} (${timeAgo(timestamp)})`);

              if (account.tgChannelID && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelID,
                  text: `#b站动态删除：监测到最新动态旧于数据库中的动态，可能有动态被删除（也存在网络原因误报）`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: 'Latest', url: `https://t.bilibili.com/${dynamicId}`},
                        {text: 'Deleted', url: `https://t.bilibili.com/${dbScope?.bilibili_mblog?.latestDynamic?.id}`},
                        {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ]
                  },
                }).then(resp => {
                  // log(`telegram post bilibili-mblog success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post bilibili-mblog error: ${err?.response?.body || err}`);
                });
              }

            } else {
              log(`bilibili-mblog no update. latest: ${dynamicId} (${timeAgo(timestamp)})`);
            }

            // Set new data to database
            dbScope['bilibili_mblog'] = dbStore;
          } else {
            log('bilibili-mblog empty result, skipping...');
          }
        } else {
          log('bilibili-mblog info corrupted, skipping...');
        }
      })
      .catch(err => {
        log(`bilibili-mblog request error: ${err?.response?.body || err}`);
      });

      // Fetch Weibo
      const weiboRequestOptions = {...config.pluginOptions?.requestOptions, ...headerOnDemand(config.pluginOptions.cookies.weibo)};
      account.weiboId && await got(`https://m.weibo.cn/profile/info?uid=${account.weiboId}`, weiboRequestOptions).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.ok === 1) {
          const currentTime = Date.now();
          const data = json.data;
          const user = data?.user;
          const statuses = data?.statuses;

          if (statuses.length !== 0) {
            // Exclude sticky status when: it is sticky and is older than the first [1] status
            const status = (
              statuses[0]?.isTop === 1 &&
              statuses[0]?.created_at &&
              statuses[1]?.created_at &&
              +new Date(statuses[0].created_at) < +new Date(statuses[1].created_at)
            ) ? statuses[1] : statuses[0];
            const retweeted_status = status?.retweeted_status;

            const timestamp = +new Date(status.created_at);
            const id = status.bid;
            const visibility = status?.visible?.type;
            let text = status?.raw_text || stripHtml(status.text);

            if (status?.isLongText) {
              log('weibo got post too long, trying extended text...')
              await got(`https://m.weibo.cn/statuses/extend?id=${id}`, weiboRequestOptions).then(async resp => {
                const json = JSON.parse(resp.body);

                if (json?.ok === 1 && json?.data?.longTextContent) {
                  text = stripHtml(json.data.longTextContent);
                } else {
                  log('weibo extended info corrupted, using original text...');
                }
              });
            }

            argv.json && fs.writeFile(`db/${account.slug}-weibo.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            const visibilityMap = {
              1: `自己可见`,
              6: `好友圈可见`,
              10: `粉丝可见`
            }

            const dbStore = {
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
              user: user,
              latestStatus: {
                id: id,
                text: text,
                visibility: visibility,
                timestamp: new Date(timestamp),
                timestampUnix: timestamp,
                timeAgo: timeAgo(timestamp),
              }
            };

            // If user nickname update
            if (user.screen_name !== dbScope?.weibo?.user?.screen_name && dbScope?.weibo?.user?.screen_name) {
              log(`weibo user nickname updated: ${user.screen_name}`);

              if (account.tgChannelID && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelID,
                  text: `#微博昵称更新\n新：${user.screen_name}\n旧：${dbScope?.weibo?.user?.screen_name}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                      ],
                    ]
                  },
                }).then(resp => {
                  // log(`telegram post weibo::nickname success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post weibo::nickname error: ${err}`);
                });
              }
            }

            // If user description update
            if (user.description !== dbScope?.weibo?.user?.description && dbScope?.weibo?.user?.description) {
              log(`weibo user sign updated: ${user.description}`);

              if (account.tgChannelID && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelID,
                  text: `#微博签名更新\n新：${user.description}\n旧：${dbScope?.weibo?.user?.description}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                      ],
                    ]
                  },
                }).then(resp => {
                  // log(`telegram post weibo::sign success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post weibo::sign error: ${err}`);
                });
              }
            }

            // If user verified_reason update
            if (user?.verified_reason !== dbScope?.weibo?.user?.verified_reason && dbScope?.weibo?.user?.verified_reason) {
              log(`weibo user verified_reason updated: ${user.verified_reason}`);

              if (account.tgChannelID && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelID,
                  text: `#微博认证更新\n新：${user.verified_reason}\n旧：${dbScope?.weibo?.user?.verified_reason}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                      ],
                    ]
                  },
                }).then(resp => {
                  // log(`telegram post weibo::verified_reason success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post weibo::verified_reason error: ${err}`);
                });
              }
            }

            // If user avatar update
            if (user.avatar_hd !== dbScope?.weibo?.user?.avatar_hd && dbScope?.weibo?.user?.avatar_hd) {
              log(`weibo user avatar updated: ${user.avatar_hd}`);

              if (account.tgChannelID && config.telegram.enabled) {

                await sendTelegram({ method: 'sendPhoto' }, {
                  chat_id: account.tgChannelID,
                  photo: user.avatar_hd,
                  caption: `#微博头像更新，老头像：${dbScope?.weibo?.user?.avatar_hd}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                      ],
                    ]
                  },
                }).then(resp => {
                  // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post weibo::avatar error: ${err}`);
                });
              }
            }

            // If user cover background update
            if (user.cover_image_phone !== dbScope?.weibo?.user?.cover_image_phone && dbScope?.weibo?.user?.cover_image_phone) {
              log(`weibo user cover updated: ${user.cover_image_phone}`);

              if (account.tgChannelID && config.telegram.enabled) {

                await sendTelegram({ method: 'sendPhoto' }, {
                  chat_id: account.tgChannelID,
                  photo: convertWeiboUrl(user.cover_image_phone),
                  caption: `#微博封面更新，旧封面：${convertWeiboUrl(dbScope?.weibo?.user?.cover_image_phone)}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                      ],
                    ]
                  },
                }).then(resp => {
                  // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post weibo::avatar error: ${err}`);
                });
              }
            }

            // If latest post is newer than the one in database
            if (id !== dbScope?.weibo?.latestStatus?.id && timestamp > dbScope?.weibo?.latestStatus?.timestampUnix) {
              const tgOptions = {
                method: 'sendMessage',
              };

              const tgBody = {
                chat_id: account.tgChannelID,
                text: `#微博${visibilityMap[visibility] || ''}${retweeted_status ? `转发` : `动态`}：${text}${retweeted_status ? `\n\n被转作者：@${retweeted_status.user.screen_name}\n被转内容：${stripHtml(retweeted_status.text)}` : ''}`,
                reply_markup: {
                  inline_keyboard: [
                    retweeted_status ? [
                      {text: 'View', url: `https://weibo.com/${user.id}/${id}`},
                      {text: 'View Retweeted', url: `https://weibo.com/${retweeted_status.user.id}/${retweeted_status.bid}`},
                      {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                    ] : [
                      {text: 'View', url: `https://weibo.com/${user.id}/${id}`},
                      {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                    ],
                  ]
                },
              };

              // If post has photo
              if (status.pic_ids?.length > 0) {
                const photoCount = status.pic_ids.length;
                const photoCountText = photoCount > 1 ? `（共 ${photoCount} 张）` : ``;
                tgOptions.method = 'sendPhoto';
                tgBody.photo = `https://ww1.sinaimg.cn/large/${status.pic_ids[0]}.jpg`;
                tgBody.caption = `#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}`;
              }

              // If post has video
              if (status?.page_info?.type === 'video') {
                tgOptions.method = 'sendVideo';
                tgBody.video = status?.page_info?.media_info?.stream_url_hd || status?.page_info?.media_info?.stream_url;
                tgBody.caption = `#微博${visibilityMap[visibility] || ''}视频：${text}`;
              }

              // TODO: parse 4k
              // https://f.video.weibocdn.com/qpH0Ozj9lx07NO9oXw4E0104120qrc250E0a0.mp4?label=mp4_2160p60&template=4096x1890.20.0&trans_finger=aaa6a0a6b46c000323ae75fc96245471&media_id=4653054126129212&tp=8x8A3El:YTkl0eM8&us=0&ori=1&bf=3&ot=h&ps=3lckmu&uid=7vYqTU&ab=3915-g1,5178-g1,966-g1,1493-g0,1192-g0,1191-g0,1258-g0&Expires=1627682219&ssig=I7RDiLeNCQ&KID=unistore,video

              if (account.tgChannelID && config.telegram.enabled) {
                log(`weibo got update: ${id} (${timeAgo(timestamp)})`);

                if ((currentTime - timestamp) >= config.weiboBotThrottle) {
                  log(`weibo too old, notifications skipped`);
                } else {
                  await sendTelegram(tgOptions, tgBody).then(resp => {
                    // log(`telegram post weibo success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post weibo error: ${err?.response?.body || err}`);
                  });
                }
              }
            } else if (id !== dbScope?.weibo?.latestStatus?.id && timestamp < dbScope?.weibo?.latestStatus?.timestampUnix) {
              log(`weibo new post older than database. latest: ${id} (${timeAgo(timestamp)})`);

              // NOTE: Disable deleted weibo detection. Buggy
              // if (account.tgChannelID && config.telegram.enabled) {

              //   await sendTelegram({ method: 'sendMessage' }, {
              //     text: `监测到最新微博旧于数据库中的微博，可能有微博被删除`,
              //     reply_markup: {
              //       inline_keyboard: [
              //         [
              //           {text: 'View', url: `https://weibo.com/${user.id}/${id}`},
              //           {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
              //         ],
              //       ]
              //     },
              //   }).then(resp => {
              //     // log(`telegram post weibo success: message_id ${resp.result.message_id}`)
              //   })
              //   .catch(err => {
              //     log(`telegram post weibo error: ${err?.response?.body || err}`);
              //   });
              // }

            } else {
              log(`weibo no update. latest: ${id} (${timeAgo(timestamp)})`);
            }

            // Set new data to database
            dbScope['weibo'] = dbStore;
          } else {
            log('weibo empty result, skipping...');
          }
        } else {
          log('weibo info corrupted, skipping...');
        }
      })
      .catch(err => {
        log(`weibo request error: ${err}`);
      });

      // Write new data to database
      await db.write();
      argv.verbose && log(`global db saved`);
    }
  }

  argv.verbose && console.log('# Check loop ended');
}

if (argv._.includes('run')) {
  // Create database directory if not exists
  !fs.existsSync('db') && fs.mkdirSync('db');

  // Output configs for reference
  argv.verbose && console.log('Current configs', config);

  // Execute on run
  await main(config);

  if (!argv.once) {

    // Loop over interval
    setIntervalAsync(async () => {
      argv.verbose && console.log('interval started');
      await main(config);
      argv.verbose && console.log('interval ended');
    }, config.loopInterval);
  }
}

process.on('SIGINT', () => {
  process.exit();
});
