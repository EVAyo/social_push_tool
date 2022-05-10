FROM node:16-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY . /app

VOLUME /app

# https://github.com/lovell/sharp/issues/3150
RUN apk add --no-cache vips-dev

RUN yarn --frozen-lockfile && \
    yarn cache clean

ENTRYPOINT [ "node", "src/index", "run" ]
