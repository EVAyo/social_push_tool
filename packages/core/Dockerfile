FROM node:16-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY . /app

VOLUME /app

RUN yarn --frozen-lockfile && \
    yarn cache clean

ENTRYPOINT [ "node", "src/index", "run" ]
