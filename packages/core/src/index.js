#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { setTimeout } from 'timers/promises';

import got from 'got';
import chalk from 'chalk';
import merge from 'deepmerge';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { formatDistanceToNowStrict } from 'date-fns';
import { Low, JSONFile } from 'lowdb';
import SocksProxyAgent from 'socks-proxy-agent';

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
    description: 'User configuration file (in JSON format)',
    type: 'string',
  })
  .option('verbose', {
    description: 'Show verbose log',
    type: 'boolean',
  })
  .help()
  .alias('help', 'h')
  .argv;

const userConfig = argv.config ? JSON.parse(fs.readFileSync(argv.config)) : {};

const defaultConfig = {
  loopInterval: 60 * 1000, // n seconds
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
    }
  },
  douyinBotThrottle: 24 * 3600 * 1000, // seconds, if latest post older than n secs, do not send notifications
  douyinLiveBotThrottle: 1200 * 1000, // 20 mins
  bilibiliBotThrottle: 3600 * 1000, // 60 mins, bilibili sometimes got limit rate for 30 mins.
  bilibiliLiveBotThrottle: 1200 * 1000,
  weiboBotThrottle: 3600 * 1000,
  socksProxy: '',
  telegram: {
    enabled: true,
    silent: false,
    token: '',
  },
  accounts: []
};

const config = merge(defaultConfig, userConfig);

