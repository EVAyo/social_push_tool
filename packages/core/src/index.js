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
    ddstatsBotThrottle: 3600 * 1000,
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

function parseDdstatsString(string, type) {
  // Examples:
  // 艾白_千鸟Official 在 杜松子_Gin 的直播间发送了一则消息: 那我等你下播了！我们聊！
  // 艾白_千鸟Official 进入了 金克茜Jinxy 的直播间
  // 七海Nana7mi 在 HiiroVTuber 的直播间发送了一则表情包:
  // 在 HiiroVTuber 的直播间收到来自 七海Nana7mi 的 500 元醒目留言: gong xi！！！！

  let parseRegex = /.*/;

  if (type === 'SUPER_CHAT_MESSAGE') {
    // https://regex101.com/r/jhT8f4/1
    // schema:
    //   action: "在"
    //   content: "的直播间发送了一则消息: 那我等你下播了！我们聊！"
    //   target: "杜松子_Gin"
    //   user: "艾白_千鸟Official"
    parseRegex = /在 (?<target>\S+) (?<action>\S+) (?<user>\S+) 的 (?<content>.+)/;
  } else {
    // https://regex101.com/r/RQ2WsA/1
    // schema:
    //   action: "的直播间收到来自"
    //   content: "500 元醒目留言: gong xi！！！！"
    //   target: "HiiroVTuber"
    //   user: "七海Nana7mi"
    parseRegex = /(?<user>\S+) (?<action>\S+) (?<target>\S+) (?<content>.+)/;
  }

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
                    tgForm.append('photo', await readProcessedImage(`${liveCover}`));
                    tgForm.append('caption', `${msgPrefix}#抖音开播：${title}`
                      + `\n\n<a href="https://webcast.amemv.com/webcast/reflow/${id_str}">Watch</a>`
                      + ` | <a href="${streamUrl}">M3U8</a>`
                      + ` | <a href="${liveCover}">Artwork</a>`
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
                        .catch(err => {
                          log(`go-qchttp post douyin-live error: ${err?.response?.body || err}`);
                        });
                      }

                      if (account.tgChannelId && config.telegram.enabled) {

                        // This function should be waited since we rely on the `isTgSent` flag
                        await sendTelegram(tgOptions, tgForm).then(resp => {
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
      }).catch(err => {
        console.log(err);
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
              caption: `${msgPrefix}#抖音视频：${title} #${id}`
                + `\n\n<a href="${shareUrl}">Watch</a>`
                + ` | <a href="${cover}">Artwork</a>`
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
            parse_mode: 'HTML',
            caption: `${msgPrefix}#b站开播：${liveTitle}`
              + `\n\n<a href="${liveRoom}">Watch</a>`
              + ` | <a href="${liveCover}">Artwork</a>`
              + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${nickname}</a>`
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
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站直播间标题更新\n新：${liveTitle}\n旧：${dbScope?.bilibili_live?.latestStream?.liveTitle}`
                  + `\n\n<a href="${liveRoom}">Watch</a>`
                  + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${nickname}</a>`
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
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站昵称更新\n新：${nickname}\n旧：${dbScope?.bilibili_live?.nickname}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
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
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站签名更新\n新：${sign}\n旧：${dbScope?.bilibili_live?.sign}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
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
              const photoExt = avatar.split('.').pop();
              const tgForm = new FormData();
              const avatarImage = await readProcessedImage(`${avatar}`);
              tgForm.append('chat_id', account.tgChannelId);
              tgForm.append('parse_mode', 'HTML');
              tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', avatarImage);
              tgForm.append('caption', `${msgPrefix}#b站头像更新，旧头像：${dbScope?.bilibili_live?.avatar}`
                + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              );

              await sendTelegram({
                method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                payload: 'form',
              }, tgForm).then(resp => {
                // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::avatar error: ${err?.response?.body || err}`);
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
                .catch(err => {
                  log(`telegram post bilibili-live::avatar error: ${err?.response?.body || err}`);
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
              .catch(err => {
                log(`go-qchttp post bilibili-live::fans_medal error: ${err?.response?.body || err}`);
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
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站头像挂件变更\n新：${pendant?.name || '无佩戴'}`
                  + `\n旧：${pendantOld?.name || '无佩戴'}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
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
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站勋章变更\n新：${nameplate?.name || '无勋章'}${nameplate?.condition ? '（' + nameplate?.condition + '）' : ''}`
                  + `\n旧：${nameplateOld?.name || '无勋章'}${nameplateOld?.condition ? '（' + nameplateOld?.condition + '）' : ''}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
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
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: `${msgPrefix}#b站认证变更\n新：${official?.title || '无认证'}`
                  + `\n旧：${officialOld?.title || '无认证'}`
                  + `\n\n<a href="https://space.bilibili.com/${uid}">${nickname}</a>`
              }).then(resp => {
                // log(`telegram post bilibili-live::official verification success: message_id ${resp.result.message_id}`)
              })
              .catch(err => {
                log(`telegram post bilibili-live::official verification error: ${err?.response?.body || err}`);
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
              .catch(err => {
                log(`go-qchttp post bilibili-live::vip status error: ${err?.response?.body || err}`);
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
              .catch(err => {
                log(`telegram post bilibili-live::vip status error: ${err?.response?.body || err}`);
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

              if (err.stack) {
                console.log(err.stack);
              }
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

        if (err.stack) {
          console.log(err.stack);
        }
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
                .catch(err => {
                  log(`go-qchttp post bilibili-mblog::decorate_card error: ${err?.response?.body || err}`);
                });
              }

              if (account.tgChannelId && config.telegram.enabled) {

                await sendTelegram({ method: 'sendMessage' }, {
                  chat_id: account.tgChannelId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#b站粉丝装扮变更\n新：${decoNew?.name || '无装扮'}${decoNew?.fan?.number ? '#' + decoNew?.fan?.number : '（无编号）'}`
                    + `\n旧：${decoOld?.name || '无装扮'}${decoOld?.fan?.number ? '#' + decoOld?.fan?.number : '（无编号）'}`
                    + `${decoNew?.id ? `\n\n<a href="${decoNew?.jump_url || '未知'}">Decoration Link</a>` : ''}`
                    + `${decoNew?.id ? ` | ` : `\n\n`}<a href="https://space.bilibili.com/${uid}">${user.info.uname}</a>`
                }).then(resp => {
                  // log(`telegram post bilibili-mblog::decorate_card success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post bilibili-mblog::decorate_card error: ${err?.response?.body || err}`);
                });
              }
            }

            // Creating Telegram cache set from database. This ensure no duplicated notifications will be sent
            const tgCacheSet = new Set(Array.isArray(dbScope?.bilibili_mblog?.tgCache) ? dbScope.bilibili_mblog.tgCache.reverse().slice(0, 30).reverse() : []);
            const tgCommentsCacheSet = new Set(Array.isArray(dbScope?.bilibili_mblog?.tgCommentsCache) ? dbScope.bilibili_mblog.tgCommentsCache.reverse().slice(0, 30).reverse() : []);

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

                const commentsTypeMap = {

                };

                if (account.bilibiliFetchingComments) {
                  const bilibiliCommentsRequestUrl = `https://api.bilibili.com/x/v2/reply/main?oid=${dynamicId}&type=17`;
                  log(`bilibili-mblog fetching comments from ${commentsId} for activity ${dynamicId}...`)
                  argv.verbose && log(`bilibili-mblog comments requesting ${bilibiliCommentsRequestUrl}`);
                  await got(bilibiliCommentsRequestUrl, {...config.pluginOptions?.requestOptions, ...proxyOptions}).then(async resp => {
                    const json = JSON.parse(resp.body);

                    if (json?.code === 0 && Array.isArray(json.data.replies) && json.data.replies.length > 0) {
                      const comments = json.data.replies;

                      for (const [idx, comment] of comments.entries()) {

                        if (comment?.member?.mid === account.biliId && !tgCommentsCacheSet.has(comment.rpid_str)) {
                          log(`bilibili-mblog author comment detected ${comment.rpid_str} for activity ${dynamicId}...`)

                          if (account.tgChannelId && config.telegram.enabled) {

                            await sendTelegram({ method: 'sendMessage' }, {
                              chat_id: account.tgChannelId,
                              parse_mode: 'HTML',
                              disable_web_page_preview: true,
                              disable_notification: true,
                              allow_sending_without_reply: true,
                              text: `${msgPrefix}#b站新评论 (${timeAgo(+new Date(comment.ctime * 1000))})：${stripHtml(comment?.content?.message) || '未知内容'}`
                                + `\n\n<a href="https://t.bilibili.com/${dynamicId}#reply${comment.rpid_str}">View Comment</a>`
                                + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`
                            }).then(resp => {
                              log(`telegram post bilibili-mblog::author_comment success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                              tgCommentsCacheSet.add(comment.rpid_str);
                            })
                            .catch(err => {
                              log(`telegram post bilibili-mblog::author_comment error: ${err}`);
                            });
                          }
                        }

                        // Check replies inside comments
                        if (Array.isArray(comment.replies) && comment.replies.length > 0) {
                          const replies = comment.replies;

                          for (const [idx, reply] of replies.entries()) {

                            if (reply?.member?.mid === account.biliId && !tgCommentsCacheSet.has(reply.rpid_str)) {
                              log(`bilibili-mblog author comment reply detected ${reply.rpid_str} in comment ${comment.rpid_str} for activity ${dynamicId}...`)

                              if (account.tgChannelId && config.telegram.enabled) {

                                await sendTelegram({ method: 'sendMessage' }, {
                                  chat_id: account.tgChannelId,
                                  parse_mode: 'HTML',
                                  disable_web_page_preview: true,
                                  disable_notification: true,
                                  allow_sending_without_reply: true,
                                  text: `${msgPrefix}#b站新评论回复 (${timeAgo(+new Date(reply.ctime * 1000))})：${stripHtml(reply?.content?.message) || '未知内容'}`
                                    + `\n\n<a href="https://t.bilibili.com/${dynamicId}#reply${reply.rpid_str}">View Reply</a>`
                                    + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`
                                  }).then(resp => {
                                  log(`telegram post bilibili-mblog::author_comment_reply success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                                  tgCommentsCacheSet.add(reply.rpid_str);
                                })
                                .catch(err => {
                                  log(`telegram post bilibili-mblog::author_comment_reply error: ${err}`);
                                });
                              }
                            }
                          }
                        } else {
                          argv.verbose && log(`bilibili-mblog comment ${comment.rpid_str} has no reply, skipped`);
                        }
                      }
                    } else {
                      log('bilibili-mblog comments corrupted, skipped');
                    }
                  }).catch(err => {
                    log(`bilibili-mblog comments request error: ${err}`);

                    if (err.stack) {
                      console.log(err.stack);
                    }
                  });
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
                //   .catch(err => {
                //     log(`go-qchttp post bilibili-blog error: ${err?.response?.body || err}`);
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
                //   .catch(err => {
                //     log(`telegram post bilibili-mblog error: ${err?.response?.body || err}`);
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

                const tgBodyFooter = `\n\n<a href="https://t.bilibili.com/${dynamicId}">View</a>`
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
                    tgOptions.payload = 'form';
                    tgForm.append('photo', await readProcessedImage(`${originJson?.origin_image_urls}`));
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
                    tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${originJson?.item?.pictures[0].img_src}`));
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
                    tgOptions.method = 'sendPhoto';
                    tgBody.photo = `${originJson?.pic}`;
                    tgBody.caption = `${msgPrefix}#b站视频转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}${tgBodyFooter}`;
                    qgBody.message = `${msgPrefix}#b站视频转发：${cardJson?.item?.content.trim()}\n动态链接：https://t.bilibili.com/${dynamicId}\n\n被转作者：@${originJson.owner.name}\n被转视频：${originJson.title}\n\n${originJson.desc}\n${originJson.short_link}\n[CQ:image,file=${originJson?.pic}]`;
                  }

                  // Plain text
                  else {
                    tgBody.text = `${msgPrefix}#b站转发：${cardJson?.item?.content.trim()}\n\n被转作者：@${originJson.user.uname}\n被转动态：${originJson.item.content}${tgBodyFooter}`;
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
                  tgOptions.method = 'sendPhoto';
                  tgBody.photo = cardJson.pic;
                  // dynamic: microblog text
                  // desc: video description
                  tgBody.caption = `${msgPrefix}#b站视频：${cardJson.title}\n${cardJson.dynamic}\n${cardJson.desc}`
                    + `\n\n<a href="https://t.bilibili.com/${dynamicId}">View</a>`
                    + ` | <a href="${cardJson.short_link}">Watch Video</a>`
                    + ` | <a href="https://space.bilibili.com/${uid}/dynamic">${user.info.uname}</a>`;
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
                  tgForm.append('photo', await readProcessedImage(`${cardJson.origin_image_urls[0]}`));
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
                    .catch(err => {
                      log(`go-qchttp post bilibili-mblog error: ${err?.response?.body || err}`);
                    });
                  }

                  if (account.tgChannelId && config.telegram.enabled && !tgCacheSet.has(dynamicId)) {

                    await sendTelegram(tgOptions, tgOptions?.payload === 'form' ? tgForm : tgBody).then(resp => {
                      argv.verbose && log(`telegram post bilibili-mblog success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                      tgCacheSet.add(dynamicId);
                    })
                    .catch(err => {
                      log(`telegram post bilibili-mblog error: ${err?.response?.body || err}`);
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
                          tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${cardJson.item.pictures[idx].img_src}`));
                          tgForm.append('caption', `${msgPrefix}#b站相册动态${photoCountText}：${cardJson?.item?.description}${extendedMeta}${tgBodyFooter}`);

                          await sendTelegram({
                            method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                            payload: 'form',
                          }, tgForm).then(resp => {
                            log(`telegram post bilibili-mblog (batch #${idx + 1}) success`)
                          })
                          .catch(err => {
                            log(`telegram post bilibili-mblog (batch #${idx + 1}) error: ${err?.response?.body || err}`);
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
      .catch(err => {
        log(`bilibili-mblog request error: ${err?.response?.body || err}`);

        if (err.stack) {
          console.log(err.stack);
        }
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
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#微博签名更新\n新：${user.description}\n旧：${dbScope?.weibo?.user?.description}`
                    + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
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
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  text: `${msgPrefix}#微博认证更新\n新：${user?.verified_reason || '无认证'}`
                    + `\n旧：${dbScope?.weibo?.user?.verified_reason || '无认证'}`
                    + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
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
                const photoExt = user.avatar_hd.split('.').pop();
                const tgForm = new FormData();
                const avatarImage = await readProcessedImage(`${user.avatar_hd}`);
                tgForm.append('chat_id', account.tgChannelId);
                tgForm.append('parse_mode', 'HTML');
                tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', avatarImage);
                tgForm.append('caption', `${msgPrefix}#微博头像更新，旧头像：${dbScope?.weibo?.user?.avatar_hd}`
                  + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                );

                await sendTelegram({
                  method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                  payload: 'form',
                }, tgForm).then(resp => {
                  // log(`telegram post weibo::avatar success: message_id ${resp.result.message_id}`)
                })
                .catch(err => {
                  log(`telegram post weibo::avatar error: ${err}`);
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
                  .catch(err => {
                    log(`telegram post weibo::avatar error: ${err}`);
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
                .catch(err => {
                  log(`go-qchttp post weibo::avatar error: ${err?.response?.body || err}`);
                });
              }
            }

            // If user cover background update
            if (user.cover_image_phone !== dbScope?.weibo?.user?.cover_image_phone && dbScope?.weibo?.user?.cover_image_phone) {
              log(`weibo user cover updated: ${user.cover_image_phone}`);

              if (account.tgChannelId && config.telegram.enabled) {
                const photoExt = convertWeiboUrl(user.cover_image_phone).split('.').pop();
                const tgForm = new FormData();
                const coverImage = await readProcessedImage(`${convertWeiboUrl(user.cover_image_phone)}`);
                tgForm.append('chat_id', account.tgChannelId);
                tgForm.append('parse_mode', 'HTML');
                tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', coverImage);
                tgForm.append('caption', `${msgPrefix}#微博封面更新，旧封面：${convertWeiboUrl(dbScope?.weibo?.user?.cover_image_phone)}`
                  + `\n\n<a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                );

                await sendTelegram({
                  method: 'sendPhoto',
                  payload: 'form'
                }, tgForm).then(resp => {
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

            // Creating Telegram cache set from database. This ensure no duplicated notifications will be sent
            const tgCacheSet = new Set(Array.isArray(dbScope?.weibo?.tgCache) ? dbScope.weibo.tgCache.reverse().slice(0, 30).reverse() : []);
            const tgCommentsCacheSet = new Set(Array.isArray(dbScope?.weibo?.tgCommentsCache) ? dbScope.weibo.tgCommentsCache.reverse().slice(0, 30).reverse() : []);

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

                if (account.weiboFetchingComments) {
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
                              text: `${msgPrefix}#微博新评论 (${timeAgo(+new Date(comment.created_at))})：${stripHtml(comment?.text) || '未知内容'}`
                                + `\n\n被评论的微博：${text || '未知内容'}`
                                + `\n\n<a href="https://weibo.com/${user.id}/${id}">View</a>`
                                + ` | <a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                            }).then(resp => {
                              log(`telegram post weibo::author_comment success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                              tgCommentsCacheSet.add(comment.bid);
                            })
                            .catch(err => {
                              log(`telegram post weibo::author_comment error: ${err}`);
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
                                  text: `${msgPrefix}#微博新评论回复 (${timeAgo(+new Date(reply.created_at))})：${stripHtml(reply?.text) || '未知内容'}`
                                    + `\n\n被回复的评论：${stripHtml(comment?.text) || '未知内容'}`
                                    + `\n\n<a href="https://weibo.com/${user.id}/${id}">View</a>`
                                    + ` | <a href="https://weibo.com/${user.id}">${user.screen_name}</a>`
                                }).then(resp => {
                                  log(`telegram post weibo::author_comment_reply success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                                  tgCommentsCacheSet.add(reply.bid);
                                })
                                .catch(err => {
                                  log(`telegram post weibo::author_comment_reply error: ${err}`);
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
                  }).catch(err => {
                    log(`weibo comments request error: ${err}`);

                    if (err.stack) {
                      console.log(err.stack);
                    }
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
                //   .catch(err => {
                //     log(`telegram post weibo error: ${err?.response?.body || err}`);
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
                  }).catch(err => {
                    log(`weibo extended text request error: ${err}`);

                    if (err.stack) {
                      console.log(err.stack);
                    }
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

                const tgBodyFooter = `\n\n<a href="https://weibo.com/${user.id}/${id}">View</a>`
                  // Check if retweeted user is visible
                  // `user: null` will be returned if text: "抱歉，作者已设置仅展示半年内微博，此微博已不可见。 "
                  + `${retweetedStatus && retweetedStatus?.user ? ` | <a href="https://weibo.com/${retweetedStatus.user.id}/${retweetedStatus.bid}">View Retweeted</a>` : ''}`
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
                  // tgForm.append('photo', await readProcessedImage(`https://ww1.sinaimg.cn/large/${activity.pic_ids[0]}.jpg`));
                  tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${activity.pics[0].large.url}`));
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
                  .catch(err => {
                    log(`go-qchttp post weibo error: ${err?.response?.body || err}`);
                  });
                }

                if (account.tgChannelId && config.telegram.enabled && !tgCacheSet.has(id)) {

                  await sendTelegram(tgOptions, tgOptions?.payload === 'form' ? tgForm : tgBody).then(resp => {
                    argv.verbose && log(`telegram post weibo success: message_id ${JSON.parse(resp.body)?.result?.message_id}`);
                    tgCacheSet.add(id);
                  })
                  .catch(err => {
                    log(`telegram post weibo error: ${err?.response?.body || err}`);
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
                        tgForm.append(photoExt === 'gif' ? 'animation' : 'photo', await readProcessedImage(`${activity.pics[idx].large.url}`));
                        tgForm.append('caption', `${msgPrefix}#微博${visibilityMap[visibility] || ''}照片${photoCountText}：${text}${tgBodyFooter}`);

                        await sendTelegram({
                          method: photoExt === 'gif' ? 'sendAnimation' : 'sendPhoto',
                          payload: 'form',
                        }, tgForm).then(resp => {
                          log(`telegram post weibo (batch #${idx + 1}) success`)
                        })
                        .catch(err => {
                          log(`telegram post weibo (batch #${idx + 1}) error: ${err?.response?.body || err}`);
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
      .catch(err => {
        log(`weibo request error: ${err}`);

        if (err.stack) {
          console.log(err.stack);
        }
      });

      // Fetch DDStats
      const ddstatsRequestUrl = `https://ddstats-api.ericlamm.xyz/records/${account.biliId}?limit=15&type=dd`;
      !account.disableDdstats && argv.verbose && log(`ddstats requesting ${ddstatsRequestUrl}`);
      !account.disableDdstats && account.biliId && await got(ddstatsRequestUrl).then(async resp => {
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
              const content = activity.display;
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
              };

              const tgOptions = {
                method: 'sendMessage',
              };

              const tgBodyFooter = `\n\n<a href="https://ddstats.ericlamm.xyz/user/${account.biliId}">DDStats</a>`
                + ` | <a href="https://space.bilibili.com/${account.biliId}">${parsedContent?.user || 'View User'}</a>`
                + ` | <a href="https://space.bilibili.com/${activity?.target_uid}">${parsedContent?.target || 'View Target'}</a>`;

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

        if (err.stack) {
          console.log(err.stack);
        }
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
