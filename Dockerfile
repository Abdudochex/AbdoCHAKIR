FROM node:20-alpine

WORKDIR /app

# نسخ ملفات الحزم أولاً للاستفادة من الكاش
COPY package*.json ./
RUN npm install --omit=dev

# نسخ باقي ملفات المشروع
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "app.js"]
