FROM ghcr.io/puppeteer/puppeteer:22.10.0
USER root
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "app.js"]
