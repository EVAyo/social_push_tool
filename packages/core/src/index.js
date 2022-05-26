#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { setTimeout } from 'timers/promises';
import { setIntervalAsync } from 'set-interval-async/fixed/index.js';

import got from 'got';
import chalk from 'chalk';
import { merge } from 'merge-anything';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Low, JSONFile } from 'lowdb';
import { HttpsProxyAgent } from 'hpagent';
import { FormData } from 'formdata-node';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';

import {
  formatDate,
  stripHtml,
  convertWeiboUrl,
  parseDdstatsString
} from './utils.js';
import { timeAgo } from './utils/timeAgo.js';
import { readProcessedMedia } from './utils/processMedia.js';

import TelegramBot from '@a-soul/sender-telegram';
import GoQcHttp from '@a-soul/sender-go-qchttp';
import dyExtract from '@a-soul/extractor-douyin';
import rssExtract from '@a-soul/extractor-rss';

import pkg from '../package.json' assert { type: 'json' };

const __dirname = new URL('.', import.meta.url).pathname;

const argv = yargs(hideBin(process.argv))
  // Workaround for https://github.com/yargs/yargs/issues/1934
  // TODO: remove once fixed
  .version(
    `${pkg.version} -- ${__dirname}`
  )
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
    loopInterval: 60 * 1000, // 60 seconds
    loopPauseTimeBase: 1000, // 1 seconds
    loopPauseTimeRandomFactor: 2000, // 2 seconds
    pluginOptions: {
      requestOptions: {
        timeout: {
          request: 4000
        }
      }
    },
    douyinBotThrottle: 36 * 3600 * 1000, // 36 hours, if latest post older than this value, do not send notifications
    douyinLiveBotThrottle: 1200 * 1000, // 20 mins
    bilibiliBotThrottle: 65 * 60 * 1000, // 65 mins, bilibili sometimes got limit rate for 60 mins.
    bilibiliLiveBotThrottle: 65 * 60 * 1000,
    bilibiliFollowingBotThrottle: 3600 * 1000,
    rssBotThrottle: 12 * 3600 * 1000,
    weiboBotThrottle: 3600 * 1000,
    ddstatsBotThrottle: 3600 * 1000,
    tapechatBotThrottle: 3600 * 1000,
    afdianBotThrottle: 3600 * 1000,
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

// Init Sentry
const sentryEnabled = config?.sentry?.enabled && config?.sentry?.dsn;
Sentry.init({
  dsn: config?.sentry?.dsn,
  release: `${pkg.version}`,
  environment: config?.sentry?.environment || process.env.NODE_ENV || 'development',
  integrations: [
    // enable HTTP calls tracing
    new Sentry.Integrations.Http({ tracing: true }),
  ],

  // Set tracesSampleRate to 1.0 to capture 100%
  // of transactions for performance monitoring.
  // We recommend adjusting this value in production
  tracesSampleRate: config?.sentry?.tracesSampleRate || 1.0,
  beforeSend(event) {
    if (sentryEnabled) return event;
    return null;
  }
});

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

