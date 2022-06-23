import got from 'got';
import jsdom from 'jsdom';

const { JSDOM } = jsdom;

async function extract(url, options = {}) {
  try {
    const resp = await got(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36',
      },
      ...options
    });

    const el_target = '__NEXT_DATA__';
    const dom = new JSDOM(resp.body);
    const rendered_data = dom.window.document.getElementById(el_target);

    if (rendered_data) {
      const data_decode = decodeURIComponent(rendered_data.textContent);
      return JSON.parse(data_decode);
    } else {
      console.log('No rendered data found!');
    }

  } catch (err) {
    console.log(err);
  }
}

export default extract;
