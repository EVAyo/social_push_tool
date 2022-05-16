export function formatDate(timestamp) {
  let date = timestamp.toString().length === 10 ? new Date(+timestamp * 1000) : new Date(+timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

export function stripHtml(string = '', withBr = true) {
  // https://regex101.com/r/xa83Od/1
  // Replace Weibo custom emojis with its alt attribute
  if (withBr) {
    return string
      .replace(/<img.*?alt=(\[.*?\])[^\>]+>/gmi, '$1')
      .replace(/<br ?\/?>/gmi, '\n')
      .replace(/(<([^>]+)>)/gmi, '');
  } else {
    return string
      .replace(/<img.*?alt=(\[.*?\])[^\>]+>/gmi, '$1')
      .replace(/(<([^>]+)>)/gmi, '');
  }
}

export function convertWeiboUrl(url) {
  const originalUrl = new URL(url);
  const { origin, pathname } = originalUrl;
  const path = pathname.replace(/^\/.*\//i, '');
  return `${origin}/mw2000/${path}`;
}
