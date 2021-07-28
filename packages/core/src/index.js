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
  douyinLiveBotThrottle: 500 * 1000, // 5 mins
  bilibiliBotThrottle: 500 * 1000,
  bilibiliLiveBotThrottle: 500 * 1000,
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

async function sendTelegram(chatId, userOptions) {
  const options = merge({
    token: config.telegram.token,
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

  // Read from database
  await db.read()
  db.data ||= {};

  console.log(`\n# Checks started at ${formatDate(Date.now())} ------------`);

  for (let i = 0; i < config.accounts.length; i++) {
    const account = config.accounts[i];

    // Set random request time to avoid request limit
    await setTimeout(100 + Math.floor(Math.random() * 200));

    // Only check enabled account
    if (account.enabled) {

      // Initial database structure
      db.data[account.slug] ||= {};

      const logName = chalk.hex('#000').bgHex(account?.color ?? '#fff');
      // console.log(`${logName(account.slug)} is checking...`);

      function log(msg, type) {
        console.log(`${logName(account.slug)} ${msg}`);
      }

      // Fetch Douyin
      account.douyinId && dyExtract(`https://www.douyin.com/user/${account.douyinId}`, config.requestOptions).then(async resp => {
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

            const dbScope = db.data[account.slug];
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
                  await sendTelegram(account.tgChannelID, tgOptions).then(resp => {
                    // log(`telegram post douyin success: message_id ${resp.result.message_id}`)
                    dbStore.latestPost.isTgSent = true;
                  })
                  .catch(err => {
                    log(`telegram post douyin error: ${err?.response?.body?.trim()}`);
                  });
                }
              }
            } else {
              log(`douyin no update. latest: ${id} (${timeAgo(timestamp)})`);
            }

            // Write new data to database
            dbScope['douyin'] = dbStore;
            await db.write();
          }
        } else {
          log(`douyin scraped data corrupted, skipping...`);
        }
      }).catch(err => {
        console.log(err);
      });

      // Fetch bilibili live
      account.biliId && await got(`https://api.bilibili.com/x/space/acc/info?mid=${account.biliId}`, config.requestOptions).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data;
          const room = json.data.live_room;

          const uid = data.mid;
          const nickname = data.name;
          const sign = data.sign;
          const avatar = data.face;
          const liveStatus = room.liveStatus;
          const liveId = room.roomid;
          const liveRoom = room.url;
          const liveTitle = room.title;
          const liveCover = room.cover;

          argv.json && fs.writeFile(`db/${account.slug}-bilibili-user.json`, JSON.stringify(json, null, 2), err => {
            if (err) return console.log(err);
          });

          const dbScope = db.data[account.slug];
          const dbStore = {
            nickname: nickname,
            uid: uid,
            scrapedTime: new Date(currentTime),
            sign: sign,
            latestStream: {
              liveStatus: liveStatus,
              liveRoom: liveRoom,
              liveTitle: liveTitle,
              liveCover: liveCover,
              isTgSent: dbScope?.bilibili_live?.latestStream?.isTgSent,
            }
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

          // 1: live
          // 0: not live
          if (room?.liveStatus === 1) {

            // Deprecated v1 API, may be changed in the future
            await got(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${liveId}`, config.requestOptions).then(async resp => {
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
                    await sendTelegram(account.tgChannelID, tgOptions).then(resp => {
                      // log(`telegram post bilibili-live success: message_id ${resp.result.message_id}`)
                      dbStore.latestStream.isTgSent = true;
                    })
                    .catch(err => {
                      log(`telegram post bilibili-live error: ${err?.response?.body?.trim()}`);
                    });
                  }
                }
              } else {
                log('bilibili-live stream info corrupted, skipping...');
              };
            })
            .catch(err => {
              log(`bilibili-live stream info request error: ${err?.response?.body?.trim()}`);
            });
          } else {
            log(`bilibili-live not started yet`);
            dbStore.latestStream.isTgSent = false;
          }

          // Write new data to database
          dbScope['bilibili_live'] = dbStore;
          await db.write();
        } else {
          log('bilibili-live user info corrupted, skipping...');
        }
      })
      .catch(err => {
        log(`bilibili-live user info request error: ${err?.response?.body?.trim()}`);
      });

      // Fetch bilibili microblog (dynamics)
      account.biliId && await got(`https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${account.biliId}&offset_dynamic_id=0&need_top=0&platform=web`, config.requestOptions).then(async resp => {
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

            const dbScope = db.data[account.slug];
            const dbStore = {
              scrapedTime: new Date(currentTime),
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
            if (account.slug === '测试账号') {
              log(`cardJson`);
              console.log(cardJson);
            };

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
              // Forwarded post (think retweet)
              if (type === 1) {
                tgOptions.body.text = `b站新转发动态：${cardJson?.item?.content.trim()}`;
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
                  await sendTelegram(account.tgChannelID, tgOptions).then(resp => {
                    // log(`telegram post bilibili-mblog success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post bilibili-mblog error: ${err?.response?.body?.trim()}`);
                  });
                }
              }
            } else {
              log(`bilibili-mblog no update. latest: ${dynamicId} (${timeAgo(timestamp)})`);
            }

            // Write new data to database
            dbScope['bilibili_mblog'] = dbStore;
            await db.write();
          } else {
            log('bilibili-mblog empty result, skipping...');
          }
        } else {
          log('bilibili-mblog info corrupted, skipping...');
        }
      })
      .catch(err => {
        log(`bilibili-mblog request error: ${err?.response?.body?.trim()}`);
      });
    }
  }
}

if (argv._.includes('run')) {
  // Create database directory if not exists
  !fs.existsSync('db') && fs.mkdirSync('db');

  // Output configs for reference
  console.log('Current configs', {
    loopInterval: config.loopInterval,
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
