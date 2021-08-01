import got from 'got';
import jsdom from 'jsdom';

const { JSDOM } = jsdom;

async function extract(url, options = {}) {
  try {
    const resp = await got(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
      },
      ...options
    });

    const el_target = '#RENDER_DATA';
    const dom = new JSDOM(resp.body);
    const renderedData = dom.window.document.querySelector(el_target);
    const renderedLiveData = dom.window.document.querySelectorAll('script');

    // If Douyin main site
    if (renderedData) {
      const decodeJson = decodeURIComponent(renderedData.textContent);
      return JSON.parse(decodeJson);
    }

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
