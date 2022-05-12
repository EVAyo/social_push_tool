FROM node:16-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY . /app

VOLUME /app

# https://github.com/lovell/sharp/issues/3150
# https://stackoverflow.com/questions/62218240
RUN apk add --update --no-cache binutils build-base make vips-dev --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community/

RUN yarn --frozen-lockfile && \
    yarn cache clean

ENTRYPOINT [ "node", "src/index", "run" ]
