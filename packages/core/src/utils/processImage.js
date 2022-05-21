import path from 'path';
import { fileFromPath } from 'formdata-node/file-from-path';
import { Blob } from 'formdata-node';
import getStream from 'get-stream';
import sharp from 'sharp';
import got from 'got';

async function processImage(inputImage) {
  const {
    name,
    ext
  } = path.parse(inputImage);
  // console.log(name);
  // console.log(ext);

  // Pass remote image via stream and convert it to buffer
  const source = inputImage.startsWith('http')
    ? await getStream.buffer(got(inputImage, {isStream: true}))
    : inputImage;

  const image = sharp(source, { animated: true });
  const metadata = await image.metadata();
  const {
    width,
    height,
    format,
    size,
  } = metadata;
  let imageBuffer = await image.toBuffer({ resolveWithObject: true });

  // console.log(`buffer meta`, imageBuffer.info);
  // console.log('input metadata', metadata);

  // From Telegram Bot API:
  // The photo must be at most 10 MB in size.
  // The photo's width and height must not exceed 10000 in total.
  // Width and height ratio must be at most 20.
  // Ref: https://core.telegram.org/bots/api#sendphoto

  if (format == 'gif') {
    return await image.toBuffer();
  } else {
    if (width / height > 20) {
      console.log('image too wide');
      const ratio = width / height;
      imageBuffer = await image.extract({
        left: 0, top: 0, width: Math.floor(width / (ratio / 20)), height: height
      }).toBuffer({ resolveWithObject: true });
    }

    if (height / width > 20) {
      console.log('image too high');
      const ratio = height / width;
      imageBuffer = await image.extract({
        left: 0, top: 0, width: width, height: Math.floor(height / ( ratio / 20))
      }).toBuffer({ resolveWithObject: true });
    }

    // Check if image need to be resized from latest buffer
    if (imageBuffer.info.width + imageBuffer.info.height > 10000) {
      console.log('image pixel too large');
      const scaleFactor = (imageBuffer.info.width + imageBuffer.info.height) / 10000;
      const resizeTo = Math.floor(imageBuffer.info.width / scaleFactor);
      console.log('resizeTo', resizeTo);

      imageBuffer = await image.resize(resizeTo).toBuffer({ resolveWithObject: true });
    }

    // console.log('output metadata', imageBuffer);

    return await image.jpeg({
      quality: 90,
      progressive: true,
    }).toBuffer();
  }
}

export async function readProcessedImage(inputImage) {
  const file = new Blob(
    [await processImage(inputImage)]
  );

  return file;
}
