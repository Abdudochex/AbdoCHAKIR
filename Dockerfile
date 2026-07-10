FROM ghcr.io/puppeteer/puppeteer:22.10.0
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
CMD ["node", "app.js"]
