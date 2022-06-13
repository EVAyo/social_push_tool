import path from 'path';
import { fileFromPath } from 'formdata-node/file-from-path';
import { Blob } from 'formdata-node';
import getStream from 'get-stream';
import sharp from 'sharp';
import got from 'got';

async function processMedia(inputMedia) {
  const {
    name,
    ext
  } = path.parse(inputMedia);
  // console.log(name);
  // console.log(ext);

  // Pass remote media via stream and convert it to buffer
  const source = inputMedia.startsWith('http')
    ? await getStream.buffer(got(inputMedia, {isStream: true}))
    : inputMedia;

  const media = sharp(source, { animated: true });
  const metadata = await media.metadata();
  const {
    width,
    height,
    format,
    size,
  } = metadata;
  let mediaBuffer = await media.toBuffer({ resolveWithObject: true });

  // console.log(`buffer meta`, mediaBuffer.info);
  // console.log('input metadata', metadata);

  // From Telegram Bot API:
  // The photo must be at most 10 MB in size.
  // The photo's width and height must not exceed 10000 in total.
  // Width and height ratio must be at most 20.
  // Ref: https://core.telegram.org/bots/api#sendphoto

  if (format == 'gif') {
    return await media.toBuffer();
  } else {
    if (width / height > 20) {
      console.log('media too wide');
      const ratio = width / height;
      mediaBuffer = await media.extract({
        left: 0, top: 0, width: Math.floor(width / (ratio / 20)), height: height
      }).toBuffer({ resolveWithObject: true });
    }

    if (height / width > 20) {
      console.log('media too high');
      const ratio = height / width;
      mediaBuffer = await media.extract({
        left: 0, top: 0, width: width, height: Math.floor(height / ( ratio / 20))
      }).toBuffer({ resolveWithObject: true });
    }

    // Check if media need to be resized from latest buffer
    if (mediaBuffer.info.width + mediaBuffer.info.height > 10000) {
      console.log('media pixel too large');
      const scaleFactor = (mediaBuffer.info.width + mediaBuffer.info.height) / 10000;
      const resizeTo = Math.floor(mediaBuffer.info.width / scaleFactor);
      console.log('resizeTo', resizeTo);

      mediaBuffer = await media.resize(resizeTo).toBuffer({ resolveWithObject: true });
    }

    // console.log('output metadata', mediaBuffer);

    return await media.jpeg({
      quality: 90,
      progressive: true,
    }).toBuffer();
  }
}

export async function readProcessedMedia(inputMedia) {
  const file = new Blob(
    [await processMedia(inputMedia)]
  );

  return file;
}
