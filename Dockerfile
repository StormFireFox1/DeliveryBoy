FROM building5/dumb-init as init

FROM node:16.15.0 as build
COPY package.json yarn.lock tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN yarn --production=true --frozen-lockfile
RUN yarn prisma generate
RUN yarn prisma db push
RUN yarn build

FROM node:16.15.0 as prod
COPY --from=build build ./build
COPY --from=build node_modules ./node_modules
COPY --from=build prisma ./prisma
COPY --from=init /dumb-init /usr/local/bin/

EXPOSE 8099
ENTRYPOINT ["/usr/local/bin/dumb-init", "--"]
CMD ["node", "build/index.js"]