async function main(config) {
  // Initial database
  const db = new Low(new JSONFile(path.join(path.resolve(), 'db/db.json')));

  console.time('# Loop time used');
  console.log(`\n# a-soul v${pkg.version} | loop started at ${formatDate(Date.now())} ------------`);

  for (let i = 0; i < config.accounts.length; i++) {
    const account = config.accounts[i];

    const logName = chalk.hex('#000').bgHex(account?.color ?? '#fff');

    function log(msg, type) {
      console.log(`${logName(account.slug)} ${msg}`);
    }

    function err(msg, err) {
      // Show log
      log(msg);

      // Show trace if available
      if (err.stack) {
        console.log(err.stack);
      }

      // Send error to Sentry
      Sentry.captureException(err);
    }

    // Only check enabled account
    if (account?.enabled) {
      // Set random request time to avoid request limit
      const randomPauseTime = config.loopPauseTimeBase + Math.floor(Math.random() * config.loopPauseTimeRandomFactor);
      argv.verbose && log(`wait ${randomPauseTime} ms before checking...`);
      await setTimeout(randomPauseTime);

      argv.verbose && log(`is checking...`);

      // https://docs.sentry.io/platforms/node/performance/
      const transaction = Sentry.startTransaction({
        op: 'loop',
        name: account.slug,
      });

      // Note that we set the transaction as the span on the scope.
      // This step makes sure that if an error happens during the lifetime of the transaction
      // the transaction context will be attached to the error event
      Sentry.configureScope(scope => {
        scope.setSpan(transaction);
      });

      Sentry.setUser({
        username: account.slug
      });

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
      const douyinLiveRequestUrl = `https://live.douyin.com/${account.douyinLiveId}`;
      account.douyinLiveId && argv.verbose && log(`douyin-live requesting ${douyinLiveRequestUrl}`);
      account.douyinLiveId && await dyExtract(douyinLiveRequestUrl, {...config.pluginOptions, ...cookieOnDemand(config.pluginOptions.customCookies.douyin)}).then(async resp => {
        const json = resp?.initialState?.roomStore?.roomInfo;

        if (json) {
          const status = json?.room?.status;
          const id_str = json?.room?.id_str;

          if (status === 2) {
            // Magic `app_id` from Douyin source code:
            //
            // ...
            // t[t.douyin = 1128] = "douyin",
            // t[t.huoshan = 1112] = "huoshan",
            // t[t.toutiao = 13] = "toutiao",
            // t[t.xigua = 32] = "xigua",
            // t[t.toutiaoLite = 35] = "toutiaoLite",
            // t[t.motor = 36] = "motor",
            // t[t.douyinLite = 2329] = "douyinLite",
            // t[t.jumanji = 6340] = "jumanji",
            // t[t.maya = 1349] = "maya"
            // ...
            const douyinLiveDetailsRequestUrl = `https://webcast.amemv.com/webcast/room/reflow/info/?type_id=0&live_id=1&room_id=${id_str}&app_id=1128`;
            log(`douyin-live seems started, begin second check...`);
            argv.verbose && log(`douyin-live requesting ${douyinLiveDetailsRequestUrl}`);

            await got(douyinLiveDetailsRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
              const json = JSON.parse(resp.body);

              if (json?.status_code === 0) {
                const currentTime = Date.now();
                const data = json.data;

                if (data?.room) {
                  argv.json && fs.writeFile(`db/${account.slug}-douyin-live.json`, JSON.stringify(json, null, 2), err => {
                    if (err) return console.log(err);
                  });

                  const {
                    id_str,
                    title,
                    cover,
                    create_time,
                    stream_url,
                  } = data.room;

                  const {
                    nickname,
                    web_rid,
                    sec_uid,
                    id,
                    short_id,
                    signature,
                    avatar_large,
                    authentication_info,
                  } = data.room.owner;

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

                  if (data?.room?.status === 2) {
                    log(`douyin-live started: ${title} (${timeAgo(timestamp)})`);

                    const tgOptions = {
                      method: 'sendPhoto',
                      payload: 'form'
                    };

                    const tgForm = new FormData();
                    tgForm.append('chat_id', account.tgChannelId);
                    tgForm.append('parse_mode', 'HTML');
                    tgForm.append('photo', await readProcessedMedia(`${liveCover}`));
                    tgForm.append('caption', `${msgPrefix}#抖音开播：${title}`
                      + `\n\n<a href="https://webcast.amemv.com/webcast/reflow/${id_str}">${timeAgo(timestamp, 'zh_cn')}</a>`
                      + ` | <a href="${streamUrl}">M3U8 直链</a>`
                      + ` | <a href="${liveCover}">封面</a>`
                      + ` | <a href="https://live.douyin.com/${account.douyinLiveId}">${nickname}</a>`);

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
                        .catch(e => {
                          err(`go-qchttp post douyin-live error: ${e?.response?.body || e}`, e);
                        });
                      }

                      if (account.tgChannelId && config.telegram.enabled) {

                        // This function should be waited since we rely on the `isTgSent` flag
                        await sendTelegram(tgOptions, tgForm).then(resp => {
                          // log(`telegram post douyin-live success: message_id ${resp.result.message_id}`)
                          dbStore.latestStream.isTgSent = true;
                        })
                        .catch(e => {
                          err(`telegram post douyin-live error: ${e?.response?.body || e}`, e);
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
                  log(`douyin-live empty room info, skipping...`);
                }

              } else {
                log('douyin-live stream info corrupted, skipping...');
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
      }).catch(e => {
        err(`douyin-live fetch error`, e);
      });

      // Fetch Douyin
      const douyinRequestUrl = `https://www.douyin.com/user/${account.douyinId}`;
      account.douyinId && argv.verbose && log(`douyin requesting ${douyinRequestUrl}`);
      account.douyinId && await dyExtract(douyinRequestUrl, {...config.pluginOptions, ...cookieOnDemand(config.pluginOptions.customCookies.douyin)}).then(async resp => {
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
              parse_mode: 'HTML',
              caption: `${msgPrefix}#抖音视频：${title}`
                + `\n\n<a href="${shareUrl}">${timeAgo(timestamp, 'zh_cn')}</a>`
                + ` | <a href="${cover}">封面</a>`
                + ` | <a href="https://www.douyin.com/user/${secUid}">${nickname}</a>`
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
                  .catch(e => {
                    err(`go-qchttp post douyin error: ${e?.response?.body || e}`, e);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled) {

                  await sendTelegram(tgOptions, tgBody).then(resp => {
                    // log(`telegram post douyin success: message_id ${resp.result.message_id}`)
                  })
                  .catch(e => {
                    err(`telegram post douyin error: ${e?.response?.body || e}`, e);
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
      }).catch(e => {
        err(`douyin fetch error`, e);
      });

      // Fetch bilibili live
      // This ia actually the users' homepage API, which contains the livestream info
      const bilibiliLiveRequestUrl = `https://api.bilibili.com/x/space/acc/info?mid=${account.biliId}`;
      account.biliId && argv.verbose && log(`bilibili-live requesting ${bilibiliLiveRequestUrl}`);
      account.biliId && await got(bilibiliLiveRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data;

          if (typeof data.live_room === 'undefined' || data.live_room === null) {
            log(`bilibili-live live room not available for this user, skipping...`);
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

          // Avatar and cover URL is not reliable, URL may change because of CDN
          const avatarHash = avatar && new URL(avatar);
          const liveCoverHash = liveCover && new URL(liveCover);

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
            parse_mode: 'HTML',
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
              .catch(e => {
                err(`go-qchttp post bilibili-live title error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站直播间标题更新\n新：${liveTitle}\n旧：${dbScope?.bilibili_live?.latestStream?.liveTitle}`
                  + `\n\n<a href="${liveRoom}">查看直播间</a>`
                  + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live title success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live title error: ${e?.response?.body || e}`, e);
              });
            }
          }

          // If live room cover updates
          const oldLiveCoverHash = dbScope?.bilibili_live?.latestStream?.liveCover && new URL(dbScope?.bilibili_live?.latestStream?.liveCover);
          if (
            liveCoverHash && oldLiveCoverHash &&
            liveCoverHash.pathname !== oldLiveCoverHash.pathname &&
            liveStatus === dbScope?.bilibili_live?.latestStream?.liveStatus
          ) {
            log(`bilibili-live cover updated: ${liveCover}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站直播间封面更新\n新封面：[CQ:image,file=${liveCover}]\n旧封面：[CQ:image,file=${dbScope?.bilibili_live?.latestStream?.liveCover}]`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(e => {
                err(`go-qchttp post bilibili-live::cover error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {
              const photoExt = liveCover.split('.').pop();
              const tgForm = new FormData();
              const liveCoverImage = await readProcessedMedia(`${liveCover}`);
              tgForm.append('chat_id', account.tgChannelId);
              tgForm.append('parse_mode', 'HTML');
              tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', liveCoverImage, photoExt === 'gif' && 'image.gif');
              tgForm.append('caption', `${msgPrefix}#b站直播间封面更新，旧封面：${dbScope?.bilibili_live?.latestStream?.liveCover}`
                + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              );

              await sendTelegram({
                method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                payload: 'form',
              }, tgForm).then(resp => {
                // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::cover error: ${e?.response?.body || e}`, e);
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
              .catch(e => {
                err(`go-qchttp post bilibili-live::nickname error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站昵称更新\n新：${nickname}\n旧：${dbScope?.bilibili_live?.nickname}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::nickname success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::nickname error: ${e?.response?.body || e}`, e);
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
              .catch(e => {
                err(`go-qchttp post bilibili-live::sign error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站签名更新\n新：${sign}\n旧：${dbScope?.bilibili_live?.sign}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::sign success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::sign error: ${e?.response?.body || e}`, e);
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
              .catch(e => {
                err(`go-qchttp post bilibili-live::avatar error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {
              const photoExt = avatar.split('.').pop();
              const tgForm = new FormData();
              const avatarImage = await readProcessedMedia(`${avatar}`);
              tgForm.append('chat_id', account.tgChannelId);
              tgForm.append('parse_mode', 'HTML');
              tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', avatarImage, photoExt === 'gif' && 'image.gif');
              tgForm.append('caption', `${msgPrefix}#b站头像更新，旧头像：${dbScope?.bilibili_live?.avatar}`
                + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              );

              await sendTelegram({
                method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                payload: 'form',
              }, tgForm).then(resp => {
                // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::avatar error: ${e?.response?.body || e}`, e);
              });

              if (account.tgChannelAvatarSource && account.tgChannelAvatarSource.includes('bilibili')) {
                log(`telegram avatar update enabled from bilibili-live: ${avatar}`);

                const tgAvatarForm = new FormData();
                tgAvatarForm.append('chat_id', account.tgChannelId);
                tgAvatarForm.append('photo', avatarImage);

                await sendTelegram({
                  method: 'setChatPhoto',
                  payload: 'form',
                }, tgAvatarForm).then(resp => {
                  // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post bilibili-live::avatar error: ${e?.response?.body || e}`, e);
                });
              }
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
              .catch(e => {
                err(`go-qchttp post bilibili-live::fans_medal error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站佩戴粉丝牌变更\n新：${medalNew?.medal_name || '无佩戴'}${medalNew?.level ? ' / lv' + medalNew?.level : ''}${medalNew?.target_id ? ' / uid:' + medalNew?.target_id : ''}`
                  + `\n旧：${medalOld?.medal_name || '无佩戴'}${medalOld?.level ? ' / lv' + medalOld?.level : ''}${medalOld?.target_id ? ' / uid:' + medalOld?.target_id : ''}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::fans_medal success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::fans_medal error: ${e?.response?.body || e}`, e);
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
              .catch(e => {
                err(`go-qchttp post bilibili-live::pendant error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站头像挂件变更\n新：${pendant?.name || '无佩戴'}`
                  + `\n旧：${pendantOld?.name || '无佩戴'}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::pendant success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::pendant error: ${e?.response?.body || e}`, e);
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
              .catch(e => {
                err(`go-qchttp post bilibili-live::nameplate error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站勋章变更\n新：${nameplate?.name || '无勋章'}${nameplate?.condition ? '（' + nameplate?.condition + '）' : ''}`
                  + `\n旧：${nameplateOld?.name || '无勋章'}${nameplateOld?.condition ? '（' + nameplateOld?.condition + '）' : ''}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::nameplate success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::nameplate error: ${e?.response?.body || e}`, e);
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
              .catch(e => {
                err(`go-qchttp post bilibili-live::official verification error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站认证变更\n新：${official?.title || '无认证'}`
                  + `\n旧：${officialOld?.title || '无认证'}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::official verification success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::official verification error: ${e?.response?.body || e}`, e);
              });
            }
          }

          // If user vip status update
          if (vip?.due_date !== dbScope?.bilibili_live?.vip?.due_date && dbScope?.bilibili_live) {
            const vipOld = dbScope?.bilibili_live?.vip;

            log(`bilibili-live vip status updated: ${vip?.due_date ? formatDate(vip?.due_date) + ' 过期' : '已过期'}`);

            if (account.qGuildId && config.qGuild.enabled) {

              await sendQGuild({method: 'send_guild_channel_msg'}, {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${msgPrefix}#b站大会员变更\n新：${vip?.label?.text || '无会员'}（${vip?.due_date ? formatDate(vip?.due_date) + ' 过期' : '已过期'}）` +
                  `\n旧：${vipOld?.label?.text || '无会员'}（${vipOld?.due_date ? formatDate(vipOld?.due_date) + ' 过期' : '已过期'}）`,
              }).then(resp => {
                // log(`go-qchttp post weibo success: ${resp}`);
              })
              .catch(e => {
                err(`go-qchttp post bilibili-live::vip status error: ${e?.response?.body || e}`, e);
              });
            }

            if (account.tgChannelId && config.telegram.enabled) {

              await sendTelegram({ method: 'sendMessage' }, {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站大会员变更\n新：${vip?.label?.text || '无会员'}（${vip?.due_date ? formatDate(vip?.due_date) + ' 过期' : '已过期'}）`
                  + `\n旧：${vipOld?.label?.text || '无会员'}（${vipOld?.due_date ? formatDate(vipOld?.due_date) + ' 过期' : '已过期'}）`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::vip status success: message_id ${resp.result.message_id}`)
              })
              .catch(e => {
                err(`telegram post bilibili-live::vip status error: ${e?.response?.body || e}`, e);
              });
            }
          }

          // 1: live
          // 0: not live
          if (room?.liveStatus === 1) {

            // Deprecated v1 API, may be changed in the future
            // const bilibiliLiveInfoRequestUrl = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${liveId}`;
            const bilibiliLiveInfoRequestUrl = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${liveId}&protocol=0,1&format=0,1,2&codec=0,1&qn=0&platform=web&ptype=8&dolby=5`;
            argv.verbose && log(`bilibili-live stream info requesting ${bilibiliLiveInfoRequestUrl}`);
            await got(bilibiliLiveInfoRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
              const json = JSON.parse(resp.body);

              if (json?.code === 0) {
                const data = json.data;
                const timestamp = data.live_time * 1000;
                // TODO: parse m3u8 links
                const streamUrls = data?.playurl_info;

                tgBody.caption = `${msgPrefix}#b站开播：${liveTitle}`
                  + `\n\n<a href="${liveRoom}">${timeAgo(timestamp, 'zh_cn')}</a>`
                  + ` | <a href="${liveCover}">封面</a>`
                  + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${nickname}</a>`;

                argv.json && fs.writeFile(`db/${account.slug}-bilibili-live.json`, JSON.stringify(json, null, 2), err => {
                  if (err) return console.log(err);
                });

                // Always returns -62170012800 (v1) or 0 (v2) when stream not start
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
                    .catch(e => {
                      err(`go-qchttp post bilibili-live error: ${e?.response?.body || e}`, e);
                    });
                  }

                  if (account.tgChannelId && config.telegram.enabled) {

                    // This function should be waited since we rely on the `isTgSent` flag
                    await sendTelegram(tgOptions, tgBody).then(resp => {
                      // log(`telegram post bilibili-live success: message_id ${resp.result.message_id}`)
                      dbStore.latestStream.isTgSent = true;
                    })
                    .catch(e => {
                      err(`telegram post bilibili-live error: ${e?.response?.body || e}`, e);
                    });
                  }
                }
              } else {
                log('bilibili-live stream info corrupted, skipping...');
              };
            })
            .catch(e => {
              err(`bilibili-live stream info request error: ${e?.response?.body || e}`, e);
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
      .catch(e => {
        err(`bilibili-live user info request error: ${e?.response?.body || e}`, e);
      });

      // Fetch bilibili microblog (dynamics)
      const bilibiliMblogRequestUrl = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${account.biliId}&offset_dynamic_id=0&need_top=0&platform=web`;
      account.biliId && argv.verbose && log(`bilibili-mblog requesting ${bilibiliMblogRequestUrl}`);
      account.biliId && await got(bilibiliMblogRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data;
          const cards = data?.cards;

          if (cards && cards.length > 0) {
            const card = cards[0];
            const cardMeta = card.desc;

            const {
              uid,
              user_profile: user
            } = cardMeta;

            argv.json && fs.writeFile(`db/${account.slug}-bilibili-mblog.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

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
                .catch(e => {
                  err(`go-qchttp post bilibili-mblog::decorate_card error: ${e?.response?.body || e}`, e);
                });
              }

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#b站粉丝装扮变更\n新：${decoNew?.name || '无装扮'}${decoNew?.fan?.number ? '#' + decoNew?.fan?.number : '（无编号）'}`
                    + `\n旧：${decoOld?.name || '无装扮'}${decoOld?.fan?.number ? '#' + decoOld?.fan?.number : '（无编号）'}`
                    + `${decoNew?.id ? `\n\n<a href="${decoNew?.jump_url || '未知'}">装扮链接</a>` : ''}`
                    + `${decoNew?.id ? ` | ` : `\n\n`}<a href="https://space.bilibili.com/${uid}">${user.info.uname}</a>`
                }).then(resp => {
                  // log(`telegram post bilibili-mblog::decorate_card success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post bilibili-mblog::decorate_card error: ${e?.response?.body || e}`, e);
                });
              }
            }

            // Creating Telegram cache set from database. This ensure no duplicated notifications will be sent
            const tgCacheSet = new Set(Array.isArray(dbScope?.bilibili_mblog?.tgCache) ? dbScope.bilibili_mblog.tgCache.reverse().slice(0, 30).reverse() : []);
            const tgCommentsCacheSet = new Set(Array.isArray(dbScope?.bilibili_mblog?.tgCommentsCache) ? dbScope.bilibili_mblog.tgCommentsCache.reverse().slice(0, 500).reverse() : []);

            // Start storing time-sensitive data after checking user info changes
            const dbStore = {
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
              user: user,
            };

            // Morph data for database schema
            const activities = cards.map(obj => {
              return {
                ...obj,
                created_at_unix: +new Date(obj.desc.timestamp * 1000)
              }
              // Sort array by date in ascending order (reversed). This will make the sticky status in its right order
            }).sort((a, b) => a.created_at_unix - b.created_at_unix);

            // console.log(`activities`, activities);

            const dbScopeTimestampUnix = dbScope?.bilibili_mblog?.latestDynamic?.timestampUnix;

            // Loop array
            for (let [idx, activity] of activities.entries()) {
              const cardMeta = activity.desc;
              const cardJson = JSON.parse(activity.card);
              const cardExtendedJson = activity?.extension?.lbs && JSON.parse(activity.extension.lbs) || null;
              const cardAddon = activity?.display?.add_on_card_info?.[0] || cardJson?.sketch || null;
              const idxLatest = activities.length - 1;
              let extendedMeta = '';

              // NOTE: card content (mblog content) is escaped inside JSON,
              // uncomment the following to output parsed JSON for debugging
              // if (account.slug === '测试账号') {
              //   log(`cardJson`);
              //   console.log(cardJson);
              // };

              const {
                uid,
                type,
                orig_type: origType,
                dynamic_id_str: dynamicId,
                rid_str: commentsId,
                user_profile: user
              } = cardMeta;
              const timestamp = cardMeta.timestamp * 1000;

              // If last (the last one in the array is the latest now) item
              if (idx === idxLatest) {
                dbStore.latestDynamic = {
                  id: dynamicId,
                  type: type,
                  timestamp: new Date(timestamp),
                  timestampUnix: timestamp,
                  timeAgo: timeAgo(timestamp),
                }
              };

              if (!dbScopeTimestampUnix) {
                log(`bilibili-mblog initial run, notifications skipped`);
              } else if (timestamp === dbScopeTimestampUnix) {
                log(`bilibili-mblog no update. latest: ${dbScope?.bilibili_mblog?.latestDynamic?.id} (${timeAgo(dbScope?.bilibili_mblog?.latestDynamic?.timestamp)})`);

                // Set comment type based on activity type
                //
                // Check post type
                // https://www.mywiki.cn/dgck81lnn/index.php/%E5%93%94%E5%93%A9%E5%93%94%E5%93%A9API%E8%AF%A6%E8%A7%A3
                //
                // Activity type:
                // 1	转发动态	355295470145652823	查看 查询
                // 2	相册投稿	351782199784737587	查看 查询
                // 4	文字动态	371794999330051793	查看 查询
                // 8	视频投稿	355292278981797225	查看 查询
                // 16	VC小视频投稿	354713888622461421	查看 查询
                // 64	专栏投稿	334997154054634266	查看 查询
                // 256	音频投稿	352216850471547670	查看 查询
                // 2048	直播日历、分享歌单	325805722180163707	查看 查询
                // 4300	分享视频收藏夹	355307388674695344	查看 查询
                //
                // Comment type:
                // 1	视频投稿	AV号	59671812	查看 查询
                // 5	VC小视频投稿	VC号	2879073	查看 查询
                // 11	相册投稿	相册投稿号	65916366	查看 查询
                // 12	专栏投稿	CV号	3695898	查看 查询
                // 14	音频投稿	AU号	1285217	查看 查询
                // 17	其他动态	动态号	371794999330051793	查看 查询
                // 19	音频歌单	AM号	10624	查看 查询
                const commentsTypeMap = {
                  1: 17,
                  2: 11,
                  4: 17,
                  8: 1,
                  16: 5,
                  64: 12,
                  256: 14,
                  2048: 17,
                  4300: 17,
                };

                const commentsIdMap = {
                  1: dynamicId,
                  2: commentsId,
                  4: dynamicId,
                  8: commentsId,
                  16: commentsId,
                  64: commentsId,
                  256: commentsId,
                  2048: dynamicId,
                  4300: dynamicId,
                }

                if (account.bilibiliFetchComments) {
                  const commentsJar = [];
                  let commentReqCounter = 0;

                  async function requestBilibiliComments(options) {
                    // mode 2: sort by latest
                    // mode 3: sort by hotest
                    const {
                      mode = 2,
                      limit = account?.bilibiliFetchCommentsLimit || 5,
                      page,
                    } = options;

                    const bilibiliCommentsRequestUrl = page
                      ? `https://api.bilibili.com/x/v2/reply/main?mode=${mode}&next=${page}&oid=${commentsIdMap[type]}&type=${commentsTypeMap[type]}`
                      : `https://api.bilibili.com/x/v2/reply/main?mode=${mode}&oid=${commentsIdMap[type]}&type=${commentsTypeMap[type]}`;
                    log(`bilibili-mblog fetching comments (mode: ${mode}) from ${commentsIdMap[type]} with ${commentReqCounter}/${limit} (tick ${page || '0'}) for activity ${dynamicId}...`)
                    argv.verbose && log(`bilibili-mblog comments (mode: ${mode}) requesting ${bilibiliCommentsRequestUrl}`);

                    // A small amount of random time to behavior more like a human
                    await setTimeout(Math.floor(Math.random() * 1000));

                    await got(bilibiliCommentsRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
                      const json = JSON.parse(resp.body);
                      const comments = Array.isArray(json?.data?.replies) && json.data.replies.length > 0 ? json.data.replies : [];

                      if (json?.code === 0 && comments.length > 0 && commentReqCounter < limit) {
                        const cursor = json.data.cursor;
                        const stickyComments = json?.data?.top?.upper;

                        // When fetch using mode 3, every page will return sticky comment so only keep the first one
                        stickyComments && !page && comments.unshift(stickyComments);
                        commentsJar.push(...comments);
                        commentReqCounter += 1;
                        argv.verbose && log(`bilibili-mblog comments (mode: ${mode}) got ${comments.length} comments`);

                        if (cursor?.is_end !== true) {
                          await requestBilibiliComments({
                            mode: mode,
                            limit: limit,
                            page: cursor.next
                          });
                        }
                      } else {
                        // Reset counter for other loops
                        commentReqCounter = 0;
                        argv.verbose && log(`bilibili-mblog comments (mode: ${mode}) no more pages to fetch`);
                      }
                      // return comments;
                    }).catch(e => {
                      commentReqCounter = 0;
                      err(`bilibili-mblog comments (mode: ${mode}) ${commentsId} with tick ${page || '0'} request error: ${err}`, e);
                    });
                  }

                  // Fetch latest comments
                  await requestBilibiliComments({mode: 2});

                  // Fetch hotest comments (the first 3 pages)
                  await requestBilibiliComments({mode: 3, limit: 2});

                  // Filter duplicated, and sort by date
                  const commentUniqueIds = new Set();
                  const comments = commentsJar.filter(comment => {
                    const isDuplicated = commentUniqueIds.has(comment.rpid_str);
                    commentUniqueIds.add(comment.rpid_str);

                    if (!isDuplicated) {
                      return true;
                    }

                    return false;
                  }).sort((a, b) => a.ctime - b.ctime);

                  log(`bilibili-mblog comments total got ${comments.length}`);

                  // Debug only
                  // fs.writeFile(`db/${account.slug}-bilibili-comments.json`, JSON.stringify(comments, null, 2), err => {
                  //   if (err) return console.log(err);
                  // });

                  if (comments.length > 0) {

                    for (const [idx, comment] of comments.entries()) {

                      if (comment?.member?.mid === account.biliId && !tgCommentsCacheSet.has(comment.rpid_str)) {
                        log(`bilibili-mblog author comment detected ${comment.rpid_str} for activity ${dynamicId}...`);

                        if (account.tgChannelId && config.telegram.enabled) {

                          await sendTelegram({ method: 'sendMessage' }, {
                            chat_id: account?.tgChannelIdForComments || account.tgChannelId,
                            parse_mode: 'HTML',
                            disable_web_page_preview: true,
                            disable_notification: true,
                            // Not implemented yet. You cannot get the `reply_to_message_id` auto-forwarded to the
                            // linked discussion group.
                            // https://github.com/php-telegram-bot/core/issues/1171
                            // reply_to_message_id: 1446,
                            allow_sending_without_reply: true,
                            text: `${msgPrefix}#b站新评论：${stripHtml(comment?.content?.message) || '未知内容'}`
                              + `\n\n<a href="https://t.bilibili.com/${dynamicId}#reply${comment.rpid_str}">${timeAgo(+new Date(comment.ctime * 1000), 'zh_cn')}</a>`
                              + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`
                          }).then(resp => {
                            log(`telegram post bilibili-mblog::author_comment success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                            tgCommentsCacheSet.add(comment.rpid_str);
                          })
                          .catch(e => {
                            err(`telegram post bilibili-mblog::author_comment error: ${err}`, e);
                          });
                        }
                      }

                      // Check replies inside comments
                      if (!account.bilibiliFetchCommentsDisableReplies && Array.isArray(comment?.replies) && comment.replies.length > 0) {
                        const replies = comment.replies;

                        for (const [idx, reply] of replies.entries()) {

                          if (reply?.member?.mid === account.biliId && !tgCommentsCacheSet.has(reply.rpid_str)) {
                            log(`bilibili-mblog author comment reply detected ${reply.rpid_str} in comment ${comment.rpid_str} for activity ${dynamicId}...`)

                            if (account.tgChannelId && config.telegram.enabled) {

                              await sendTelegram({ method: 'sendMessage' }, {
                                chat_id: account?.tgChannelIdForComments || account.tgChannelId,
                                parse_mode: 'HTML',
                                disable_web_page_preview: true,
                                disable_notification: true,
                                allow_sending_without_reply: true,
                                text: `${msgPrefix}#b站新评论回复：${stripHtml(reply?.content?.message) || '未知内容'}`
                                  + `\n\n被回复的评论：<a href="https://t.bilibili.com/${dynamicId}#reply${comment.rpid_str}">${timeAgo(+new Date(comment.ctime * 1000), 'zh_cn')}</a> <a href="https://space.bilibili.com/${comment.member.mid}">@${comment?.member?.uname || '未知用户名'}</a>: ${stripHtml(comment?.content?.message) || '未知内容'}`
                                  + `\n\n<a href="https://t.bilibili.com/${dynamicId}#reply${reply.rpid_str}">${timeAgo(+new Date(reply.ctime * 1000), 'zh_cn')}</a>`
                                  + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`
                                }).then(resp => {
                                log(`telegram post bilibili-mblog::author_comment_reply success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                                tgCommentsCacheSet.add(reply.rpid_str);
                              })
                              .catch(e => {
                                err(`telegram post bilibili-mblog::author_comment_reply error: ${err}`, e);
                              });
                            }
                          }
                        }
                      } else {
                        argv.verbose && log(`bilibili-mblog comment ${comment.rpid_str} has no author reply, skipped`);
                      }
                    }
                  } else {
                    log('bilibili-mblog comments corrupted or has no reply, skipped');
                  }
                }
              } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                log(`bilibili-mblog new post older than database. latest: ${dynamicId} (${timeAgo(timestamp)})`);
                // NOTE: Disable deleted dynamic detection when API is unstable
                // if (account.qGuildId && config.qGuild.enabled) {

                //   await sendQGuild({method: 'send_guild_channel_msg'}, {
                //     guild_id: account.qGuildId,
                //     channel_id: account.qGuildChannelId,
                //     message: `${msgPrefix}#b站动态删除：监测到最新动态旧于数据库中的动态，可能有动态被删除（也存在网络原因误报）\n最新动态：https://t.bilibili.com/${dynamicId}\n被删动态：https://t.bilibili.com/${dbScope?.bilibili_mblog?.latestDynamic?.id}`,
                //   }).then(resp => {
                //     // log(`go-qchttp post weibo success: ${resp}`);
                //   })
                //   .catch(e => {
                //     err(`go-qchttp post bilibili-blog error: ${e?.response?.body || e}`, e);
                //   });
                // }

                // if (account.tgChannelId && config.telegram.enabled) {

                //   await sendTelegram({ method: 'sendMessage' }, {
                //     chat_id: account.tgChannelId,
                //     parse_mode: 'HTML',
                //     disable_web_page_preview: true,
                //     text: `${msgPrefix}#b站动态删除：监测到最新动态旧于数据库中的动态，可能有动态被删除（也存在网络原因误报）`
                //       + `\n\n<a href="https://t.bilibili.com/${dynamicId}">Latest</a>`
                //       + ` | <a href="https://t.bilibili.com/${dbScope?.bilibili_mblog?.latestDynamic?.id}">Deleted</a>`
                //       + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`
                //   }).then(resp => {
                //     // log(`telegram post bilibili-mblog success: message_id ${resp.result.message_id}`)
                //   })
                //   .catch(e => {
                //     err(`telegram post bilibili-mblog error: ${e?.response?.body || e}`, e);
                //   });
                // }

              } else if (idx === idxLatest && (currentTime - timestamp) >= config.bilibiliBotThrottle) {
                log(`bilibili-mblog latest status ${dynamicId} (${timeAgo(timestamp)}) older than 'bilibiliBotThrottle', skipping...`);
              } else if (timestamp < dbScopeTimestampUnix) {
                argv.verbose && log(`bilibili-mblog got old activity: ${dynamicId} (${timeAgo(timestamp)}), discarding...`);
              } else {
                log(`bilibili-mblog got update: ${dynamicId} (${timeAgo(timestamp)})`);

                const tgOptions = {
                  method: 'sendMessage',
                };

                const tgBodyFooter = `\n\n<a href="https://t.bilibili.com/${dynamicId}">${timeAgo(timestamp, 'zh_cn')}</a>`
                  + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`;

                const tgBody = {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#b站动态`
                };

                const qgBody = {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#b站动态`
                };

                const tgForm = new FormData();
                tgForm.append('chat_id', account.tgChannelId);
                tgForm.append('parse_mode', 'HTML');

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
                // bilibili returns false positive data for ukown geolocation:
                // lbs: "{\"location\":{},\"title\":\"隐藏位置\"}"
                if (cardExtendedJson) {
                  extendedMeta += `\n\n坐标：${cardExtendedJson.show_title || cardExtendedJson.title || '未知'}（${cardExtendedJson.address || '未知坐标'}）`;
                }

                // Forwarded post (think retweet)
                if (type === 1) {
                  const originJson = JSON.parse(cardJson?.origin);

                  // console.log(`originJson`, originJson);

                  // Column post
                  if (originJson?.origin_image_urls) {
                    tgOptions.method = 'sendPhoto';
                    tgOptions.payload = 'form';
                    tgForm.append('photo', await readProcessedMedia(`${originJson?.origin_image_urls}`));
                    tgForm.append('caption', `${msgPrefix}#b站专栏转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.author.name}\n被转标题：${originJson.title}\n\n${originJson.summary}${tgBodyFooter}`);
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
                    tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedMedia(`${originJson?.item?.pictures[0].img_src}`), photoExt === 'gif' && 'image.gif');
                    tgForm.append('caption', `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.name}\n被转内容：${photoCountText}：${originJson?.item?.description}${extendedMeta}${tgBodyFooter}`);
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
                    const photoExt = originJson?.pic.split('.').pop();
                    tgOptions.method = photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto';
                    tgOptions.payload = 'form';
                    tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedMedia(`${originJson?.pic}`), photoExt === 'gif' && 'image.gif');
                    tgForm.append('caption', `${msgPrefix}#b站视频转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}${tgBodyFooter}`);

                    qgBody.message = `${msgPrefix}#b站视频转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}\n[CQ:image,file=${originJson?.pic}]`;
                  }

                  // Live room (shared manually)
                  // https://t.bilibili.com/662673746854674485
                  else if (originJson?.roomid && originJson?.uname) {
                    tgBody.text = `${msgPrefix}#b站直播间转发：${cardJson?.item?.content.trim()}\n\n被转直播间：@<a href="https://live.bilibili.com/${originJson.roomid}">${originJson.uname}</a>\n直播间标题：${originJson.title}${tgBodyFooter}`;
                    qgBody.message = `${msgPrefix}#b站直播间转发：${cardJson?.item?.content.trim()}\n被转直播间：@${originJson.uname} https://live.bilibili.com/${originJson.roomid}\n直播间标题：${originJson.title}`;
                  }

                  // Live room (retweeted from auto post when original live start)
                  // https://t.bilibili.com/663437581017415703
                  else if (originJson?.live_play_info) {
                    tgBody.text = `${msgPrefix}#b站直播转发：${cardJson?.item?.content.trim()}\n\n被转直播间：@<a href="${originJson.live_play_info.link}">${cardJson?.origin_user?.info?.uname || '未知用户'}</a>\n直播间标题：${originJson.live_play_info.title}${tgBodyFooter}`;
                    qgBody.message = `${msgPrefix}#b站直播转发：${cardJson?.item?.content.trim()}\n被转直播间：@${cardJson?.origin_user?.info?.uname} ${originJson.live_play_info.link}\n直播间标题：${originJson.live_play_info.title}`;
                  }

                  // Plain text
                  else if (originJson?.user?.uname) {
                    tgBody.text = `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.uname}\n被转动态：${originJson.item.content}${tgBodyFooter}`;
                    qgBody.message = `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}\n\n被转作者：@${originJson.user.uname}\n被转动态：${originJson.item.content}`;
                  }

                  // Unknown type
                  else {
                    tgBody.text = `${msgPrefix}#b站未知类型转发：${cardJson?.item?.content.trim()}${tgBodyFooter}`;
                    qgBody.message = `${msgPrefix}#b站未知类型转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}`;
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
                  tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedMedia(`${cardJson.item.pictures[0].img_src}`), photoExt === 'gif' && 'image.gif');
                  tgForm.append('caption', `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}${extendedMeta}${tgBodyFooter}`);
                  qgBody.message = `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}${extendedMeta}\n动态链接：https://t.bilibili.com/${dynamicId}\n${cardJson.item.pictures.map(item => generateCqCode(item.img_src))}`;

                  log(`bilibili-mblog got gallery post (${timeAgo(timestamp)})`);
                }

                // Text post
                else if (type === 4) {
                  tgBody.text = `${msgPrefix}#b站动态：${cardJson?.item?.content.trim()}${extendedMeta}${tgBodyFooter}`;
                  qgBody.message = `${msgPrefix}#b站动态：${cardJson?.item?.content.trim()}${extendedMeta}\n动态链接：https://t.bilibili.com/${dynamicId}`;
                  log(`bilibili-mblog got text post (${timeAgo(timestamp)})`);
                }

                // Video post
                else if (type === 8) {
                  const photoExt = cardJson.pic.split('.').pop();
                  tgOptions.method = photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto';
                  tgOptions.payload = 'form';
                  tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedMedia(`${cardJson.pic}`), photoExt === 'gif' && 'image.gif');
                  // dynamic: microblog text
                  // desc: video description
                  tgForm.append('caption', `${msgPrefix}#b站视频：${cardJson.title}\n${cardJson.dynamic}\n${cardJson.desc}`
                    + `\n\n<a href="https://t.bilibili.com/${dynamicId}">${timeAgo(timestamp, 'zh_cn')}</a>`
                    + ` | <a href="${cardJson.short_link}">观看视频</a>`
                    + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`);

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
                  tgOptions.payload = 'form';
                  tgForm.append('photo', await readProcessedMedia(`${cardJson.origin_image_urls[0]}`));
                  tgForm.append('caption', `${msgPrefix}#b站专栏：${cardJson.title}\n\n${cardJson.summary}${tgBodyFooter}`);
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
                  tgBody.text = `${msgPrefix}#b站动态：${cardJson?.vest?.content.trim()}${extendedMeta}${tgBodyFooter}`;
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
                    .catch(e => {
                      err(`go-qchttp post bilibili-mblog error: ${e?.response?.body || e}`, e);
                    });
                  }

                  if (account.tgChannelId && config.telegram.enabled && !tgCacheSet.has(dynamicId)) {

                    await sendTelegram(tgOptions, tgOptions?.payload === 'form' ? tgForm : tgBody).then(resp => {
                      argv.verbose && log(`telegram post bilibili-mblog success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                      console.log(`JSON.parse(resp.body)?.result`, JSON.parse(resp.body)?.result);
                      tgCacheSet.add(dynamicId);
                    })
                    .catch(e => {
                      err(`telegram post bilibili-mblog error: ${e?.response?.body || e}`, e);
                    });

                    // Send an additional message if original post has more than one photo
                    if (cardJson?.item?.pictures?.length > 1) {

                      for (const [idx, pic] of cardJson.item.pictures.entries()) {

                        if (idx !== 0) {
                          const photoCount = cardJson.item.pictures.length;
                          const photoCountText = photoCount > 1 ? `（${idx + 1}/${photoCount}）` : ``;
                          const photoExt = cardJson.item.pictures[idx].img_src.split('.').pop();

                          const tgForm = new FormData();
                          tgForm.append('chat_id', account.tgChannelId);
                          tgForm.append('parse_mode', 'HTML');
                          tgForm.append('disable_notification', true);
                          tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedMedia(`${cardJson.item.pictures[idx].img_src}`), photoExt === 'gif' && 'image.gif');
                          tgForm.append('caption', `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}${extendedMeta}${tgBodyFooter}`);

                          await sendTelegram({
                            method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                            payload: 'form',
                          }, tgForm).then(resp => {
                            log(`telegram post bilibili-mblog (batch #${idx + 1}) success`)
                          })
                          .catch(e => {
                            err(`telegram post bilibili-mblog (batch #${idx + 1}) error: ${e?.response?.body || e}`, e);
                          });
                        }
                      }
                    }
                  }
                }
              }
            };

            // Set new data to database
            dbStore.tgCache = [...tgCacheSet];
            dbStore.tgCommentsCache = [...tgCommentsCacheSet];
            dbScope['bilibili_mblog'] = dbStore;
          } else {
            log('bilibili-mblog empty result, skipping...');
          }
        } else {
          log('bilibili-mblog info corrupted, skipping...');
        }
      })
      .catch(e => {
        err(`bilibili-mblog request error: ${e?.response?.body || e}`, e);
      });

      // Fetch Weibo
      const weiboRequestOptions = {...config.pluginOptions?.requestOptions, ...headerOnDemand(config.pluginOptions.customCookies.weibo)};

      // Weibo container ID magic words:
      // 230413 + uid: new home with sticky post in a separate card
      // 230283 + uid: home
      // 100505 + uid: profile
      // 107603 + uid: weibo
      // 231567 + uid: videos
      // 107803 + uid: photos
      const weiboRequestUrl = `https://m.weibo.cn/api/container/getIndex?containerid=230413${account.weiboId}_-_WEIBO_SECOND_PROFILE_WEIBO`;
      account.weiboId && argv.verbose && log(`weibo requesting ${weiboRequestUrl}`);
      account.weiboId && await got(weiboRequestUrl, weiboRequestOptions).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.ok === 1) {
          const currentTime = Date.now();
          const data = json.data;
          // Weibo now should always returns a single card with card_type: 58 if there's no any public activity
          const cards = data?.cards;

          // Normalize statues from API. The first activity is wrapped inside `card_group`, we should pop it out
          const statuses = cards.map(obj => {
            if (obj.hasOwnProperty('card_group')) {
              return obj.card_group[0];
            } else {
              return obj;
            }
          }).filter(card => {
            // Filter out unrelated cards to only keep statuses
            // card_type: 9 - normal Weibo statuses
            // card_type: 11 with title: "全部微博*" - the first Weibo status
            if (card?.card_type === 9) {
              return true;
            } else if (card?.card_type === 11 && card?.title && card?.title.includes('全部微博')) {
              return true;
            } else {
              return false;
            }
          });

          if (statuses.length > 0) {
            // At this point, we can get Weibo profile data from the statuses
            // This reduces one API request and can be helpful with rate limit
            // at better scale
            const user = statuses[0].mblog.user;

            // If user nickname update
            if (user.screen_name !== dbScope?.weibo?.user?.screen_name && dbScope?.weibo?.user?.screen_name) {
              log(`weibo user nickname updated: ${user.screen_name}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#微博昵称更新\n新：${user.screen_name}\n旧：${dbScope?.weibo?.user?.screen_name}`
                    + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                }).then(resp => {
                  // log(`telegram post weibo::nickname success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post weibo::nickname error: ${e}`, e);
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
                .catch(e => {
                  err(`go-qchttp post weibo::nickname error: ${e?.response?.body || e}`, e);
                });
              }
            }

            // If user description update
            if (user.description !== dbScope?.weibo?.user?.description && dbScope?.weibo?.user?.description) {
              log(`weibo user sign updated: ${user.description}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#微博签名更新\n新：${user.description}\n旧：${dbScope?.weibo?.user?.description}`
                    + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                }).then(resp => {
                  // log(`telegram post weibo::sign success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post weibo::sign error: ${e}`, e);
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
                .catch(e => {
                  err(`go-qchttp post weibo::sign error: ${e?.response?.body || e}`, e);
                });
              }
            }

            // If user verified_reason update
            if (user?.verified_reason !== dbScope?.weibo?.user?.verified_reason && dbScope?.weibo?.user) {
              log(`weibo user verified_reason updated: ${user.verified_reason}`);

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#微博认证更新\n新：${user?.verified_reason || '无认证'}`
                    + `\n旧：${dbScope?.weibo?.user?.verified_reason || '无认证'}`
                    + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                }).then(resp => {
                  // log(`telegram post weibo::verified_reason success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post weibo::verified_reason error: ${e}`, e);
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
                .catch(e => {
                  err(`go-qchttp post weibo::verified_reason error: ${e?.response?.body || e}`, e);
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
            //     .catch(e => {
            //       err(`telegram post weibo::follow_count error: ${e}`, e);
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
            //   //   .catch(e => {
            //   //     err(`go-qchttp post weibo::follow_count error: ${e?.response?.body || e}`, e);
            //   //   });
            //   // }
            // }

            // If user avatar update
            if (user.avatar_hd !== dbScope?.weibo?.user?.avatar_hd && dbScope?.weibo?.user?.avatar_hd) {
              log(`weibo user avatar updated: ${user.avatar_hd}`);

              if (account.tgChannelId && config.telegram.enabled) {
                const photoExt = user.avatar_hd.split('.').pop();
                const tgForm = new FormData();
                const avatarImage = await readProcessedMedia(`${user.avatar_hd}`);
                tgForm.append('chat_id', account.tgChannelId);
                tgForm.append('parse_mode', 'HTML');
                tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', avatarImage, photoExt === 'gif' && 'image.gif');
                tgForm.append('caption', `${msgPrefix}#微博头像更新，旧头像：${dbScope?.weibo?.user?.avatar_hd}`
                  + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                );

                await sendTelegram({
                  method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                  payload: 'form',
                }, tgForm).then(resp => {
                  // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post weibo::avatar error: ${e}`, e);
                });

                if (account.tgChannelAvatarSource && account.tgChannelAvatarSource.includes('weibo')) {
                  log(`telegram avatar update enabled from weibo: ${user.avatar_hd}`);

                  const tgAvatarForm = new FormData();
                  tgAvatarForm.append('chat_id', account.tgChannelId);
                  tgAvatarForm.append('photo', avatarImage);

                  await sendTelegram({
                    method: 'setChatPhoto',
                    payload: 'form',
                  }, tgAvatarForm).then(resp => {
                    // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                  })
                  .catch(e => {
                    err(`telegram post weibo::avatar error: ${e}`, e);
                  });
                }
              }

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#微博头像更新\n新头像：[CQ:image,file=${user.avatar_hd}]\n旧头像：[CQ:image,file=${dbScope?.weibo?.user?.avatar_hd}]`,
                }).then(resp => {
                  // log(`go-qchttp post weibo success: ${resp}`);
                })
                .catch(e => {
                  err(`go-qchttp post weibo::avatar error: ${e?.response?.body || e}`, e);
                });
              }
            }

            // If user cover background update
            if (user.cover_image_phone !== dbScope?.weibo?.user?.cover_image_phone && dbScope?.weibo?.user?.cover_image_phone) {
              log(`weibo user cover updated: ${user.cover_image_phone}`);

              if (account.tgChannelId && config.telegram.enabled) {
                const photoExt = convertWeiboUrl(user.cover_image_phone).split('.').pop();
                const tgForm = new FormData();
                const coverImage = await readProcessedMedia(`${convertWeiboUrl(user.cover_image_phone)}`);
                tgForm.append('chat_id', account.tgChannelId);
                tgForm.append('parse_mode', 'HTML');
                tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', coverImage, photoExt === 'gif' && 'image.gif');
                tgForm.append('caption', `${msgPrefix}#微博封面更新，旧封面：${convertWeiboUrl(dbScope?.weibo?.user?.cover_image_phone)}`
                  + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                );

                await sendTelegram({
                  method: 'sendPhoto',
                  payload: 'form'
                }, tgForm).then(resp => {
                  // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post weibo::avatar error: ${e}`, e);
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
                .catch(e => {
                  err(`go-qchttp post weibo::avatar error: ${e?.response?.body || e}`, e);
                });
              }
            }

            // Creating Telegram cache set from database. This ensure no duplicated notifications will be sent
            const tgCacheSet = new Set(Array.isArray(dbScope?.weibo?.tgCache) ? dbScope.weibo.tgCache.reverse().slice(0, 30).reverse() : []);
            const tgCommentsCacheSet = new Set(Array.isArray(dbScope?.weibo?.tgCommentsCache) ? dbScope.weibo.tgCommentsCache.reverse().slice(0, 300).reverse() : []);

            // Start storing time-sensitive data after checking user info changes
            const dbStore = {
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
              user: user,
            };

            // Morph data for database schema
            const activities = statuses.map(obj => {
              return {
                ...obj.mblog,
                created_at_unix: +new Date(obj.mblog.created_at)
              }
              // Sort array by date in ascending order (reversed). This will make the sticky status in its right order
            }).sort((a, b) => a.created_at_unix - b.created_at_unix);

            // console.log(`activities`, activities);

            const dbScopeTimestampUnix = dbScope?.weibo?.latestStatus?.timestampUnix;

            argv.json && fs.writeFile(`db/${account.slug}-weibo.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            // Loop array
            for (let [idx, activity] of activities.entries()) {
              const retweetedStatus = activity?.retweeted_status;

              const timestamp = +new Date(activity.created_at);
              const id = activity.bid;
              const commentsId = activity.id;
              const visibility = activity?.visible?.type;
              const editCount = activity?.edit_count || 0;
              const idxLatest = activities.length - 1;
              let text = activity?.raw_text || stripHtml(activity.text);

              // If last (the last one in the array is the latest now) item
              if (idx === idxLatest) {
                dbStore.latestStatus = {
                  id: id,
                  commentsId: commentsId,
                  text: text,
                  visibility: visibility,
                  editCount: editCount,
                  timestamp: new Date(timestamp),
                  timestampUnix: timestamp,
                  timeAgo: timeAgo(timestamp),
                }
              };

              if (!dbScopeTimestampUnix) {
                log(`weibo initial run, notifications skipped`);
              } else if (timestamp === dbScopeTimestampUnix) {
                log(`weibo no update. latest: ${dbScope?.weibo?.latestStatus?.id} (${timeAgo(dbScope?.weibo?.latestStatus?.timestamp)})`);

                if (account.weiboFetchComments) {
                  const weiboCommentsRequestUrl = `https://m.weibo.cn/comments/hotflow?id=${commentsId}&mid=${commentsId}&max_id_type=0`;
                  log(`weibo fetching comments from ${commentsId} for activity ${id}...`)
                  argv.verbose && log(`weibo comments requesting ${weiboCommentsRequestUrl}`);
                  await got(weiboCommentsRequestUrl, weiboRequestOptions).then(async resp => {
                    const json = JSON.parse(resp.body);

                    if (json?.ok === 1 && Array.isArray(json.data.data) && json.data.data.length > 0) {
                      const comments = json.data.data;

                      for (const [idx, comment] of comments.entries()) {

                        if (comment?.user?.id === +account.weiboId && !tgCommentsCacheSet.has(comment.bid)) {
                          log(`weibo author comment detected ${comment.bid} for activity ${id}...`)

                          if (account.tgChannelId && config.telegram.enabled) {

                            await sendTelegram({ method: 'sendMessage' }, {
                              chat_id: account.tgChannelId,
                              parse_mode: 'HTML',
                              disable_web_page_preview: true,
                              disable_notification: true,
                              allow_sending_without_reply: true,
                              text: `${msgPrefix}#微博新评论：${stripHtml(comment?.text) || '未知内容'}`
                                + `\n\n被评论的微博：${text || '未知内容'}`
                                + `\n\n<a href="https://weibo.com/${user.id}/${id}">${timeAgo(+new Date(comment.created_at), 'zh_cn')}</a>`
                                + ` | <a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                            }).then(resp => {
                              log(`telegram post weibo::author_comment success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                              tgCommentsCacheSet.add(comment.bid);
                            })
                            .catch(e => {
                              err(`telegram post weibo::author_comment error: ${e}`, e);
                            });
                          }
                        }

                        // Check replies inside comments
                        if (Array.isArray(comment.comments) && comment.comments.length > 0) {
                          const replies = comment.comments;

                          for (const [idx, reply] of replies.entries()) {

                            if (reply?.user?.id === +account.weiboId && !tgCommentsCacheSet.has(reply.bid)) {
                              log(`weibo author comment reply detected ${reply.bid} in comment ${comment.bid} for activity ${id}...`)

                              if (account.tgChannelId && config.telegram.enabled) {

                                await sendTelegram({ method: 'sendMessage' }, {
                                  chat_id: account.tgChannelId,
                                  parse_mode: 'HTML',
                                  disable_web_page_preview: true,
                                  disable_notification: true,
                                  allow_sending_without_reply: true,
                                  text: `${msgPrefix}#微博新评论回复：${stripHtml(reply?.text) || '未知内容'}`
                                    + `\n\n被回复的评论：@<a href="${comment?.user?.profile_url}">${comment?.user?.screen_name || '未知用户名'}</a>: ${stripHtml(comment?.text) || '未知内容'}`
                                    + `\n\n<a href="https://weibo.com/${user.id}/${id}">${timeAgo(+new Date(reply.created_at), 'zh_cn')}</a>`
                                    + ` | <a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                                }).then(resp => {
                                  log(`telegram post weibo::author_comment_reply success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                                  tgCommentsCacheSet.add(reply.bid);
                                })
                                .catch(e => {
                                  err(`telegram post weibo::author_comment_reply error: ${e}`, e);
                                });
                              }
                            }
                          }
                        } else {
                          argv.verbose && log(`weibo comment ${comment.bid} has no reply, skipped`);
                        }
                      }
                    } else {
                      log('weibo comments corrupted, skipped');
                    }
                  }).catch(e => {
                    err(`weibo comments request error: ${e}`, e);
                  });
                }
              } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                log(`weibo new post older than database. latest: ${id} (${timeAgo(timestamp)})`);
                // NOTE: Disable deleted weibo detection when API is unstable
                // if (account.tgChannelId && config.telegram.enabled) {
                //   await sendTelegram({ method: 'sendMessage' }, {
                //     chat_id: account.tgChannelId,
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
                //     argv.verbose && log(`telegram post weibo success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                //   })
                //   .catch(e => {
                //     err(`telegram post weibo error: ${e?.response?.body || e}`, e);
                //   });
                // }
              } else if (idx === idxLatest && (currentTime - timestamp) >= config.weiboBotThrottle) {
                log(`weibo latest status ${id} (${timeAgo(timestamp)}) older than 'weiboBotThrottle', skipping...`);
              } else if (timestamp < dbScopeTimestampUnix) {
                argv.verbose && log(`weibo got old activity: ${id} (${timeAgo(timestamp)}), discarding...`);
              } else {
                log(`weibo got update: ${id} (${timeAgo(timestamp)})`);

                if (activity?.isLongText) {
                  log('weibo got post too long, trying extended text...')
                  const weiboLongPostRequestUrl = `https://m.weibo.cn/statuses/extend?id=${id}`;
                  argv.verbose && log(`weibo long post requesting ${weiboLongPostRequestUrl}`);
                  await got(weiboLongPostRequestUrl, weiboRequestOptions).then(resp => {
                    const json = JSON.parse(resp.body);

                    if (json?.ok === 1 && json?.data?.longTextContent) {
                      text = stripHtml(json.data.longTextContent);
                    } else {
                      log('weibo extended info corrupted, using original text...');
                    }
                  }).catch(e => {
                    err(`weibo extended text request error: ${e}`, e);
                  });
                }

                // If the status has additional geolocation info
                if (activity?.page_info?.type === 'place') {
                  text += `\n\n坐标：${activity.page_info.page_title}（${activity.page_info.content1}）`;
                }

                // If the status has forced geo region string
                // input: 发布于 上海
                if (activity?.region_name) {
                  text += `\n\n${activity.region_name}`;
                }

                // If the status has custom sending source
                if (activity?.source) {
                  text += activity?.region_name ? `，来自 ${activity.source}` : `\n\n来自 ${activity.source}`;
                }

                const visibilityMap = {
                  1: `自己可见`,
                  6: `好友圈可见`,
                  10: `粉丝可见`
                }

                const tgOptions = {
                  method: 'sendMessage',
                };

                const tgOptionsAlt = {
                  method: 'sendMessage',
                };

                const tgBodyFooter = `\n\n<a href="https://weibo.com/${user.id}/${id}">${timeAgo(timestamp, 'zh_cn')}</a>`
                  // Check if retweeted user is visible
                  // `user: null` will be returned if text: "抱歉，作者已设置仅展示半年内微博，此微博已不可见。 "
                  + `${retweetedStatus && retweetedStatus?.user ? ` | <a href="https://weibo.com/${retweetedStatus.user.id}/${retweetedStatus.bid}">查看被转发微博</a>` : ''}`
                  + ` | <a href="https://weibo.com/${user.id}">${user.screen_name}</a>`;

                const tgBody = {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#微博${visibilityMap[visibility] || ''}${retweetedStatus ? `转发` : `动态`}：${text}`
                    + `${retweetedStatus ? `\n\n被转作者：${retweetedStatus?.user ? '@' + retweetedStatus.user.screen_name : '未知'}\n被转内容：${stripHtml(retweetedStatus.text)}` : ''}`
                    + `${tgBodyFooter}`
                };

                const qgBody = {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${msgPrefix}#微博${visibilityMap[visibility] || ''}${retweetedStatus ? `转发` : `动态`}：${text}${retweetedStatus ? `\n\n被转作者：${retweetedStatus?.user ? '@' + retweetedStatus.user.screen_name : '未知'}\n被转内容：${stripHtml(retweetedStatus.text)}` : ''}`,
                };

                const tgBodyAlt = {
                  chat_id: account.tgChannelId,
                };

                const tgForm = new FormData();
                tgForm.append('chat_id', account.tgChannelId);
                tgForm.append('parse_mode', 'HTML');

                // If post has photo
                if (activity.pic_ids?.length > 0) {
                  const photoCount = activity.pic_ids.length;
                  const photoCountText = photoCount > 1 ? `（共 ${photoCount} 张）` : ``;
                  const photoExt = activity.pics[0].large.url.split('.').pop();
                  tgOptions.method = photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto';
                  tgOptions.payload = 'form';
                  // tgForm.append('photo', await readProcessedMedia(`https://ww1.sinaimg.cn/large/${activity.pic_ids[0]}.jpg`));
                  tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedMedia(`${activity.pics[0].large.url}`), photoExt === 'gif' && 'image.gif');
                  tgForm.append('caption', `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}${tgBodyFooter}`);
                  qgBody.message = `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}\n地址：https://weibo.com/${user.id}/${id}\n${activity.pics.map(item => generateCqCode(item.large.url))}`;

                  // NOTE: Method to send multiple photos in one sendMediaGroup
                  // Pros: efficient, no need to download each photo
                  // Cons: message send will fail if any photo fails to fetch fron Telegram servers
                  // if (activity.pic_ids?.length > 1) {
                  //   tgOptionsAlt.method = 'sendMediaGroup';
                  //   const acceptedPhotos = activity.pic_ids.slice(0, 9);
                  //   tgBodyAlt.media = acceptedPhotos.map((pic, idx) => ({
                  //     type: 'photo',
                  //     // Limit image size with original server and webp: failed (Bad Request: group send failed)
                  //     // media: pic.img_width > 1036 || pic.img_height > 1036 ? `${pic.img_src}@1036w.webp` : `${pic.img_src}`,

                  //     // Use wp.com proxy to serve image: failed (Bad Request: group send failed)
                  //     // media: `https://i0.wp.com/${pic.img_src.replace('https://').replace('http://')}?w=200`,

                  //     // Use my own proxy and webp prefix from bilibili: sucess
                  //     media: `https://experiments.sparanoid.net/imageproxy/1000x1000,fit,jpeg/${activity.pics[idx].large.url}`,
                  //   }));

                  //   // Only apply caption to the first image to make it auto shown on message list
                  //   tgBodyAlt.media[0].caption = `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText} #多图相册：${text}`;
                  // }
                }

                // If post has video
                if (activity?.page_info?.type === 'video') {
                  tgOptions.method = 'sendVideo';
                  tgBody.video = activity?.page_info?.media_info?.stream_url_hd || activity?.page_info?.media_info?.stream_url;
                  tgBody.caption = `${msgPrefix}#微博${visibilityMap[visibility] || ''}视频：${text}${tgBodyFooter}`;
                  qgBody.message = `${msgPrefix}#微博${visibilityMap[visibility] || ''}视频：${text}\n地址：https://weibo.com/${user.id}/${id}`;
                }

                // TODO: parse 4k
                // https://f.video.weibocdn.com/qpH0Ozj9lx07NO9oXw4E0104120qrc250E0a0.mp4?label=mp4_2160p60&template=4096x1890.20.0&trans_finger=aaa6a0a6b46c000323ae75fc96245471&media_id=4653054126129212&tp=8x8A3El:YTkl0eM8&us=0&ori=1&bf=3&ot=h&ps=3lckmu&uid=7vYqTU&ab=3915-g1,5178-g1,966-g1,1493-g0,1192-g0,1191-g0,1258-g0&Expires=1627682219&ssig=I7RDiLeNCQ&KID=unistore,video

                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, qgBody).then(resp => {
                    // log(`go-qchttp post weibo success: ${resp}`);
                  })
                  .catch(e => {
                    err(`go-qchttp post weibo error: ${e?.response?.body || e}`, e);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled && !tgCacheSet.has(id)) {

                  await sendTelegram(tgOptions, tgOptions?.payload === 'form' ? tgForm : tgBody).then(resp => {
                    argv.verbose && log(`telegram post weibo success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                    tgCacheSet.add(id);
                  })
                  .catch(async e => {
                    err(`telegram post weibo error: ${e?.response?.body || e}`, e);

                    // If post failed with video type, try to send it again
                    if (activity?.page_info?.type === 'video') {
                      log(`telegram post weibo retry posting via plain text`);

                      await sendTelegram({
                        method: 'sendMessage',
                      }, tgBody)
                      .then(resp => {
                        argv.verbose && log(`telegram post weibo retry success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                        tgCacheSet.add(id);
                      })
                      .catch(e => {
                        err(`telegram post weibo retry error: ${e?.response?.body || e}`, e);
                      });
                    }
                  });

                  // Send an additional message if original post has more than one photo
                  if (activity.pic_ids?.length > 1) {

                    for (const [idx, pic] of activity.pic_ids.entries()) {

                      if (idx !== 0) {
                        const photoCount = activity.pic_ids.length;
                        const photoCountText = photoCount > 1 ? `（${idx + 1}/${photoCount}）` : ``;
                        const photoExt = activity.pics[idx].large.url.split('.').pop();

                        const tgForm = new FormData();
                        tgForm.append('chat_id', account.tgChannelId);
                        tgForm.append('parse_mode', 'HTML');
                        tgForm.append('disable_notification', true);
                        tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedMedia(`${activity.pics[idx].large.url}`), photoExt === 'gif' && 'image.gif');
                        tgForm.append('caption', `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}${tgBodyFooter}`);

                        await sendTelegram({
                          method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                          payload: 'form',
                        }, tgForm).then(resp => {
                          log(`telegram post weibo (batch #${idx + 1}) success`)
                        })
                        .catch(e => {
                          err(`telegram post weibo (batch #${idx + 1}) error: ${e?.response?.body || e}`, e);
                        });
                      }
                    }
                  }
                }
              }
            };

            // Set new data to database
            dbStore.tgCache = [...tgCacheSet];
            dbStore.tgCommentsCache = [...tgCommentsCacheSet];
            dbScope['weibo'] = dbStore;
          } else {
            log('weibo empty result, skipping...');
          }
        } else {
          log('weibo info corrupted, skipping...');
        }
      })
      .catch(e => {
        err(`weibo request error: ${e}`, e);
      });

      // Fetch bilibili following
      const bilibiliFollowingRequestUrl = `https://api.bilibili.com/x/relation/followings?vmid=${account.biliId}&pn=1&ps=50&order=desc`;
      account.bilibiliFetchFollowing && account.biliId && argv.verbose && log(`bilibili-following requesting ${bilibiliFollowingRequestUrl}`);
      account.bilibiliFetchFollowing && account.biliId && await got(bilibiliFollowingRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 0) {
          const currentTime = Date.now();
          const data = json.data.list;

          if (data.length > 0) {
            // Creating Telegram cache set from database. This ensure no duplicated notifications will be sent
            const tgCacheSet = new Set(Array.isArray(dbScope?.bilibili_following?.tgCache) ? dbScope.bilibili_following.tgCache.reverse().slice(0, 30).reverse() : []);

            const dbStore = {
              followingPermission: 'PUBLIC',
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
            };

            const tgOptions = {
              method: 'sendMessage',
            };

            // Morph data for database schema
            const activities = data.map(obj => {
              return {
                ...obj,
                created_at_unix: +new Date(obj.mtime * 1000)
              }
              // Sort array by date in ascending order (reversed).
            }).sort((a, b) => a.created_at_unix - b.created_at_unix);

            const dbScopeTimestampUnix = dbScope?.bilibili_following?.latestActivity?.timestampUnix;

            argv.json && fs.writeFile(`db/${account.slug}-bilibili_following.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            // Loop array reversed to send the latest activity last
            for (let [idx, activity] of activities.entries()) {
              const timestamp = +new Date(activity.mtime * 1000);
              const uid = activity.mid;
              const name = activity.uname || '未知用户名';
              const sign = activity.sign;
              const avatar = activity.face;
              const officialVerify = activity?.official_verify?.desc;
              const idxLatest = activities.length - 1;

              let tgBodyMergedFooter = `\n\n<a href="https://space.bilibili.com/${account.biliId}/fans/follow">${timeAgo(timestamp, 'zh_cn')}</a>`
                + ` | <a href="https://space.bilibili.com/${account.biliId}">${account.slug}</a>`
                + ` | <a href="https://space.bilibili.com/${uid}">${name}</a>`;

              // If last (the last one in the array is the latest now) item
              if (idx === idxLatest) {
                dbStore.latestActivity = {
                  uid: uid,
                  name: name,
                  sign: sign,
                  avatar: avatar,
                  officialVerify: officialVerify,
                  timestamp: new Date(timestamp),
                  timestampUnix: timestamp,
                  timeAgo: timeAgo(timestamp),
                }
              };

              if (!dbScopeTimestampUnix) {
                log(`bilibili-following initial run, notifications skipped`);
              } else if (timestamp === dbScopeTimestampUnix) {
                log(`bilibili-following no update. latest: ${dbScope?.bilibili_following?.latestActivity?.uid} (${timeAgo(dbScope?.bilibili_following?.latestActivity?.timestamp)})`);
              } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                log(`bilibili-following new activity older than database. latest: ${uid} (${timeAgo(timestamp)})`);
              } else if (idx === idxLatest && (currentTime - timestamp) >= config.bilibiliFollowingBotThrottle) {
                log(`bilibili-following latest status ${uid} (${timeAgo(timestamp)}) older than 'bilibiliFollowingBotThrottle', skipping...`);
              } else if (timestamp < dbScopeTimestampUnix) {
                argv.verbose && log(`bilibili-following got old activity: ${uid} (${timeAgo(timestamp)}), discarding...`);
              } else if (tgCacheSet.has(uid)) {
                log(`bilibili-following latest status ${uid} (${timeAgo(timestamp)}) already in cache, skipping...`);
              } else {
                log(`bilibili-following got update: ${uid}: ${name} (${timeAgo(timestamp)})`);
                // mergedContent.push(`${timeAgo(timestamp, 'zh_cn')} ${uid}`);

                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, {
                    guild_id: account.qGuildId,
                    channel_id: account.qGuildChannelId,
                    message: `${msgPrefix}#b站新增关注 ${name}`
                      + `${sign ? `\n签名：${sign}` : ''}`
                      + `${officialVerify ? `\n认证：${officialVerify}` : ''}`
                      + `${tgBodyMergedFooter}`,
                  }).then(resp => {
                    // log(`go-qchttp post bilibili-following success: ${resp}`);
                  })
                  .catch(e => {
                    err(`go-qchttp post bilibili-following error: ${e?.response?.body || e}`, e);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled && !tgCacheSet.has(uid)) {
                  const photoExt = avatar.split('.').pop();
                  const tgForm = new FormData();
                  const avatarImage = await readProcessedMedia(`${avatar}`);
                  tgForm.append('chat_id', account.tgChannelId);
                  tgForm.append('parse_mode', 'HTML');
                  tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', avatarImage, photoExt === 'gif' && 'image.gif');
                  tgForm.append('caption', `${msgPrefix}#b站新增关注 ${name}`
                    + `${sign ? `\n签名：${sign}` : ''}`
                    + `${officialVerify ? `\n认证：${officialVerify}` : ''}`
                    + `${tgBodyMergedFooter}`);

                  await sendTelegram({
                    method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                    payload: 'form',
                  }, tgForm).then(resp => {
                    argv.verbose && log(`telegram post bilibili-following success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                    tgCacheSet.add(uid);
                  })
                  .catch(e => {
                    err(`telegram post bilibili-following error: ${e?.response?.body || e}`, e);
                  });
                }
              }
            };

            // Set new data to database
            dbStore.tgCache = [...tgCacheSet];
            dbScope['bilibili_following'] = dbStore;
          } else {
            log('bilibili-following empty result, skipping...');
          }
        } else {
          log('bilibili-following info corrupted, skipping...');
        }
      })
      .catch(e => {
        err(`bilibili-following request error: ${e}`, e);
      });

      // Fetch DDStats
      const ddstatsRequestUrl = `https://ddstats-api.ericlamm.xyz/records/${account.biliId}?limit=15&type=dd`;
      !account.disableDdstats && account.biliId && argv.verbose && log(`ddstats requesting ${ddstatsRequestUrl}`);
      !account.disableDdstats && account.biliId && await got(ddstatsRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 200) {
          const currentTime = Date.now();
          const data = json.data;

          if (data.length > 0) {
            const dbStore = {
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
            };

            const tgOptions = {
              method: 'sendMessage',
            };

            // Prepared merged content for sending multiple activities in one notification to avoid spamming
            const mergedContent = [];

            let tgBodyMergedFooter = `\n\n<a href="https://ddstats.ericlamm.xyz/user/${account.biliId}">DDStats</a>`;

            // Morph data for database schema
            const activities = data.map(obj => {
              return {
                ...obj,
                created_at_unix: +new Date(obj.created_at)
              }
              // Sort array by date in ascending order (reversed).
            }).sort((a, b) => a.created_at_unix - b.created_at_unix);

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
            for (let [idx, activity] of activities.entries()) {
              const timestamp = +new Date(activity.created_at);
              const id = activity.id;
              const type = activity.command || 'UNKNOWN';
              const contentImage = activity?.image?.Valid ? activity.image.String : '';
              const content = `${activity.display} ${contentImage}`;
              const parsedContent = parseDdstatsString(content, type);
              const idxLatest = activities.length - 1;

              // If last (the last one in the array is the latest now) item
              if (idx === idxLatest) {
                dbStore.latestActivity = {
                  id: id,
                  type: type,
                  content: content,
                  timestamp: new Date(timestamp),
                  timestampUnix: timestamp,
                  timeAgo: timeAgo(timestamp),
                }

                // Update global footer from the first item
                tgBodyMergedFooter += ` | <a href="https://space.bilibili.com/${account.biliId}">${parsedContent?.user || '查看用户'}</a>`;
              };

              const targetUserHtml = `<a href="https://space.bilibili.com/${activity?.target_uid}">${parsedContent?.target || '目标用户'}</a>`

              const contentHtml = content
                .replace(parsedContent?.target || '未知目标', targetUserHtml)
                .replace(parsedContent?.user || '未知用户', `#${account.slug}`);

              if (!dbScopeTimestampUnix) {
                log(`ddstats initial run, notifications skipped`);
              } else if (timestamp === dbScopeTimestampUnix) {
                log(`ddstats no update. latest: ${dbScope?.ddstats?.latestActivity?.id} (${timeAgo(dbScope?.ddstats?.latestActivity?.timestamp)})`);
              } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                log(`ddstats new activity older than database. latest: ${id} (${timeAgo(timestamp)})`);
              } else if (idx === idxLatest && (currentTime - timestamp) >= config.ddstatsBotThrottle) {
                log(`ddstats latest status ${id} (${timeAgo(timestamp)}) older than 'ddstatsBotThrottle', skipping...`);
              } else if (timestamp < dbScopeTimestampUnix) {
                argv.verbose && log(`ddstats got old activity: ${id} (${timeAgo(timestamp)}), discarding...`);
              } else {
                log(`ddstats got update: ${id}: ${content} (${timeAgo(timestamp)})`);
                mergedContent.push(`${timeAgo(timestamp, 'zh_cn')} ${contentHtml}`);
              }
            };

            if (mergedContent.length > 0) {

              if (account.qGuildId && config.qGuild.enabled) {

                await sendQGuild({method: 'send_guild_channel_msg'}, {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${mergedContent.join('\n\n')}${tgBodyMergedFooter}`,
                }).then(resp => {
                  // log(`go-qchttp post ddstats success: ${resp}`);
                })
                .catch(e => {
                  err(`go-qchttp post ddstats error: ${e?.response?.body || e}`, e);
                });
              }

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram(tgOptions, {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  disable_notification: true,
                  text: `${mergedContent.join('\n\n')}${tgBodyMergedFooter}`,
                }).then(resp => {
                  // log(`telegram post ddstats success: message_id ${resp.result.message_id}`)
                })
                .catch(e => {
                  err(`telegram post ddstats error: ${e?.response?.body || e}`, e);
                });
              }
            }

            // Set new data to database
            dbScope['ddstats'] = dbStore;
          } else {
            log('ddstats empty result, skipping...');
          }
        } else {
          log('ddstats info corrupted, skipping...');
        }
      })
      .catch(e => {
        err(`ddstats request error: ${e}`, e);
      });

      // Fetch Tape Chat
      const tapechatRequestUrl = `https://apiv4.tapechat.net/unuser/getQuestionFromUser/${account.tapechatId}?pageSize=20`;
      account.tapechatId && argv.verbose && log(`tapechat requesting ${tapechatRequestUrl}`);
      account.tapechatId && await got(tapechatRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.code === 200) {
          const currentTime = Date.now();
          const data = json.content.data;

          if (data.length > 0) {
            const dbStore = {
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
            };

            // Morph data for database schema
            const activities = data.map(obj => {
              return {
                ...obj,
                created_at_unix: +new Date(obj.answerAt * 1000)
              }
              // Sort array by date in ascending order (reversed).
            }).sort((a, b) => a.created_at_unix - b.created_at_unix);

            const dbScopeTimestampUnix = dbScope?.tapechat?.latestActivity?.timestampUnix;

            argv.json && fs.writeFile(`db/${account.slug}-tapechat.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            // Loop array reversed to send the latest activity last
            for (let [idx, activity] of activities.entries()) {
              const timestamp = +new Date(activity.answerAt * 1000);
              const id = activity.visitCode;
              const content = `${msgPrefix}#提问箱回答 ${activity.title}`
                + `\n\n回答：${activity.answer.txtContent}`
                + `${activity.answer?.imgList?.length ? `\n附图：${activity.answer.imgList.join(' ')}` : ''}`
                + `${activity.answer?.linkCard ? `\n链接：<a href="${activity.answer.linkCard.originalUrl}">${activity.answer.linkCard.title}</a>` : ''}`;
              const idxLatest = activities.length - 1;

              // If last (the last one in the array is the latest now) item
              if (idx === idxLatest) {
                dbStore.latestActivity = {
                  id: id,
                  // Avoid storing content, take too much space
                  // content: content,
                  timestamp: new Date(timestamp),
                  timestampUnix: timestamp,
                  timeAgo: timeAgo(timestamp),
                }
              };

              const tgOptions = {
                method: 'sendMessage',
              };

              const tgBodyFooter = `\n\n<a href="https://www.tapechat.net/answeredDetail.html?dynamicId=${id}">${timeAgo(timestamp, 'zh_cn')}</a>`;

              const tgBody = {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${content}${tgBodyFooter}`,
              };

              const qgBody = {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${content}${tgBodyFooter}`,
              };

              if (!dbScopeTimestampUnix) {
                log(`tapechat initial run, notifications skipped`);
              } else if (timestamp === dbScopeTimestampUnix) {
                log(`tapechat no update. latest: ${dbScope?.tapechat?.latestActivity?.id} (${timeAgo(dbScope?.tapechat?.latestActivity?.timestamp)})`);
              } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                log(`tapechat new activity older than database. latest: ${id} (${timeAgo(timestamp)})`);
              } else if (idx === idxLatest && (currentTime - timestamp) >= config.tapechatBotThrottle) {
                log(`tapechat latest status ${id} (${timeAgo(timestamp)}) older than 'tapechatBotThrottle', skipping...`);
              } else if (timestamp < dbScopeTimestampUnix) {
                argv.verbose && log(`tapechat got old activity: ${id} (${timeAgo(timestamp)}), discarding...`);
              } else {
                log(`tapechat got update: ${id}: ${content} (${timeAgo(timestamp)})`);

                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, qgBody).then(resp => {
                    // log(`go-qchttp post tapechat success: ${resp}`);
                  })
                  .catch(e => {
                    err(`go-qchttp post tapechat error: ${e?.response?.body || e}`, e);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled) {

                  await sendTelegram(tgOptions, tgBody).then(resp => {
                    // log(`telegram post tapechat success: message_id ${resp.result.message_id}`)
                  })
                  .catch(e => {
                    err(`telegram post tapechat error: ${e?.response?.body || e}`, e);
                  });
                }
              }
            };

            // Set new data to database
            dbScope['tapechat'] = dbStore;
          } else {
            log('tapechat empty result, skipping...');
          }
        } else {
          log('tapechat info corrupted, skipping...');
        }
      })
      .catch(e => {
        err(`tapechat request error: ${e}`, e);
      });

      // Fetch Aifadian (afdian)
      const afdianRequestUrl = `https://afdian.net/api/post/get-list?user_id=${account.afdianId}&type=old&publish_sn=&per_page=10&group_id=&all=1&is_public=&plan_id=`;
      account.afdianId && argv.verbose && log(`afdian requesting ${afdianRequestUrl}`);
      account.afdianId && await got(afdianRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
        const json = JSON.parse(resp.body);

        if (json?.ec === 200) {
          const currentTime = Date.now();
          const data = json.data.list;

          if (data.length > 0) {
            const dbStore = {
              scrapedTime: new Date(currentTime),
              scrapedTimeUnix: +new Date(currentTime),
            };

            // Morph data for database schema
            const activities = data.map(obj => {
              return {
                ...obj,
                created_at_unix: +new Date(obj.publish_time * 1000)
              }
              // Sort array by date in ascending order (reversed).
            }).sort((a, b) => a.created_at_unix - b.created_at_unix);

            const dbScopeTimestampUnix = dbScope?.afdian?.latestActivity?.timestampUnix;

            argv.json && fs.writeFile(`db/${account.slug}-afdian.json`, JSON.stringify(json, null, 2), err => {
              if (err) return console.log(err);
            });

            // Loop array reversed to send the latest activity last
            for (let [idx, activity] of activities.entries()) {
              const timestamp = +new Date(activity.publish_time * 1000);
              const id = activity.post_id;
              const content = `${msgPrefix}#爱发电动态 ${activity.title}`
                + `${activity?.content ? `\n\n${activity.content}` : `未知内容`}`;
                // + `${activity.answer?.imgList?.length ? `\n附图：${activity.answer.imgList.join(' ')}` : ''}`
                // + `${activity.answer?.linkCard ? `\n链接：<a href="${activity.answer.linkCard.originalUrl}">${activity.answer.linkCard.title}</a>` : ''}`;
              const image = activity?.cover || Array.isArray(activity?.pics) && activity?.pics[0] || activity?.audio_thumb;
              const idxLatest = activities.length - 1;

              // If last (the last one in the array is the latest now) item
              if (idx === idxLatest) {
                dbStore.latestActivity = {
                  id: id,
                  // Avoid storing content, take too much space
                  // content: content,
                  timestamp: new Date(timestamp),
                  timestampUnix: timestamp,
                  timeAgo: timeAgo(timestamp),
                }
              };

              const tgOptions = {
                method: 'sendMessage',
              };

              const tgBodyFooter = `\n\n<a href="https://afdian.net/p/${id}">${timeAgo(timestamp, 'zh_cn')}</a>`
                + ` | <a href="https://afdian.net/u/${activity?.user?.user_id || account.afdianId}">${activity?.user?.name || '未知创作者'}</a>`;

              const tgBody = {
                chat_id: account.tgChannelId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${content}${tgBodyFooter}`,
              };

              const qgBody = {
                guild_id: account.qGuildId,
                channel_id: account.qGuildChannelId,
                message: `${content}${tgBodyFooter}`,
              };

              if (!dbScopeTimestampUnix) {
                log(`afdian initial run, notifications skipped`);
              } else if (timestamp === dbScopeTimestampUnix) {
                log(`afdian no update. latest: ${dbScope?.afdian?.latestActivity?.id} (${timeAgo(dbScope?.afdian?.latestActivity?.timestamp)})`);
              } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                log(`afdian new activity older than database. latest: ${id} (${timeAgo(timestamp)})`);
              } else if (idx === idxLatest && (currentTime - timestamp) >= config.afdianBotThrottle) {
                log(`afdian latest status ${id} (${timeAgo(timestamp)}) older than 'afdianBotThrottle', skipping...`);
              } else if (timestamp < dbScopeTimestampUnix) {
                argv.verbose && log(`afdian got old activity: ${id} (${timeAgo(timestamp)}), discarding...`);
              } else {
                log(`afdian got update: ${id}: ${content} (${timeAgo(timestamp)})`);

                if (account.qGuildId && config.qGuild.enabled) {

                  await sendQGuild({method: 'send_guild_channel_msg'}, qgBody).then(resp => {
                    // log(`go-qchttp post afdian success: ${resp}`);
                  })
                  .catch(e => {
                    err(`go-qchttp post afdian error: ${e?.response?.body || e}`, e);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled) {

                  if (image) {
                    const photoExt = image.split('.').pop();
                    const tgForm = new FormData();
                    const coverImage = await readProcessedMedia(`${image}`);
                    tgForm.append('chat_id', account.tgChannelId);
                    tgForm.append('parse_mode', 'HTML');
                    tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', coverImage, photoExt === 'gif' && 'image.gif');
                    tgForm.append('caption', `${content}${tgBodyFooter}`);

                    await sendTelegram({
                      method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                      payload: 'form',
                    }, tgForm).then(resp => {
                      // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                    })
                    .catch(e => {
                      err(`telegram post afdian error: ${e?.response?.body || e}`, e);
                    });
                  } else {
                    await sendTelegram(tgOptions, tgBody).then(resp => {
                      // log(`telegram post afdian success: message_id ${resp.result.message_id}`)
                    })
                    .catch(e => {
                      err(`telegram post afdian error: ${e?.response?.body || e}`, e);
                    });
                  }
                }
              }
            };

            // Set new data to database
            dbScope['afdian'] = dbStore;
          } else {
            log('afdian empty result, skipping...');
          }
        } else {
          log('afdian info corrupted, skipping...');
        }
      })
      .catch(e => {
        err(`afdian request error: ${e}`, e);
      });

      // Fetch RSS
      if (Array.isArray(account.rss) && account.rss.length > 0) {

        for (const [idx, rss] of account.rss.entries()) {

          log(`rss service ${idx + 1}/${account.rss.length}: ${rss.slug}, requesting ${rss.url}`);

          await rssExtract(rss.url, {...config.pluginOptions, ...cookieOnDemand(config.pluginOptions.customCookies[rss.slug])}).then(async resp => {
            const currentTime = Date.now();
            const data = rss.provider === 'rsshub' ? resp.rss.channel : resp.feed;

            // console.log(`data`, data);
            // console.log(`activities`, data.item);

            if (Array.isArray(data.item) && data.item.length > 0) {
              const dbStore = {
                scrapedTime: new Date(currentTime),
                scrapedTimeUnix: +new Date(currentTime),
              };

              // Morph data for database schema
              const activities = data.item.map(obj => {
                return {
                  ...obj,
                  created_at_unix: +new Date(obj.pubDate)
                }
                // Sort array by date in ascending order (reversed).
              }).sort((a, b) => a.created_at_unix - b.created_at_unix);

              const dbScopeTimestampUnix = dbScope?.[rss.slug]?.latestActivity?.timestampUnix;

              argv.json && fs.writeFile(`db/${account.slug}-rss-${rss.slug}.json`, JSON.stringify(json, null, 2), err => {
                if (err) return console.log(err);
              });

              for (let [idx, activity] of activities.entries()) {
                const guid = new URL(activity?.guid);
                const timestamp = activity?.created_at_unix;
                const id = guid.pathname + guid.search;
                const idxLatest = activities.length - 1;

                // If last (the last one in the array is the latest now) item
                if (idx === idxLatest) {
                  dbStore.latestActivity = {
                    id: id,
                    timestamp: new Date(timestamp),
                    timestampUnix: timestamp,
                    timeAgo: timeAgo(timestamp),
                  }
                };

                let content = `${msgPrefix}#${rss.name} `;
                  // + `${activity.answer?.imgList?.length ? `\n附图：${activity.answer.imgList.join(' ')}` : ''}`
                  // + `${activity.answer?.linkCard ? `\n链接：<a href="${activity.answer.linkCard.originalUrl}">${activity.answer.linkCard.title}</a>` : ''}`;
                // const image = activity?.cover || Array.isArray(activity?.pics) && activity?.pics[0] || activity?.audio_thumb;
                const image = false;

                if (rss.type === 'twitter') {
                  content += stripHtml(activity.description);
                } else {
                  content += `${activity.title} ${stripHtml(activity.description)}`;
                }

                const tgOptions = {
                  method: 'sendMessage',
                };

                const tgBodyFooter = `\n\n<a href="${activity.link}">${timeAgo(timestamp, rss?.lang || 'zh_cn')}</a>`
                  + ` | <a href="${data.link}">${data?.title || '未知作者'}</a>`;

                const tgBody = {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: rss.type === 'twitter' ? true : false,
                  text: `${content}${tgBodyFooter}`,
                };

                const qgBody = {
                  guild_id: account.qGuildId,
                  channel_id: account.qGuildChannelId,
                  message: `${content}${tgBodyFooter}`,
                };

                if (!dbScopeTimestampUnix) {
                  log(`rss service ${rss.slug} initial run, notifications skipped`);
                } else if (timestamp === dbScopeTimestampUnix) {
                  log(`rss service ${rss.slug} no update. latest: ${dbScope?.[rss.slug]?.latestActivity?.id} (${timeAgo(dbScope?.[rss.slug]?.latestActivity?.timestamp)})`);
                } else if (idx === idxLatest && timestamp <= dbScopeTimestampUnix) {
                  log(`rss service ${rss.slug} new activity older than database. latest: ${id} (${timeAgo(timestamp)})`);
                } else if (idx === idxLatest && (currentTime - timestamp) >= config.rssBotThrottle) {
                  log(`rss service ${rss.slug} latest status ${id} (${timeAgo(timestamp)}) older than 'rssBotThrottle', skipping...`);
                } else if (timestamp < dbScopeTimestampUnix) {
                  argv.verbose && log(`rss service ${rss.slug} got old activity: ${id} (${timeAgo(timestamp)}), discarding...`);
                } else {
                  log(`rss service ${rss.slug} got update: ${id}: (${timeAgo(timestamp)})`);

                  if (account.qGuildId && config.qGuild.enabled) {

                    await sendQGuild({method: 'send_guild_channel_msg'}, qgBody).then(resp => {
                      // log(`go-qchttp post rss service ${rss.slug} success: ${resp}`);
                    })
                    .catch(e => {
                      err(`go-qchttp post rss service ${rss.slug} error: ${e?.response?.body || e}`, e);
                    });
                  }

                  if (account.tgChannelId && config.telegram.enabled) {

                    if (image) {
                      const photoExt = image.split('.').pop();
                      const tgForm = new FormData();
                      const coverImage = await readProcessedMedia(`${image}`);
                      tgForm.append('chat_id', account.tgChannelId);
                      tgForm.append('parse_mode', 'HTML');
                      tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', coverImage, photoExt === 'gif' && 'image.gif');
                      tgForm.append('caption', `${content}${tgBodyFooter}`);

                      await sendTelegram({
                        method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                        payload: 'form',
                      }, tgForm).then(resp => {
                        // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                      })
                      .catch(e => {
                        err(`telegram post rss service ${rss.slug} error: ${e?.response?.body || e}`, e);
                      });
                    } else {
                      await sendTelegram(tgOptions, tgBody).then(resp => {
                        // log(`telegram post rss service ${rss.slug} success: message_id ${resp.result.message_id}`)
                      })
                      .catch(e => {
                        err(`telegram post rss service ${rss.slug} error: ${e?.response?.body || e}`, e);
                      });
                    }
                  }
                }
              }

              // Set new data to database
              dbScope[rss.slug] = dbStore;
            } else {
              log(`rss service ${rss.slug} empty result, skipping...`);
            }

          }).catch(e => {
            err(`rss service ${rss.slug} fetch error`, e);
          });
        }
      }

      // Write new data to database
      await db.write();
      argv.verbose && log(`global db saved`);

      // Store Sentry transaction
      transaction.finish();
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
