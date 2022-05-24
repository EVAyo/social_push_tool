import got from 'got';
import { XMLParser } from 'fast-xml-parser';

async function extract(url, options = {}) {
  const userAgent = options?.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.54 Safari/537.36';
  const requestOptions = options?.requestOptions || {};
  const fxpOptions = options?.fxpOptions || {};
  const cookieOptions = options?.cookies || '';

  try {
    const resp = await got(url, {
      headers: {
        'user-agent': userAgent,
        cookie: cookieOptions,
      },
      ...requestOptions
    });

    try {
      const parser = new XMLParser(fxpOptions);
      const xml = resp.body;
      const json = parser.parse(xml);

      return json;
    } catch (err) {
      console.log(err);
    }
  } catch (err) {
    console.log(err);
  }
}

export default extract;
