FROM node:20-alpine

WORKDIR /app

# تثبيت git وأدوات البناء الأساسية (بعض تبعيات baileys تحتاجها أثناء npm install)
RUN apk add --no-cache git python3 make g++

# نسخ ملفات الحزم أولاً للاستفادة من الكاش
COPY package*.json ./
RUN npm install --omit=dev

# نسخ باقي ملفات المشروع
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "app.js"]
