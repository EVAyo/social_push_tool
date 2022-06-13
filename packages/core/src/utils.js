export function formatDate(timestamp) {
  let date = timestamp.toString().length === 10 ? new Date(+timestamp * 1000) : new Date(+timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

export function stripHtml(string = '', options = {}) {
  // https://regex101.com/r/xa83Od/1
  // Replace Weibo custom emojis with its alt attribute
  if (options?.withBr) {
    return string
      .replace(/<img.*?alt=(\[.*?\])[^\>]+>/gmi, '$1')
      .replace(/<br ?\/?>/gmi, '\n')
      .replace(/(<([^>]+)>)/gmi, '')
      .trim();
  } else if (options?.withMedia) {
    // https://regex101.com/r/O2FBUa/1
    return string
      .replace(/<(?:video|img).*?src=\\"(.*?)\\"[^\>]+>/gmi, ' $1 ')
      .replace(/<br ?\/?>/gmi, '\n')
      .replace(/(<([^>]+)>)/gmi, '')
      .trim();
  } else {
    return string
      .replace(/<img.*?alt=(\[.*?\])[^\>]+>/gmi, '$1')
      .replace(/(<([^>]+)>)/gmi, '')
      .trim();
  }
}

export function textTruncate(text, options = {}) {
  const {
    length = 1024,
    gated = 0,
  } = options;

  if (text.length > length) {
    return text.substring(0, length - gated) + ' […]';
  } else {
    return text;
  }
}

export function extractImage(string = '') {
  // https://regex101.com/r/O2FBUa/1
  const imageRegex = /<(?:video|img).*?src=\"(.*?)\"[^\>]+>/gmi;
  return (string.match(imageRegex) || []).map(match => match.replace(imageRegex, '$1'));
}

export function convertWeiboUrl(url) {
  const originalUrl = new URL(url);
  const { origin, pathname } = originalUrl;
  const path = pathname.replace(/^\/.*\//i, '');
  return `${origin}/mw2000/${path}`;
}

export function parseDdstatsString(string, type) {
  // Examples:
  // 艾白_千鸟Official 在 杜松子_Gin 的直播间发送了一则消息: 那我等你下播了！我们聊！
  // 艾白_千鸟Official 进入了 金克茜Jinxy 的直播间
  // 七海Nana7mi 在 HiiroVTuber 的直播间发送了一则表情包:
  // 在 HiiroVTuber 的直播间收到来自 七海Nana7mi 的 500 元醒目留言: gong xi！！！！
  // 在 喵月nyatsuki 的直播间收到来自 七海Nana7mi 的 舰长

  let parseRegex = /.*/;

  if (type === 'SUPER_CHAT_MESSAGE' || type === 'GUARD_BUY' || type === 'SEND_GIFT') {
    // https://regex101.com/r/M35gu2/1
    // schema:
    //   action: "的直播间收到来自"
    //   content: "500 元醒目留言: gong xi！！！！"
    //   target: "HiiroVTuber"
    //   user: "七海Nana7mi"
    parseRegex = /在 (?<target>\S+) (?<action>\S+) (?<user>\S+) 的 (?<content>.+)/;
  } else {
    // https://regex101.com/r/lqoLdk/1
    // schema:
    //   action: "在"
    //   content: "的直播间发送了一则消息: 那我等你下播了！我们聊！"
    //   target: "杜松子_Gin"
    //   user: "艾白_千鸟Official"
    parseRegex = /(?<user>\S+) (?<action>\S+) (?<target>\S+) (?<content>.+)/;
  }

  const { groups } = parseRegex.exec(string);
  return groups;
}
