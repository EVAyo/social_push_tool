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
import { FormData } from 'formdata-node';

import { formatDate, stripHtml, convertWeiboUrl } from './utils.js';
import { timeAgo } from './utils/timeAgo.js';
import { readProcessedImage } from './utils/processImage.js';

import TelegramBot from '@a-soul/sender-telegram';
import GoQcHttp from '@a-soul/sender-go-qchttp';
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
    douyinBotThrottle: 36 * 3600 * 1000, // 36 hours, if latest post older than this value, do not send notifications
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

// Used by extractor-douyin
function cookieOnDemand(cookie) {
  return {
    cookies: cookie
  }
}

// Used by got directly
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
    return resp;
  } catch (err) {
    console.log(err);
  }
}

async function sendQGuild(userOptions, userContent) {
  const options = merge({
    apiBase: config.qGuild.apiBase,
    requestOptions: {
      retry: {
        limit: 3,
      }
    },
  }, userOptions);

  try {
    const resp = await GoQcHttp(options, userContent);
    return resp;
  } catch (err) {
    console.log(err);
  }
}

function generateCqCode(url, type = 'image') {
  return `[CQ:${type},file=${url}]\n`;
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
      chat_id: account.tgChannelId,
      text: `Test from @a-soul/sender-telegram`,
      disable_notification: config.telegram.silent
    },
  }, userOptions.telegramOptions);

  const resp = await TelegramBot(tgOptions);
  return resp?.body && JSON.parse(resp.body);
}

function parseDdstatsString(string) {
  // 艾白_千鸟Official 在 杜松子_Gin 的直播间发送了一则消息: 那我等你下播了！我们聊！
  // 艾白_千鸟Official 进入了 金克茜Jinxy 的直播间

  // https://regex101.com/r/RQ2WsA/1
  //
  // schema:
  //
  // action: "在"
  // content: "的直播间发送了一则消息: 那我等你下播了！我们聊！"
  // target: "杜松子_Gin"
  // user: "艾白_千鸟Official"
  const parseRegex = /(?<user>\S+) (?<action>\S+) (?<target>\S+) (?<content>.+)/;
  const { groups } = parseRegex.exec(string);
  return groups;
}

