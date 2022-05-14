import got from 'got';
import jsdom from 'jsdom';

const { JSDOM } = jsdom;

async function extract(url, options = {}) {
  const parsedUrl = new URL(url);

  const mobileUserAgent = options?.mobileUserAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1';
  const desktopUserAgent = options?.desktopUserAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.54 Safari/537.36';
  const requestOptions = options?.requestOptions || {};
  const cookieOptions = options?.cookies || '';

  try {
    // Douyin videos need desktop UA to work:
    // macOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
    //
    // Douyin Live streams need mobile UA to work:
    // Android: 'Mozilla/5.0 (Linux; Android 6.0.1; Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Mobile Safari/537.36'
    // Telegram In-App Browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
    const reqUserAgent =
      parsedUrl.hostname === 'live.douyin.com' ||
      parsedUrl.hostname === 'webcast.amemv.com' ?
      mobileUserAgent : desktopUserAgent;

    const resp = await got(url, {
      headers: {
        'user-agent': reqUserAgent,
        cookie: cookieOptions,
      },
      ...requestOptions
    });

    const el_target = '#RENDER_DATA';
    const dom = new JSDOM(resp.body);
    const renderedData = dom.window.document.querySelector(el_target);
    const renderedLiveData = dom.window.document.querySelectorAll('script');

    if (renderedData) {
      const decodeJson = decodeURIComponent(renderedData.textContent);
      return JSON.parse(decodeJson);
    }

    // Deprecated: this was used to detech detect Douyin live streams for mobile
    // devices like https://webcast.amemv.com/webcast/reflow/6996256987986021157
    // But now it uses a seperate API call without embedding then in HTML.
    // See core/src/index.js for example.
    else if (renderedLiveData) {

      for (let i = 0; i < renderedLiveData.length; i++) {
        const script = renderedLiveData[i];
        const regex = /^(window\.__INIT_PROPS__ ?= ?)(?<content>{.*)/gm;
        const match = regex.exec(script?.textContent);

        if (match?.groups?.content) {
          return JSON.parse(match?.groups?.content);
        }
      }
    }

    else {
      console.log('No rendered data found!');
    }

  } catch (err) {
    console.log(err);
  }
}

export default extract;
