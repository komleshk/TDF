FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY public ./public
COPY samples ./samples
COPY src ./src
COPY database ./database

RUN mkdir -p /data /tmp/agm-wealth-uploads \
  && chown -R node:node /app /data /tmp/agm-wealth-uploads

USER node

ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/agm-wealth.sqlite
ENV STORAGE_PATH=/data
ENV UPLOAD_TMP_PATH=/tmp/agm-wealth-uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