function formatDate(timestamp) {
  let date = timestamp.toString().length === 10 ? new Date(+timestamp * 1000) : new Date(+timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function timeAgo(timestamp, suffix = true) {
  return formatDistanceToNowStrict(new Date(timestamp), {
    addSuffix: suffix,
  });
}

function stripHtml(string = '', withBr = true) {
  if (withBr) {
    return string.replace(/<br ?\/?>/gmi, '\n').replace(/(<([^>]+)>)/gmi, '');
  } else {
    return string.replace(/(<([^>]+)>)/gmi, '');
  }
}

async function sendTelegram(chatId, userOptions) {
  const options = merge({
    token: config.telegram.token,
    gotOptions: {
      retry: {
        limit: 3,
      }
    },
    body: {
      chat_id: chatId,
      text: `Test from @a-soul/sender-telegram`,
      disable_notification: config.telegram.silent
    },
  }, userOptions);

  const resp = await TelegramBot(options);
  return resp?.body && JSON.parse(resp.body);
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

  console.log(`\n# Checks started at ${formatDate(Date.now())} ------------`);

  for (let i = 0; i < config.accounts.length; i++) {
    const account = config.accounts[i];

    const logName = chalk.hex('#000').bgHex(account?.color ?? '#fff');

    function log(msg, type) {
      console.log(`${logName(account.slug)} ${msg}`);
    }

    // Only check enabled account
    if (account?.enabled) {
      // Set random request time to avoid request limit
      await setTimeout(1000 + Math.floor(Math.random() * 400));

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
      const proxyOptions = config?.socksProxy && Math.random() < .5 ? {
        agent: {
          https: new SocksProxyAgent(config.socksProxy)
        }
      } : {};

      // Fetch Douyin live
      // account.douyinLiveId && dyExtract(`https://webcast.amemv.com/webcast/reflow/${account.douyinLiveId}`, config.requestOptions).then(async resp => {
      //   const json = resp?.['/webcast/reflow/:id'];

      //   if (json) {

      //     argv.json && fs.writeFile(`db/${account.slug}-douyin-live.json`, JSON.stringify(json, null, 2), err => {
      //       if (err) return console.log(err);
      //     });

      //   } else {
      //     log(`douyin live data corrupted, skipping...`);
      //   }

      // }).catch(err => {
      //   console.log(err);
      // });

      // Fetch Douyin
      account.douyinId && await dyExtract(`https://www.douyin.com/user/${account.douyinId}`, config.requestOptions).then(async resp => {
        const currentTime = Date.now();
        const json = resp;
        const userMeta = json?.C_10?.user?.user;
        const posts = json?.C_10?.post?.data;

        if (userMeta && posts?.length > 0) {
          const uid = userMeta.uid;
          const secUid = userMeta.secUid;
          const nickname = userMeta.nickname;
          const sign = userMeta.desc;
          const avatar = userMeta.avatarUrl;
          const following = userMeta.followingCount;
          const followers = userMeta.followerCount;

          argv.json && fs.writeFile(`db/${account.slug}-douyin.json`, JSON.stringify(json, null, 2), err => {
            if (err) return console.log(err);
          });

          // Sort all posts by `createTime` to avoid sticky (aka. 置顶) posts and get the latest one
          // const post = posts[i]; // Used to store in array and detect `isTop` in loop
          const post = posts.sort((a, b) => b.createTime - a.createTime)?.[0];

          // If latest post exists
          if (post) {
            const id = post.awemeId
            const postAuthorMeta = post.authorInfo;
            const title = post.desc;
            const timestamp = post.createTime * 1000;
            const tags = post.textExtra;
            const postMeta = post.tag;
            const cover = `https:${post?.video.dynamicCover}`;
            const videoUrl = `https:${post?.video?.playAddr[0].src}`;
            const shareUrl = post.shareInfo.shareUrl;
            const stats = post.stats;

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
              body: {
                video: videoUrl,
                caption: `抖音新视频：${title} #${id}`,
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
            };

            // Check if this is a new post compared to last scrap
            if (id !== dbScope?.douyin?.latestPost?.id && timestamp > dbScope?.douyin?.latestPost?.timestampUnix) {
              log(`douyin has update: ${id} (${timeAgo(timestamp)}) ${title}`);

              // Send bot message
              if (account.tgChannelID && config.telegram.enabled) {

                if ((currentTime - timestamp) >= config.douyinBotThrottle) {
                  log(`douyin latest post too old, notifications skipped`);
                } else {
                  sendTelegram(account.tgChannelID, tgOptions).then(resp => {
                    // log(`telegram post douyin success: message_id ${resp.result.message_id}`)
                    dbStore.latestPost.isTgSent = true;
                  })
                  .catch(err => {
                    log(`telegram post douyin error: ${err?.response?.body?.trim() || err}`);
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
      account.biliId && await got(`https://api.bilibili.com/x/space/acc/info?mid=${account.biliId}`, {...config.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data;
          const room = json.data.live_room;
          const fans_medal = json.data.fans_medal; // 直播间粉丝牌
          const official = json.data.official; // 认证状态
          const vip = json.data.vip; // 大会员状态
          const pendant = json.data.pendant; // 粉丝装扮
          const nameplate = json.data.nameplate; // 个人勋章

          const uid = data.mid;
          const nickname = data.name;
          const sign = data.sign;
          const avatar = data.face;
          const liveStatus = room.liveStatus;
          const liveId = room.roomid;
          const liveRoom = room.url;
          const liveTitle = room.title;
          const liveCover = room.cover;

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
            body: {
              photo: liveCover,
              caption: `b站开播🔴：${liveTitle}`,
              reply_markup: {
                inline_keyboard: [
                  [
                    {text: 'Watch', url: liveRoom},
                    {text: 'Artwork', url: liveCover},
                    {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                  ],
                ]
              },
            }
          };

          // If user nickname update
          if (nickname !== 'bilibili' && nickname !== dbScope?.bilibili_live?.nickname && dbScope?.bilibili_live?.nickname) {
            log(`bilibili-live user nickname updated: ${nickname}`);

            if (account.tgChannelID && config.telegram.enabled) {

              sendTelegram(account.tgChannelID, {
                method: 'sendMessage',
                body: {
                  text: `b站昵称更新\n新：${nickname}\n旧：${dbScope?.bilibili_live?.nickname}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ]
                  },
                }
              }).then(resp => {
                // log(`telegram post bilibili-live::nickname success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::nickname error: ${err?.response?.body?.trim() || err}`);
              });
            }
          }

          // If user sign update
          if (nickname !== 'bilibili' && sign !== dbScope?.bilibili_live?.sign && dbScope?.bilibili_live?.sign) {
            log(`bilibili-live user sign updated: ${sign}`);

            if (account.tgChannelID && config.telegram.enabled) {

              sendTelegram(account.tgChannelID, {
                method: 'sendMessage',
                body: {
                  text: `b站签名更新\n新：${sign}\n旧：${dbScope?.bilibili_live?.sign}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ]
                  },
                }
              }).then(resp => {
                // log(`telegram post bilibili-live::sign success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::sign error: ${err?.response?.body?.trim() || err}`);
              });
            }
          }

          // If user avatar update
          if (nickname !== 'bilibili' && avatarHash?.pathname !== dbScope?.bilibili_live?.avatar && dbScope?.bilibili_live?.avatar) {
            log(`bilibili-live user avatar updated: ${avatar}`);

            if (account.tgChannelID && config.telegram.enabled) {

              sendTelegram(account.tgChannelID, {
                method: 'sendPhoto',
                body: {
                  photo: avatar,
                  caption: `b站头像更新，老头像：${dbScope?.bilibili_live?.avatar}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ]
                  },
                }
              }).then(resp => {
                // log(`telegram post bilibili-live::avatar success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::avatar error: ${err?.response?.body?.trim() || err}`);
              });
            }
          }

          // 1: live
          // 0: not live
          if (room?.liveStatus === 1) {

            // Deprecated v1 API, may be changed in the future
            await got(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${liveId}`, {...config.requestOptions, ...proxyOptions}).then(async resp => {
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
                    sendTelegram(account.tgChannelID, tgOptions).then(resp => {
                      // log(`telegram post bilibili-live success: message_id ${resp.result.message_id}`)
                      dbStore.latestStream.isTgSent = true;
                    })
                    .catch(err => {
                      log(`telegram post bilibili-live error: ${err?.response?.body?.trim() || err}`);
                    });
                  }
                }
              } else {
                log('bilibili-live stream info corrupted, skipping...');
              };
            })
            .catch(err => {
              log(`bilibili-live stream info request error: ${err?.response?.body?.trim() || err}`);
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
        log(`bilibili-live user info request error: ${err?.response?.body?.trim() || err}`);
      });

      // Fetch bilibili microblog (dynamics)
      account.biliId && await got(`https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${account.biliId}&offset_dynamic_id=0&need_top=0&platform=web`, {...config.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data;
          const cards = data?.cards;

          if (cards) {
            const card = cards[0];

            const cardMeta = card.desc;
            const cardJson = JSON.parse(card.card);

            const timestamp = cardMeta.timestamp * 1000;
            const uid = cardMeta.uid;
            const type = cardMeta.type;
            const origin_type = cardMeta.orig_type;
            const dynamicId = cardMeta.dynamic_id_str;
            const user = cardMeta.user_profile;

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
                isTgSent: dbScope?.bilibili_mblog?.latestDynamic?.isTgSent,
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
                body: {
                  text: `${user.info.uname} 发布了b站新动态`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: 'View', url: `https://t.bilibili.com/${dynamicId}`},
                        {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ]
                  },
                }
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
                  tgOptions.body.photo = `${originJson?.origin_image_urls}`;
                  tgOptions.body.caption = `b站新专栏转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.author.name}\n被转标题：${originJson.title}\n\n${originJson.summary}`;
                }

                // Text with gallery
                else if (originJson?.item?.description && originJson?.item?.pictures) {
                  // console.log(originJson?.item.pictures);

                  // NOTE: Change the following to `> 1` to enable
                  if (originJson?.item?.pictures_count > 99) {
                    // TODO: sendMediaGroup doesn't support reply_markup. You have to use a seperate message
                    tgOptions.method = 'sendMediaGroup';
                    tgOptions.body.media = originJson?.item?.pictures.map((pic, idx) => ({
                      type: 'photo',
                      // Limit image size with original server and webp: failed (Bad Request: group send failed)
                      // media: pic.img_width > 1036 || pic.img_height > 1036 ? `${pic.img_src}@1036w.webp` : `${pic.img_src}`,

                      // Use wp.com proxy to serve image: failed (Bad Request: group send failed)
                      // media: `https://i0.wp.com/${pic.img_src.replace('https://').replace('http://')}?w=200`,

                      // Use my own proxy and webp prefix from bilibili: sucess
                      media: `https://experiments.sparanoid.net/imageproxy/1000x1000,fit/${pic.img_src}@1036w.webp`,
                    }));

                    // Only apply caption to the first image to make it auto shown on message list
                    tgOptions.body.media[0].caption = `b站新转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.name}\n被转内容：${originJson.item.description}`;

                    // Debug payload
                    // console.log(tgOptions.body.media);
                    // tgOptions.body.media = [
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
                      tgOptions.body.photo = `https://experiments.sparanoid.net/imageproxy/1000x1000,fit/${originJson?.item?.pictures[0].img_src}@1036w.webp`;
                    } else {
                      tgOptions.body.photo = `${originJson?.item?.pictures[0].img_src}`;
                    }
                    tgOptions.body.caption = `b站新转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.name}\n被转内容：${originJson.item.description}`;
                  }
                }

                // Video
                else if (originJson?.duration && originJson?.videos) {
                  tgOptions.method = 'sendPhoto';
                  tgOptions.body.photo = `${originJson?.pic}`;
                  tgOptions.body.caption = `b站新视频转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}`;
                }

                // Plain text
                else {
                  tgOptions.body.text = `b站新转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.uname}\n被转动态：${originJson.item.content}`;
                }

                log(`bilibili-mblog got forwarded post (${timeAgo(timestamp)})`);
              }

              // Gallery post (text post with images)
              else if (type === 2) {
                tgOptions.method = 'sendPhoto';
                tgOptions.body.caption = `b站新相册动态：${cardJson?.item?.description}`;
                tgOptions.body.photo = cardJson?.item?.pictures[0].img_src;
                log(`bilibili-mblog got gallery post (${timeAgo(timestamp)})`);
              }

              // Text post
              else if (type === 4) {
                tgOptions.body.text = `b站新动态：${cardJson?.item?.content.trim()}`;
                log(`bilibili-mblog got text post (${timeAgo(timestamp)})`);
              }

              // Video post
              else if (type === 8) {
                tgOptions.method = 'sendPhoto';
                tgOptions.body = {
                  photo: cardJson.pic,
                  // dynamic: microblog text
                  // desc: video description
                  caption: `b站新视频：${cardJson.title}\n${cardJson.dynamic}\n${cardJson.desc}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: 'View', url: `https://t.bilibili.com/${dynamicId}`},
                        {text: 'View Video', url: `${cardJson.short_link}`},
                        {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ]
                  },
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
                tgOptions.body.photo = cardJson.origin_image_urls[0];
                tgOptions.body.caption = `b站新专栏：${cardJson.title}\n\n${cardJson.summary}`;

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
                  sendTelegram(account.tgChannelID, tgOptions).then(resp => {
                    // log(`telegram post bilibili-mblog success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post bilibili-mblog error: ${err?.response?.body?.trim() || err}`);
                  });
                }
              }
            } else if (dynamicId !== dbScope?.bilibili_mblog?.latestDynamic?.id && timestamp < dbScope?.bilibili_mblog?.latestDynamic?.timestampUnix) {
              log(`bilibili-mblog new post older than database. latest: ${dynamicId} (${timeAgo(timestamp)})`);

              if (account.tgChannelID && config.telegram.enabled) {

                sendTelegram(account.tgChannelID, {
                  method: 'sendMessage',
                  body: {
                    text: `监测到最新动态旧于数据库中的动态，可能有动态被删除`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {text: 'View', url: `https://t.bilibili.com/${dynamicId}`},
                          {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                        ],
                      ]
                    },
                  }
                }).then(resp => {
                  // log(`telegram post bilibili-mblog success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post bilibili-mblog error: ${err?.response?.body?.trim() || err}`);
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
        log(`bilibili-mblog request error: ${err?.response?.body?.trim() || err}`);
      });

      // Fetch Weibo
      account.weiboId && await got(`https://m.weibo.cn/profile/info?uid=${account.weiboId}`, config.requestOptions).then(async resp => {
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

            const timestamp = +new Date(status.created_at);
            const id = status.bid;
            const text = status?.raw_text || stripHtml(status.text);

            argv.json && fs.writeFile(`db/${account.slug}-weibo.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            const dbStore = {
              scrapedTime: new Date(currentTime),
              user: user,
              latestStatus: {
                id: id,
                text: text,
                timestamp: new Date(timestamp),
                timestampUnix: timestamp,
                timeAgo: timeAgo(timestamp),
                isTgSent: dbScope?.weibo?.latestStatus?.isTgSent,
              }
            };

            // If user nickname update
            if (user.screen_name !== dbScope?.weibo?.user?.screen_name && dbScope?.weibo?.user?.screen_name) {
              log(`weibo user nickname updated: ${user.screen_name}`);

              if (account.tgChannelID && config.telegram.enabled) {

                sendTelegram(account.tgChannelID, {
                  method: 'sendMessage',
                  body: {
                    text: `微博昵称更新\n新：${user.screen_name}\n旧：${dbScope?.weibo?.user?.screen_name}`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                        ],
                      ]
                    },
                  }
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

                sendTelegram(account.tgChannelID, {
                  method: 'sendMessage',
                  body: {
                    text: `微博签名更新\n新：${user.description}\n旧：${dbScope?.weibo?.user?.description}`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                        ],
                      ]
                    },
                  }
                }).then(resp => {
                  // log(`telegram post weibo::sign success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post weibo::sign error: ${err}`);
                });
              }
            }

            // If user avatar update
            if (user.avatar_hd !== dbScope?.weibo?.user?.avatar_hd && dbScope?.weibo?.user?.avatar_hd) {
              log(`weibo user avatar updated: ${user.avatar_hd}`);

              if (account.tgChannelID && config.telegram.enabled) {

                sendTelegram(account.tgChannelID, {
                  method: 'sendPhoto',
                  body: {
                    photo: user.avatar_hd,
                    caption: `头像更新，老头像：${dbScope?.weibo?.user?.avatar_hd}`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                        ],
                      ]
                    },
                  }
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
                body: {
                  text: `微博更新：${text}`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {text: 'View', url: `https://weibo.com/${user.id}/${id}`},
                        {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
                      ],
                    ]
                  },
                }
              };

              // If post has photo
              if (status.pic_ids?.length > 0) {
                tgOptions.method = 'sendPhoto';
                tgOptions.body.photo = `https://ww1.sinaimg.cn/large/${status.pic_ids[0]}.jpg`;
                tgOptions.body.caption = `微博更新 ${text}`;
              }

              // If post has video
              if (status?.page_info?.type === 'video') {
                tgOptions.method = 'sendVideo';
                tgOptions.body.video = status?.page_info?.media_info?.stream_url_hd || status?.page_info?.media_info?.stream_url;
                tgOptions.body.caption = `微博更新 ${text}`;
              }

              // TODO: parse 4k
              // https://f.video.weibocdn.com/qpH0Ozj9lx07NO9oXw4E0104120qrc250E0a0.mp4?label=mp4_2160p60&template=4096x1890.20.0&trans_finger=aaa6a0a6b46c000323ae75fc96245471&media_id=4653054126129212&tp=8x8A3El:YTkl0eM8&us=0&ori=1&bf=3&ot=h&ps=3lckmu&uid=7vYqTU&ab=3915-g1,5178-g1,966-g1,1493-g0,1192-g0,1191-g0,1258-g0&Expires=1627682219&ssig=I7RDiLeNCQ&KID=unistore,video

              if (account.tgChannelID && config.telegram.enabled) {
                log(`weibo has update: ${id} (${timeAgo(timestamp)})`);

                if ((currentTime - timestamp) >= config.weiboBotThrottle) {
                  log(`weibo too old, notifications skipped`);
                } else {
                  sendTelegram(account.tgChannelID, tgOptions).then(resp => {
                    // log(`telegram post weibo success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post weibo error: ${err?.response?.body?.trim() || err}`);
                  });
                }
              }
            } else if (id !== dbScope?.weibo?.latestStatus?.id && timestamp < dbScope?.weibo?.latestStatus?.timestampUnix) {
              log(`weibo new post older than database. latest: ${id} (${timeAgo(timestamp)})`);

              // NOTE: Disable deleted weibo detection. Buggy
              // if (account.tgChannelID && config.telegram.enabled) {

              //   sendTelegram(account.tgChannelID, {
              //     method: 'sendMessage',
              //     body: {
              //       text: `监测到最新微博旧于数据库中的微博，可能有微博被删除`,
              //       reply_markup: {
              //         inline_keyboard: [
              //           [
              //             {text: 'View', url: `https://weibo.com/${user.id}/${id}`},
              //             {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
              //           ],
              //         ]
              //       },
              //     }
              //   }).then(resp => {
              //     // log(`telegram post weibo success: message_id ${resp.result.message_id}`)
              //   })
              //   .catch(err => {
              //     log(`telegram post weibo error: ${err?.response?.body?.trim() || err}`);
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
}

if (argv._.includes('run')) {
  // Create database directory if not exists
  !fs.existsSync('db') && fs.mkdirSync('db');

  // Output configs for reference
  console.log('Current configs', {
    loopInterval: config.loopInterval,
    socksProxy: config.socksProxy,
    requestOptions: config.requestOptions,
    douyinBotThrottle: config.douyinBotThrottle,
    douyinLiveBotThrottle: config.douyinLiveBotThrottle,
    bilibiliBotThrottle: config.bilibiliBotThrottle,
    bilibiliLiveBotThrottle: config.bilibiliLiveBotThrottle,
    telegram: config.telegram,
  });

  // Execute on run
  main(config);

  if (!argv.once) {

    // async function loop() {
    //   while (true) {
    //     console.log('start');
    //     await setTimeout(config.loopInterval);
    //     await main(config);
    //     console.log('stop');
    //   }
    // }
    // loop();

    // Loop over interval
    setInterval(() => {
      main(config);
    }, config.loopInterval);
  }
}