async function main(config) {
  // Initial database
  const db = new Low(new JSONFile(path.join(path.resolve(), 'db/db.json')));

  // const url = 'https://www.douyin.com/user/MS4wLjABAAAA5ZrIrbgva_HMeHuNn64goOD2XYnk4ItSypgRHlbSh1c';

  console.time('# Loop time used');
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

      // Append account slug in output (useful for multiple account in channel)
      const msgPrefix = account.showSlug ? `#${account.slug} ` : ``;

      // Fetch Douyin live
      account.douyinLiveId && await dyExtract(`https://live.douyin.com/${account.douyinLiveId}`, {...config.pluginOptions, ...cookieOnDemand(config.pluginOptions.customCookies.douyin)}).then(async resp => {
        const json = resp?.initialState?.roomStore?.roomInfo;

        if (json) {
          const status = json?.room?.status;
          const id_str = json?.room?.id_str;

          if (status === 2) {
            argv.verbose && log(`douyin-live seems started, begin second check...`);

            await dyExtract(`https://webcast.amemv.com/webcast/reflow/${id_str}`, {...config.pluginOptions, ...cookieOnDemand(config.pluginOptions.customCookies.douyin)}).then(async resp => {
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
                    chat_id: account.tgChannelId,
                    photo: liveCover,
                    caption: `${msgPrefix}#抖音开播：${title}`,
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

                  if (dbScope?.douyin_live?.latestStream?.isTgSent) {
                    log(`douyin-live notification sent, skipping...`);
                  } else if ((currentTime - timestamp) >= config.douyinLiveBotThrottle) {
                    log(`douyin-live too old, notifications skipped`);
                  } else {

                    if (account.qGuildId && config.qGuild.enabled) {

                      await sendQGuild({method: 'send_guild_channel_msg'}, {
                        guild_id: account.qGuildId,
                        channel_id: account.qGuildChannelId,
                        message: `${msgPrefix}#抖音开播：${title}\n地址：https://webcast.amemv.com/webcast/reflow/${id_str}\nM3U8提取：${streamUrl}\n[CQ:image,file=${liveCover}]`,
                      }).then(resp => {
                        // log(`go-qchttp post weibo success: ${resp}`);
                      })
                      .catch(err => {
                        log(`go-qchttp post douyin-live error: ${err?.response?.body || err}`);
                      });
                    }

                    if (account.tgChannelId && config.telegram.enabled) {

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
      account.douyinId && await dyExtract(`https://www.douyin.com/user/${account.douyinId}`, {...config.pluginOptions, ...cookieOnDemand(config.pluginOptions.customCookies.douyin)}).then(async resp => {
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
              chat_id: account.tgChannelId,
              video: videoUrl,
              caption: `${msgPrefix}#抖音视频：${title} #${id}`,
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
              if ((currentTime - timestamp) >= config.douyinBotThrottle) {
                log(`douyin latest post too old, notifications skipped`);
              } else {
                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, {
                    guild_id: account.qGuildId,
                    channel_id: account.qGuildChannelId,
                    message: `${msgPrefix}#抖音视频：${title}\n地址：${shareUrl}\n[CQ:image,file=${cover}]`,
                  }).then(resp => {
                    // log(`go-qchttp post weibo success: ${resp}`);
                  })
                  .catch(err => {
                    log(`go-qchttp post douyin error: ${err?.response?.body || err}`);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled) {

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

          if (typeof data.live_room === 'undefined' || data.live_room === null) {
            log(`live room not available for this user, skipping...`);
            return;
          }

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
            roundStatus, // 轮播状态
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
            chat_id: account.tgChannelId,
            photo: liveCover,
            caption: `${msgPrefix}#b站开播：${liveTitle}`,
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

          // If live room title updates
          if (
            liveTitle !== dbScope?.bilibili_live?.latestStream?.liveTitle &&
            liveStatus === dbScope?.bilibili_live?.latestStream?.liveStatus
          ) {
            log(`bilibili-live title updated: ${liveTitle}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站直播间标题更新\n新：${liveTitle}\n旧：${dbScope?.bilibili_live?.latestStream?.liveTitle}`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live title error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#b站直播间标题更新\n新：${liveTitle}\n旧：${dbScope?.bilibili_live?.latestStream?.liveTitle}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: 'Watch', url: liveRoom},
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live title success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live title error: ${err?.response?.body || err}`);
              });
            }
          }

          // If user nickname update
          if (nickname !== 'bilibili' && nickname !== dbScope?.bilibili_live?.nickname && dbScope?.bilibili_live?.nickname) {
            log(`bilibili-live user nickname updated: ${nickname}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站昵称更新\n新：${nickname}\n旧：${dbScope?.bilibili_live?.nickname}`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live::nickname error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#b站昵称更新\n新：${nickname}\n旧：${dbScope?.bilibili_live?.nickname}`,
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
          if (nickname !== 'bilibili' && sign !== dbScope?.bilibili_live?.sign && dbScope?.bilibili_live) {
            log(`bilibili-live user sign updated: ${sign}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站签名更新\n新：${sign}\n旧：${dbScope?.bilibili_live?.sign}`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live::sign error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#b站签名更新\n新：${sign}\n旧：${dbScope?.bilibili_live?.sign}`,
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

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站头像更新\n新头像：[CQ:image,file=${avatar}]\n旧头像：[CQ:image,file=${dbScope?.bilibili_live?.avatar}]`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live::avatar error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendPhoto' }, {
                chat_id: account.tgChannelId,
                photo: avatar,
                caption: `${msgPrefix}#b站头像更新，旧头像：${dbScope?.bilibili_live?.avatar}`,
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

          // If user fans_medal update
          if (fans_medal?.medal?.target_id !== dbScope?.bilibili_live?.fans_medal?.medal?.target_id && dbScope?.bilibili_live) {
            const medalOld = dbScope?.bilibili_live?.fans_medal?.medal;
            const medalNew = fans_medal?.medal;

            log(`bilibili-live fans_medal updated: ${medalNew?.medal_name || '无佩戴'}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站佩戴粉丝牌变更\n新：${medalNew?.medal_name || '无佩戴'}${medalNew?.level ? ' / lv' + medalNew?.level : ''}${medalNew?.target_id ? ' / uid:' + medalNew?.target_id : ''}` +
                  `\n旧：${medalOld?.medal_name || '无佩戴'}${medalOld?.level ? ' / lv' + medalOld?.level : ''}${medalOld?.target_id ? ' / uid:' + medalOld?.target_id : ''}`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live::fans_medal error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#b站佩戴粉丝牌变更\n新：${medalNew?.medal_name || '无佩戴'}${medalNew?.level ? ' / lv' + medalNew?.level : ''}${medalNew?.target_id ? ' / uid:' + medalNew?.target_id : ''}` +
                  `\n旧：${medalOld?.medal_name || '无佩戴'}${medalOld?.level ? ' / lv' + medalOld?.level : ''}${medalOld?.target_id ? ' / uid:' + medalOld?.target_id : ''}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live::fans_medal success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::fans_medal error: ${err?.response?.body || err}`);
              });
            }
          }

          // If user pendant update
          if (pendant?.pid !== dbScope?.bilibili_live?.pendant?.pid && dbScope?.bilibili_live) {
            const pendantOld = dbScope?.bilibili_live?.pendant;

            log(`bilibili-live pendant updated: ${pendant?.name || '无佩戴'}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站头像挂件变更\n新：${pendant?.name || '无佩戴'}` +
                  `\n旧：${pendantOld?.name || '无佩戴'}`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live::pendant error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#b站头像挂件变更\n新：${pendant?.name || '无佩戴'}` +
                  `\n旧：${pendantOld?.name || '无佩戴'}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live::pendant success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::pendant error: ${err?.response?.body || err}`);
              });
            }
          }

          // If user nameplate update
          if (nameplate?.nid !== dbScope?.bilibili_live?.nameplate?.nid && dbScope?.bilibili_live) {
            const nameplateOld = dbScope?.bilibili_live?.nameplate;

            log(`bilibili-live nameplate updated: ${nameplate?.name || '无佩戴'}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站勋章变更\n新：${nameplate?.name || '无勋章'}${nameplate?.condition ? '（' + nameplate?.condition + '）' : ''}` +
                  `\n旧：${nameplateOld?.name || '无勋章'}${nameplateOld?.condition ? '（' + nameplateOld?.condition + '）' : ''}`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live::nameplate error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#b站勋章变更\n新：${nameplate?.name || '无勋章'}${nameplate?.condition ? '（' + nameplate?.condition + '）' : ''}` +
                  `\n旧：${nameplateOld?.name || '无勋章'}${nameplateOld?.condition ? '（' + nameplateOld?.condition + '）' : ''}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live::nameplate success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::nameplate error: ${err?.response?.body || err}`);
              });
            }
          }

          // If user official verification update
          if (official?.title !== dbScope?.bilibili_live?.official?.title && dbScope?.bilibili_live) {
            const officialOld = dbScope?.bilibili_live?.official;

            log(`bilibili-live official verification updated: ${official?.title || '无认证'}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站认证变更\n新：${official?.title || '无认证'}` +
                  `\n旧：${officialOld?.title || '无认证'}`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(err => {
                log(`go-qchttp post bilibili-live::official verification error: ${err?.response?.body || err}`);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#b站认证变更\n新：${official?.title || '无认证'}` +
                  `\n旧：${officialOld?.title || '无认证'}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {text: `${nickname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                },
              }).then(resp => {
                // log(`telegram post bilibili-live::official verification success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::official verification error: ${err?.response?.body || err}`);
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

                if (dbScope?.bilibili_live?.latestStream?.isTgSent) {
                  log(`bilibili-live notification sent, skipping...`);
                } else if ((currentTime - timestamp) >= config.bilibiliLiveBotThrottle) {
                  log(`bilibili-live too old, notifications skipped`);
                } else {
                  if (account.qGuildId && config.qGuild.enabled) {

                    await sendQGuild({method: 'send_guild_channel_msg'}, {
                      guild_id: account.qGuildId,
                      channel_id: account.qGuildChannelId,
                      message: `${msgPrefix}#b站开播：${liveTitle}\n直播间：${liveRoom}\n[CQ:image,file=${liveCover}]`,
                    }).then(resp => {
                      // log(`go-qchttp post weibo success: ${resp}`);
                    })
                    .catch(err => {
                      log(`go-qchttp post bilibili-live error: ${err?.response?.body || err}`);
                    });
                  }

                  if (account.tgChannelId && config.telegram.enabled) {

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
            const cardExtendedJson = card?.extension?.lbs && JSON.parse(card.extension.lbs) || null;
            const cardAddon = card?.display?.add_on_card_info?.[0] || cardJson?.sketch || null;
            let extendedMeta = '';

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

            // If user decorate_card verification update
            if (user?.decorate_card?.id !== dbScope?.bilibili_mblog?.user?.decorate_card?.id && dbScope?.bilibili_mblog) {
              const decoOld = dbScope?.bilibili_mblog?.user?.decorate_card;
              const decoNew = user?.decorate_card;

              log(`bilibili-mblog decorate_card updated: ${decoNew?.name || '无装扮'}`);

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#b站粉丝装扮变更\n新：${decoNew?.name || '无装扮'}${decoNew?.fan?.number ? '#' + decoNew?.fan?.number : '（无编号）'}` +
                    `\n旧：${decoOld?.name || '无装扮'}${decoOld?.fan?.number ? '#' + decoOld?.fan?.number : '（无编号）'}`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(err => {
                  log(`go-qchttp post bilibili-mblog::decorate_card error: ${err?.response?.body || err}`);
                });
              }

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  text: `${msgPrefix}#b站粉丝装扮变更\n新：${decoNew?.name || '无装扮'}${decoNew?.fan?.number ? '#' + decoNew?.fan?.number : '（无编号）'}` +
                    `\n旧：${decoOld?.name || '无装扮'}${decoOld?.fan?.number ? '#' + decoOld?.fan?.number : '（无编号）'}`,
                  reply_markup: {
                    inline_keyboard: decoNew?.id ? [
                      [
                        {text: `Decoration Link`, url: `${decoNew?.jump_url || '未知'}`},
                        {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ] : [
                      [
                        {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                      ],
                    ]
                  },
                }).then(resp => {
                  // log(`telegram post bilibili-mblog::decorate_card success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post bilibili-mblog::decorate_card error: ${err?.response?.body || err}`);
                });
              }
            }

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

              const tgMarkup = {
                inline_keyboard: [
                  [
                    {text: 'View', url: `https://t.bilibili.com/${dynamicId}`},
                    {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                  ],
                ]
              };

              const tgBody = {
                chat_id: account.tgChannelId,
                text: `${user.info.uname} #b站动态`,
                reply_markup: tgMarkup,
              };

              const qgBody = {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站动态`,
              };

              const tgForm = new FormData();
              tgForm.append('chat_id', account.tgChannelId);
              tgForm.append('reply_markup', JSON.stringify(tgMarkup));

              // If the status has additional meta (ie. reserved events)
              if (cardAddon) {
                if (cardAddon?.add_on_card_show_type === 3 && cardAddon?.vote_card) {
                  const voteJson = JSON.parse(cardAddon?.vote_card);
                  extendedMeta += `\n\n投票（id：${voteJson?.vote_id}）：\n${voteJson?.options.map(option => ` - ${option?.desc} ${option?.title}`)?.join('\n')}`;
                }

                if (cardAddon?.reserve_attach_card?.title) {
                  extendedMeta += `\n\n预约：${cardAddon.reserve_attach_card.title}（${cardAddon.reserve_attach_card?.desc_first?.text || '无详情'}）`;
                }

                if (cardJson?.sketch?.title) {
                  extendedMeta += `\n\n${cardJson?.sketch?.title}：${cardJson?.sketch?.desc_text || ''} ${cardJson?.sketch?.target_url || ''}`;
                }
              }

              // If the status has additional geolocation info
              if (cardExtendedJson) {
                extendedMeta += `\n\n坐标：${cardExtendedJson.show_title}（${cardExtendedJson.address}）`;
              }

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
                  tgBody.caption = `${msgPrefix}#b站专栏转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.author.name}\n被转标题：${originJson.title}\n\n${originJson.summary}`;
                  qgBody.message = `${msgPrefix}#b站专栏转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}\n\n被转作者：@${originJson.author.name}\n被转标题：${originJson.title}\n\n${originJson.summary}\n[CQ:image,file=${originJson?.origin_image_urls}]`;
                }

                // Text with gallery
                else if (originJson?.item?.description && originJson?.item?.pictures) {
                  // console.log(originJson?.item.pictures);

                  const photoCount = originJson.item.pictures.length;
                  const photoCountText = photoCount > 1 ? `（共 ${photoCount} 张）` : ``;
                  const photoExt = originJson?.item?.pictures[0].img_src.split('.').pop();
                  tgOptions.method = photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto';
                  tgOptions.payload = 'form';
                  tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${originJson?.item?.pictures[0].img_src}`));
                  tgForm.append('caption', `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.name}\n被转内容：${photoCountText}：${originJson?.item?.description}${extendedMeta}`);
                  qgBody.message = `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}\n\n被转作者：@${originJson.user.name}\n被转内容：${photoCountText}：${originJson?.item?.description}${extendedMeta}\n[CQ:image,file=${originJson?.item?.pictures[0].img_src}]`;

                  // if (originJson?.item?.pictures[0].img_width > 1200 || originJson?.item?.pictures[0].img_height > 1200) {
                  //   tgBody.photo = `https://experiments.sparanoid.net/imageproxy/1000x1000,fit/${originJson?.item?.pictures[0].img_src}@1036w.webp`;
                  // } else {
                  //   tgBody.photo = `${originJson?.item?.pictures[0].img_src}`;
                  // }
                  // tgBody.caption = `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.name}\n被转内容：${originJson.item.description}`;
                }

                // Video
                else if (originJson?.duration && originJson?.videos) {
                  tgOptions.method = 'sendPhoto';
                  tgBody.photo = `${originJson?.pic}`;
                  tgBody.caption = `${msgPrefix}#b站视频转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}`;
                  qgBody.message = `${msgPrefix}#b站视频转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}\n[CQ:image,file=${originJson?.pic}]`;
                }

                // Plain text
                else {
                  tgBody.text = `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.uname}\n被转动态：${originJson.item.content}`;
                  qgBody.message = `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}\n\n被转作者：@${originJson.user.uname}\n被转动态：${originJson.item.content}`;
                }

                log(`bilibili-mblog got forwarded post (${timeAgo(timestamp)})`);
              }

              // Gallery post (text post with images)
              else if (type === 2 && cardJson?.item?.pictures.length > 0) {
                const photoCount = cardJson.item.pictures.length;
                const photoCountText = photoCount > 1 ? `（共 ${photoCount} 张）` : ``;
                const photoExt = cardJson.item.pictures[0].img_src.split('.').pop();
                tgOptions.method = photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto';
                tgOptions.payload = 'form';
                // NOTE: old JSON method
                // tgBody.caption = `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}`;
                // tgBody.photo = cardJson.item.pictures[0].img_src;
                tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${cardJson.item.pictures[0].img_src}`));
                tgForm.append('caption', `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}${extendedMeta}`);
                qgBody.message = `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}${extendedMeta}\n动态链接：https://t.bilibili.com/${dynamicId}\n${cardJson.item.pictures.map(item => generateCqCode(item.img_src))}`;

                log(`bilibili-mblog got gallery post (${timeAgo(timestamp)})`);
              }

              // Text post
              else if (type === 4) {
                tgBody.text = `${msgPrefix}#b站动态：${cardJson?.item?.content.trim()}${extendedMeta}`;
                qgBody.message = `${msgPrefix}#b站动态：${cardJson?.item?.content.trim()}${extendedMeta}\n动态链接：https://t.bilibili.com/${dynamicId}`;
                log(`bilibili-mblog got text post (${timeAgo(timestamp)})`);
              }

              // Video post
              else if (type === 8) {
                tgOptions.method = 'sendPhoto';
                tgBody.photo = cardJson.pic;
                // dynamic: microblog text
                // desc: video description
                tgBody.caption = `${msgPrefix}#b站视频：${cardJson.title}\n${cardJson.dynamic}\n${cardJson.desc}`,
                tgBody.reply_markup = {
                  inline_keyboard: [
                    [
                      {text: 'View', url: `https://t.bilibili.com/${dynamicId}`},
                      {text: 'Watch Video', url: `${cardJson.short_link}`},
                      {text: `${user.info.uname}`, url: `https://space.bilibili.com/${uid}/dynamic`},
                    ],
                  ]
                };
                qgBody.message = `${msgPrefix}#b站视频：${cardJson.title}\n${cardJson.dynamic}\n${cardJson.desc}\n动态链接：https://t.bilibili.com/${dynamicId}\n视频链接：${cardJson.short_link}\n[CQ:image,file=${cardJson.pic}]`;

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
                tgBody.caption = `${msgPrefix}#b站专栏：${cardJson.title}\n\n${cardJson.summary}`;
                qgBody.message = `${msgPrefix}#b站专栏：${cardJson.title}\n\n${cardJson.summary}\n动态链接：https://t.bilibili.com/${dynamicId}\n${cardJson.origin_image_urls.map(item => generateCqCode(item))}`;

                log(`bilibili-mblog got column post (${timeAgo(timestamp)})`);
              }

              // Audio post
              else if (type === 256) {
                log(`bilibili-mblog got audio post (${timeAgo(timestamp)})`);
              }

              // General card link (calendar, etc.)
              // Share audio bookmark
              else if (type === 2048) {
                tgBody.text = `${msgPrefix}#b站动态：${cardJson?.vest?.content.trim()}${extendedMeta}`;
                qgBody.message = `${msgPrefix}#b站动态：${cardJson?.vest?.content.trim()}${extendedMeta}\n动态链接：https://t.bilibili.com/${dynamicId}`;
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

              if ((currentTime - timestamp) >= config.bilibiliBotThrottle) {
                log(`bilibili-mblog too old, notifications skipped`);
              } else {

                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, qgBody).then(resp => {
                    // log(`go-qchttp post weibo success: ${resp}`);
                  })
                  .catch(err => {
                    log(`go-qchttp post bilibili-mblog error: ${err?.response?.body || err}`);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled) {

                  await sendTelegram(tgOptions, tgOptions?.payload === 'form' ? tgForm : tgBody).then(resp => {
                    // log(`telegram post bilibili-mblog success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post bilibili-mblog error: ${err?.response?.body || err}`);
                  });

                  // Send an additional message if original post has more than one photo
                  if (cardJson?.item?.pictures?.length > 1) {
                    await Promise.all(cardJson.item.pictures.map(async (pic, idx) => {
                      if (idx === 0) return;
                      const photoCount = cardJson.item.pictures.length;
                      const photoCountText = photoCount > 1 ? `（${idx + 1}/${photoCount}）` : ``;
                      const photoExt = cardJson.item.pictures[idx].img_src.split('.').pop();

                      const tgForm = new FormData();
                      tgForm.append('chat_id', account.tgChannelId);
                      tgForm.append('reply_markup', JSON.stringify(tgMarkup));
                      tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${cardJson.item.pictures[idx].img_src}`));
                      tgForm.append('caption', `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}${extendedMeta}`);

                      await sendTelegram({
                        method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                        payload: 'form',
                      }, tgForm).then(resp => {
                        log(`telegram post bilibili-mblog (batch #${idx + 1}) success`)
                      })
                      .catch(err => {
                        log(`telegram post bilibili-mblog (batch #${idx + 1}) error: ${err?.response?.body || err}`);
                      });
                    }));
                  }
                }
              }
            } else if (dynamicId !== dbScope?.bilibili_mblog?.latestDynamic?.id && timestamp < dbScope?.bilibili_mblog?.latestDynamic?.timestampUnix) {
              log(`bilibili-mblog new post older than database. latest: ${dynamicId} (${timeAgo(timestamp)})`);

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#b站动态删除：监测到最新动态旧于数据库中的动态，可能有动态被删除（也存在网络原因误报）\n最新动态：https://t.bilibili.com/${dynamicId}\n被删动态：https://t.bilibili.com/${dbScope?.bilibili_mblog?.latestDynamic?.id}`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(err => {
                  log(`go-qchttp post bilibili-blog error: ${err?.response?.body || err}`);
                });
              }

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  text: `${msgPrefix}#b站动态删除：监测到最新动态旧于数据库中的动态，可能有动态被删除（也存在网络原因误报）`,
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
      const weiboRequestOptions = {...config.pluginOptions?.requestOptions, ...headerOnDemand(config.pluginOptions.customCookies.weibo)};

      // Weibo container ID magic words:
      // 230283 + uid: home
      // 100505 + uid: profile
      // 107603 + uid: weibo
      // 231567 + uid: videos
      // 107803 + uid: photos
      account.weiboId && await got(`https://m.weibo.cn/api/container/getIndex?type=uid&value=${account.weiboId}&containerid=107603${account.weiboId}`, weiboRequestOptions).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.ok === 1) {
          const currentTime = Date.now();
          const data = json.data;
          const cards = data?.cards;

          // Filter out unrelated cards to only keep statuses
          // card_type: 9 - normal Weibo statuses
          const statuses = cards.filter(card => { return card.card_type === 9 });

          if (statuses.length !== 0) {
            // At this point, we can get Weibo profile data from the statuses
            // This reduces one API request and can be helpful with rate limit
            // at better scale
            const user = statuses[0].mblog.user;

            const status = (
              // This is the last resort to get the latest status without sticky status
              (statuses[0]?.mblog?.created_at && statuses[1]?.mblog?.created_at &&
              +new Date(statuses[0].mblog.created_at) < +new Date(statuses[1].mblog.created_at))
            ) ? statuses[1].mblog : statuses[0].mblog;
            const retweeted_status = status?.retweeted_status;

            const timestamp = +new Date(status.created_at);
            const id = status.bid;
            const visibility = status?.visible?.type;
            const editCount = status?.edit_count || 0;
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

            // If the status has additional geolocation info
            if (status?.page_info?.type === 'place') {
              text += `\n\n坐标：${status.page_info.page_title}（${status.page_info.content1}）`;
            }

            // If the status has forced geo region string
            // input: 发布于 上海
            if (status?.region_name) {
              text += `\n\n${status.region_name}`;
            }

            // If the status has custom sending source
            if (status?.source) {
              text += status?.region_name ? `，来自 ${status.source}` : `\n\n来自 ${status.source}`;
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
                editCount: editCount,
                timestamp: new Date(timestamp),
                timestampUnix: timestamp,
                timeAgo: timeAgo(timestamp),
              }
            };

            // If user nickname update
            if (user.screen_name !== dbScope?.weibo?.user?.screen_name && dbScope?.weibo?.user?.screen_name) {
              log(`weibo user nickname updated: ${user.screen_name}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  text: `${msgPrefix}#微博昵称更新\n新：${user.screen_name}\n旧：${dbScope?.weibo?.user?.screen_name}`,
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

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#微博昵称更新\n新：${user.screen_name}\n旧：${dbScope?.weibo?.user?.screen_name}`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(err => {
                  log(`go-qchttp post weibo::nickname error: ${err?.response?.body || err}`);
                });
              }
            }

            // If user description update
            if (user.description !== dbScope?.weibo?.user?.description && dbScope?.weibo?.user?.description) {
              log(`weibo user sign updated: ${user.description}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  text: `${msgPrefix}#微博签名更新\n新：${user.description}\n旧：${dbScope?.weibo?.user?.description}`,
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

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#微博签名更新\n新：${user.description}\n旧：${dbScope?.weibo?.user?.description}`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(err => {
                  log(`go-qchttp post weibo::sign error: ${err?.response?.body || err}`);
                });
              }
            }

            // If user verified_reason update
            if (user?.verified_reason !== dbScope?.weibo?.user?.verified_reason && dbScope?.weibo?.user) {
              log(`weibo user verified_reason updated: ${user.verified_reason}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  text: `${msgPrefix}#微博认证更新\n新：${user?.verified_reason || '无认证'}\n旧：${dbScope?.weibo?.user?.verified_reason || '无认证'}`,
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

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#微博认证更新\n新：${user?.verified_reason || '无认证'}\n旧：${dbScope?.weibo?.user?.verified_reason || '无认证'}`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(err => {
                  log(`go-qchttp post weibo::verified_reason error: ${err?.response?.body || err}`);
                });
              }
            }

            // If user follow_count update
            // if (user?.follow_count !== dbScope?.weibo?.user?.follow_count && dbScope?.weibo?.user) {
            //   log(`weibo user follow_count updated: ${user.follow_count}`);

            //   // Avoid false positive from Weibo API
            //   const followBefore = dbScope?.weibo?.user?.follow_count || 0;
            //   const followAfter = user?.follow_count || 0;

            //   if (account.tgChannelId && config.telegram.enabled && Math.abs(followAfter - followBefore) < 5) {

            //     await sendTelegram({ method: 'sendMessage' }, {
            //       chat_id: account.tgChannelId,
            //       text: `${msgPrefix}#微博关注数变更 （可能存在网络原因误报）\n新：${user?.follow_count || '未知'}\n旧：${dbScope?.weibo?.user?.follow_count || '未知'}`,
            //       reply_markup: {
            //         inline_keyboard: [
            //           [
            //             {text: `View Following`, url: `https://weibo.com/u/page/follow/${user.id}`},
            //             {text: `${user.screen_name}`, url: `https://weibo.com/${user.id}`},
            //           ],
            //         ]
            //       },
            //     }).then(resp => {
            //       // log(`telegram post weibo::follow_count success: message_id ${resp.result.message_id}`)
            //     })
            //     .catch(err => {
            //       log(`telegram post weibo::follow_count error: ${err}`);
            //     });
            //   }

            //   // if (account.qGuildId && config.qGuild.enabled) {

            //   //   await sendQGuild({method: 'send_guild_channel_msg'}, {
            //   //     guild_id: account.qGuildId,
            //   //     channel_id: account.qGuildChannelId,
            //   //     message: `${msgPrefix}#微博关注数变更 （可能存在网络原因误报）\n新：${user?.follow_count || '未知'}\n旧：${dbScope?.weibo?.user?.follow_count || '未知'}`,
            //   //   }).then(resp => {
            //   //     // log(`go-qchttp post weibo success: ${resp}`);
            //   //   })
            //   //   .catch(err => {
            //   //     log(`go-qchttp post weibo::follow_count error: ${err?.response?.body || err}`);
            //   //   });
            //   // }
            // }

            // If user avatar update
            if (user.avatar_hd !== dbScope?.weibo?.user?.avatar_hd && dbScope?.weibo?.user?.avatar_hd) {
              log(`weibo user avatar updated: ${user.avatar_hd}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendPhoto' }, {
                  chat_id: account.tgChannelId,
                  photo: user.avatar_hd,
                  caption: `${msgPrefix}#微博头像更新，旧头像：${dbScope?.weibo?.user?.avatar_hd}`,
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

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#微博头像更新\n新头像：[CQ:image,file=${user.avatar_hd}]\n旧头像：[CQ:image,file=${dbScope?.weibo?.user?.avatar_hd}]`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(err => {
                  log(`go-qchttp post weibo::avatar error: ${err?.response?.body || err}`);
                });
              }
            }

            // If user cover background update
            if (user.cover_image_phone !== dbScope?.weibo?.user?.cover_image_phone && dbScope?.weibo?.user?.cover_image_phone) {
              log(`weibo user cover updated: ${user.cover_image_phone}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendPhoto' }, {
                  chat_id: account.tgChannelId,
                  photo: convertWeiboUrl(user.cover_image_phone),
                  caption: `${msgPrefix}#微博封面更新，旧封面：${convertWeiboUrl(dbScope?.weibo?.user?.cover_image_phone)}`,
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

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#微博封面更新\n新头像：[CQ:image,file=${convertWeiboUrl(user.cover_image_phone)}]\n旧头像：[CQ:image,file=${convertWeiboUrl(dbScope?.weibo?.user?.cover_image_phone)}]`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(err => {
                  log(`go-qchttp post weibo::avatar error: ${err?.response?.body || err}`);
                });
              }
            }

            // If latest post is newer than the one in database
            if (id !== dbScope?.weibo?.latestStatus?.id && timestamp > dbScope?.weibo?.latestStatus?.timestampUnix) {
              const tgOptions = {
                method: 'sendMessage',
              };

              const tgOptionsAlt = {
                method: 'sendMessage',
              };

              const tgMarkup = {
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
              };

              const tgBody = {
                chat_id: account.tgChannelId,
                text: `${msgPrefix}#微博${visibilityMap[visibility] || ''}${retweeted_status ? `转发` : `动态`}：${text}${retweeted_status ? `\n\n被转作者：@${retweeted_status.user.screen_name}\n被转内容：${stripHtml(retweeted_status.text)}` : ''}`,
                reply_markup: tgMarkup,
              };

              const qgBody = {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#微博${visibilityMap[visibility] || ''}${retweeted_status ? `转发` : `动态`}：${text}${retweeted_status ? `\n\n被转作者：@${retweeted_status.user.screen_name}\n被转内容：${stripHtml(retweeted_status.text)}` : ''}`,
              };

              const tgBodyAlt = {
                chat_id: account.tgChannelId,
              };

              const tgForm = new FormData();
              tgForm.append('chat_id', account.tgChannelId);
              tgForm.append('reply_markup', JSON.stringify(tgMarkup));

              // If post has photo
              if (status.pic_ids?.length > 0) {
                const photoCount = status.pic_ids.length;
                const photoCountText = photoCount > 1 ? `（共 ${photoCount} 张）` : ``;
                const photoExt = status.pics[0].large.url.split('.').pop();
                tgOptions.method = photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto';
                tgOptions.payload = 'form';
                // tgForm.append('photo', await readProcessedImage(`https://ww1.sinaimg.cn/large/${status.pic_ids[0]}.jpg`));
                tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${status.pics[0].large.url}`));
                tgForm.append('caption', `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}`);
                qgBody.message = `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}\n地址：https://weibo.com/${user.id}/${id}\n${status.pics.map(item => generateCqCode(item.large.url))}`;

                // NOTE: Method to send multiple photos in one sendMediaGroup
                // Pros: efficient, no need to download each photo
                // Cons: message send will fail if any photo fails to fetch fron Telegram servers
                // if (status.pic_ids?.length > 1) {
                //   tgOptionsAlt.method = 'sendMediaGroup';
                //   const acceptedPhotos = status.pic_ids.slice(0, 9);
                //   tgBodyAlt.media = acceptedPhotos.map((pic, idx) => ({
                //     type: 'photo',
                //     // Limit image size with original server and webp: failed (Bad Request: group send failed)
                //     // media: pic.img_width > 1036 || pic.img_height > 1036 ? `${pic.img_src}@1036w.webp` : `${pic.img_src}`,

                //     // Use wp.com proxy to serve image: failed (Bad Request: group send failed)
                //     // media: `https://i0.wp.com/${pic.img_src.replace('https://').replace('http://')}?w=200`,

                //     // Use my own proxy and webp prefix from bilibili: sucess
                //     media: `https://experiments.sparanoid.net/imageproxy/1000x1000,fit,jpeg/${status.pics[idx].large.url}`,
                //   }));

                //   // Only apply caption to the first image to make it auto shown on message list
                //   tgBodyAlt.media[0].caption = `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText} #多图相册：${text}`;
                // }
              }

              // If post has video
              if (status?.page_info?.type === 'video') {
                tgOptions.method = 'sendVideo';
                tgBody.video = status?.page_info?.media_info?.stream_url_hd || status?.page_info?.media_info?.stream_url;
                tgBody.caption = `${msgPrefix}#微博${visibilityMap[visibility] || ''}视频：${text}`;
                qgBody.message = `${msgPrefix}#微博${visibilityMap[visibility] || ''}视频：${text}\n地址：https://weibo.com/${user.id}/${id}`;
              }

              // TODO: parse 4k
              // https://f.video.weibocdn.com/qpH0Ozj9lx07NO9oXw4E0104120qrc250E0a0.mp4?label=mp4_2160p60&template=4096x1890.20.0&trans_finger=aaa6a0a6b46c000323ae75fc96245471&media_id=4653054126129212&tp=8x8A3El:YTkl0eM8&us=0&ori=1&bf=3&ot=h&ps=3lckmu&uid=7vYqTU&ab=3915-g1,5178-g1,966-g1,1493-g0,1192-g0,1191-g0,1258-g0&Expires=1627682219&ssig=I7RDiLeNCQ&KID=unistore,video

              log(`weibo got update: ${id} (${timeAgo(timestamp)})`);

              if ((currentTime - timestamp) >= config.weiboBotThrottle) {
                log(`weibo too old, notifications skipped`);
              } else {

                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, qgBody).then(resp => {
                    // log(`go-qchttp post weibo success: ${resp}`);
                  })
                  .catch(err => {
                    log(`go-qchttp post weibo error: ${err?.response?.body || err}`);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled) {

                  await sendTelegram(tgOptions, tgOptions?.payload === 'form' ? tgForm : tgBody).then(resp => {
                    // log(`telegram post weibo success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post weibo error: ${err?.response?.body || err}`);
                  });

                  // Send an additional message if original post has more than one photo
                  if (status.pic_ids?.length > 1) {
                    await Promise.all(status.pic_ids.map(async (pic, idx) => {
                      if (idx === 0) return;
                      const photoCount = status.pic_ids.length;
                      const photoCountText = photoCount > 1 ? `（${idx + 1}/${photoCount}）` : ``;
                      const photoExt = status.pics[idx].large.url.split('.').pop();

                      const tgForm = new FormData();
                      tgForm.append('chat_id', account.tgChannelId);
                      tgForm.append('reply_markup', JSON.stringify(tgMarkup));
                      tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${status.pics[idx].large.url}`));
                      tgForm.append('caption', `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}`);

                      await sendTelegram({
                        method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                        payload: 'form',
                      }, tgForm).then(resp => {
                        log(`telegram post weibo (batch #${idx + 1}) success`)
                      })
                      .catch(err => {
                        log(`telegram post weibo (batch #${idx + 1}) error: ${err?.response?.body || err}`);
                      });
                    }));
                  }
                }
              }
            } else if (id !== dbScope?.weibo?.latestStatus?.id && timestamp < dbScope?.weibo?.latestStatus?.timestampUnix) {
              log(`weibo new post older than database. latest: ${id} (${timeAgo(timestamp)})`);

              // NOTE: Disable deleted weibo detection. Buggy
              // if (account.tgChannelId && config.telegram.enabled) {

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

      // Fetch DDStats
      !account.disableDdstats && account.biliId && await got(`https://ddstats-api.ericlamm.xyz/records/${account.biliId}?limit=15&type=dd`).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 200) {
          const currentTime = Date.now();
          const data = json.data;

          if (data.length > 0) {
            const dbStore = {
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
            };

            // Morph data for database schema
            const activities = data.map(obj => {
              return {
                ...obj,
                created_at_unix: +new Date(obj.created_at)
              }
            });

            const dbScopeTimestampUnix = dbScope?.ddstats?.latestActivity?.timestampUnix;

            // When initial run (has db scope timestamp) ...or when the first activity returned from the API is older
            // than what we got from the last scrap: returns the first activity;
            // When not initial run: returns the whole activities newer than the last time we scraped
            const activitiesFiltered = (!dbScopeTimestampUnix || activities[0].created_at_unix <= dbScopeTimestampUnix)
              ? [activities[0]] : activities.filter(activity => {
              return activity.created_at_unix > dbScopeTimestampUnix;
            });

            argv.json && fs.writeFile(`db/${account.slug}-ddstats.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            // Loop array reversed to send the latest activity last
            for (let [idx, activity] of activitiesFiltered.reverse().entries()) {
              const timestamp = +new Date(activity.created_at);
              const id = activity.id;
              const content = activity.display;
              const parsedContent = parseDdstatsString(content);
              const idxLatest = activitiesFiltered.length - 1;

              // If last (the last one in the array is the latest now) item
              if (idx === idxLatest) {
                dbStore.latestActivity = {
                  id: id,
                  content: content,
                  timestamp: new Date(timestamp),
                  timestampUnix: timestamp,
                  timeAgo: timeAgo(timestamp),
                }
              };

              const tgOptions = {
                method: 'sendMessage',
              };

              const tgMarkup = {
                inline_keyboard: [
                  [
                    {text: 'View DDStats', url: `https://ddstats.ericlamm.xyz/user/${account.biliId}`},
                    {text: `${parsedContent?.user || 'View User'}`, url: `https://space.bilibili.com/${account.biliId}`},
                    {text: `${parsedContent?.target || 'View Target'}`, url: `https://space.bilibili.com/${activity?.target_uid}`},
                  ],
                ]
              };

              const tgBody = {
                chat_id: account.tgChannelId,
                text: `${content}`,
                // text: `${retweeted_status ? `转发` : `动态`}：${text}${retweeted_status ? `\n\n被转作者：@${retweeted_status.user.screen_name}\n被转内容：${stripHtml(retweeted_status.text)}` : ''}`,
                reply_markup: tgMarkup,
              };

              const qgBody = {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${content}`,
              };

              if (!dbScopeTimestampUnix) {
                log(`ddstats initial run, notifications skipped`);
              } else if (timestamp === dbScopeTimestampUnix) {
                log(`ddstats no update. latest: ${dbScope?.ddstats?.latestActivity?.id} (${timeAgo(dbScope?.ddstats?.latestActivity?.timestamp)})`);
              } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                log(`ddstats posible activity deleted.`);
              } else {
                log(`ddstats got update: ${id}: ${content} (${timeAgo(timestamp)})`);

                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, qgBody).then(resp => {
                    // log(`go-qchttp post ddstats success: ${resp}`);
                  })
                  .catch(err => {
                    log(`go-qchttp post ddstats error: ${err?.response?.body || err}`);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled) {

                  await sendTelegram(tgOptions, tgBody).then(resp => {
                    // log(`telegram post ddstats success: message_id ${resp.result.message_id}`)
                  })
                  .catch(err => {
                    log(`telegram post ddstats error: ${err?.response?.body || err}`);
                  });
                }
              }
            };

            // Set new data to database
            dbScope['ddstats'] = dbStore;
          } else {
            log('ddstats empty result, skipping...');
          }
        } else {
          log('ddstats info corrupted, skipping...');
        }
      })
      .catch(err => {
        log(`ddstats request error: ${err}`);
      });

      // Write new data to database
      await db.write();
      argv.verbose && log(`global db saved`);
    }
  }

  argv.verbose && console.log(`# Check loop ended at ${formatDate(Date.now())} --------------`);
  console.timeEnd('# Loop time used');
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
