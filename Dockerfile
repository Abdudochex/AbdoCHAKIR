FROM node:20-bullseye

# تثبيت المكتبات اللازمة للنظام (مهم جداً لعمل البوت)
RUN apt-get update && apt-get install -y \
    libgbm-dev \
    wget \
    unzip \
    fontconfig \
    locales \
    g++ \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
