const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');

// ==================== الإعدادات العامة ====================
// رقم البوت (الرقم الذي سيتم توليد رمز الإقتران له)
const BOT_NUMBER = process.env.BOT_NUMBER || '212621790049';

// أرقام الأدمن المتحكمين في البوت (يمكن إضافة أكثر من رقم مفصول بفاصلة عبر متغير البيئة)
const ADMINS_FILE = path.join(__dirname, 'admins.json');

// دمج أرقام الأدمن الافتراضية (من متغير البيئة) مع أي أرقام أُضيفت سابقاً عبر .addadmin
function loadAdminNumbers() {
  const defaults = (process.env.ADMIN_NUMBERS || '212775925339,212621790049')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  let stored = [];
  if (fs.existsSync(ADMINS_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
    } catch (e) {
      stored = [];
    }
  }

  const merged = Array.from(new Set([...defaults, ...stored]));
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged.map((n) => `${n}@s.whatsapp.net`);
}

// قائمة أرقام الأدمن (قابلة للتعديل أثناء التشغيل عبر .addadmin)
let ADMIN_NUMBERS = loadAdminNumbers();

function saveAdminNumbers() {
  const rawNumbers = ADMIN_NUMBERS.map((jid) => jid.replace('@s.whatsapp.net', ''));
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(rawNumbers, null, 2), 'utf8');
}

const PLUGINS_DIR = path.join(__dirname, 'plugins');
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });

const PREFIX = '.';

// ==================== سيرفر بسيط (ضروري على Railway لإبقاء الخدمة حية) ====================
const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot is running ✅'));
app.listen(process.env.PORT || 3000, () => {
  console.log(`[HTTP] health server listening on port ${process.env.PORT || 3000}`);
});

// ==================== دوال مساعدة ====================
function isAdmin(jid) {
  return ADMIN_NUMBERS.includes(jid);
}

function getPluginPath(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, '');
  return path.join(PLUGINS_DIR, `${safeName}.json`);
}

// تنظيف اسم مكتبة npm من الحروف غير المرئية (مثل Zero-Width Space وعلامات اتجاه النص)
// التي تُضاف أحياناً تلقائياً عند الكتابة/النسخ من واتساب أو لوحات المفاتيح العربية
function sanitizePackageName(pkg) {
  return pkg.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF\u2060]/g, '').trim();
}

// يسمح بأسماء حزم npm الصحيحة فقط (عادية أو Scoped مثل @scope/name)
function isValidPackageName(pkg) {
  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9._-]+)?$/i.test(pkg);
}

// تطبيع رقم الهاتف من أي صيغة (+212 775-925339 / 00212 775 925 339 / ...) إلى أرقام فقط
function normalizePhoneNumber(raw) {
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2); // إزالة بادئة الاتصال الدولي 00
  return digits;
}

function extractQuotedText(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx || !ctx.quotedMessage) return null;
  const q = ctx.quotedMessage;
  return (
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    null
  );
}

function getMessageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  );
}

// بعض الرسائل تصل ملفوفة داخل ephemeralMessage / viewOnceMessage (خاصة مع الرسائل المؤقتة)
// بدون فك هذا التغليف، النص يصل فارغاً ولا يبدأ بالبريفكس فيُتجاهل الأمر بصمت.
function unwrapMessage(message) {
  if (!message) return message;
  if (message.ephemeralMessage) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage) return unwrapMessage(message.documentWithCaptionMessage.message);
  return message;
}

// تخزين الإضافات المحمّلة في الذاكرة
const loadedPlugins = {};

function loadAllPlugins() {
  const files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, file), 'utf8'));
      loadedPlugins[data.name] = data.code;
      console.log(`[PLUGINS] تم تحميل: ${data.name}`);
    } catch (e) {
      console.error(`[PLUGINS] فشل تحميل ${file}:`, e.message);
    }
  }
}

// تنفيذ كود إضافة مخزّنة
// تحذير: هذه الدالة تنفذ أكواد JavaScript كاملة الصلاحيات على السيرفر.
// استخدمها فقط مع أكواد تثق بمصدرها، لأن أمر .add يمنح صلاحية تنفيذ كود مباشر على سيرفرك.
function runPlugin(code, ctx) {
  try {
    const fn = new Function('sock', 'msg', 'ctx', code);
    return fn(ctx.sock, ctx.msg, ctx);
  } catch (e) {
    return `❌ خطأ في تنفيذ الإضافة: ${e.message}`;
  }
}

// ==================== منطق البوت ====================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  // طلب رمز الإقتران المكوّن من 8 أرقام إذا لم يكن الجهاز مسجلاً بعد
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(BOT_NUMBER.replace(/[^0-9]/g, ''));
        console.log('==================================');
        console.log('   رمز الإقتران الخاص بك هو: ', code);
        console.log('==================================');
      } catch (e) {
        console.error('فشل الحصول على رمز الإقتران:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log('[CONNECTION] انقطع الاتصال، إعادة المحاولة...');
        startBot();
      } else {
        console.log('[CONNECTION] تم تسجيل الخروج. احذف مجلد auth_info وأعد التشغيل للحصول على رمز جديد.');
      }
    } else if (connection === 'open') {
      console.log('[CONNECTION] تم الاتصال بنجاح ✅');
      loadAllPlugins();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;

    // فك تغليف الرسائل المؤقتة/الاختفاء قبل قراءة النص
    msg.message = unwrapMessage(msg.message);

    const from = msg.key.remoteJid;

    // إذا كانت الرسالة مرسلة من نفس رقم البوت (fromMe = true)، فإن المُرسل الحقيقي
    // هو حساب البوت نفسه وليس "remoteJid" (الذي يمثل الطرف الآخر في الشات).
    // بدون هذا التصحيح، إرسال الأوامر من نفس رقم البوت لا يُتعرّف عليه كأدمن أبداً.
    const sender = msg.key.fromMe
      ? sock.user?.id?.split(':')[0].split('@')[0] + '@s.whatsapp.net'
      : msg.key.participant || msg.key.remoteJid;

    const text = getMessageText(msg).trim();

    console.log(`[MSG] from=${from} sender=${sender} fromMe=${msg.key.fromMe} text="${text}"`);

    // نتجاهل أي رسالة لا تبدأ بالبريفكس (لا سلام، لا ضحك، لا أي كلام عادي)
    if (!text.startsWith(PREFIX)) return;

    const args = text.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    // كل الأوامر أدناه حصرية على الأدمن فقط
    if (!isAdmin(sender)) {
      console.log(`[AUTH] تم رفض الأمر "${command}" من ${sender} (ليس أدمن)`);
      return;
    }

    try {
      switch (command) {
        case 'add': {
          const fileName = args[0];
          if (!fileName) {
            await sock.sendMessage(
              from,
              { text: '❌ الاستخدام: .add اسم_الملف (بالرد على رسالة تحتوي الكود المراد حفظه)' },
              { quoted: msg }
            );
            return;
          }
          const code = extractQuotedText(msg);
          if (!code) {
            await sock.sendMessage(
              from,
              { text: '❌ يجب الرد (reply) على رسالة تحتوي الكود الذي تريد حفظه.' },
              { quoted: msg }
            );
            return;
          }
          const filePath = getPluginPath(fileName);
          const data = {
            name: fileName,
            code,
            addedBy: sender,
            addedAt: new Date().toISOString(),
          };
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
          loadedPlugins[fileName] = code;
          await sock.sendMessage(
            from,
            { text: `✅ تم حفظ وتحميل الملف: ${fileName}.json بنجاح.` },
            { quoted: msg }
          );
          break;
        }

        case 'clear': {
          const fileName = args[0];
          if (!fileName) {
            await sock.sendMessage(from, { text: '❌ الاستخدام: .clear اسم_الملف' }, { quoted: msg });
            return;
          }
          const filePath = getPluginPath(fileName);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            delete loadedPlugins[fileName];
            await sock.sendMessage(from, { text: `🗑️ تم حذف الملف: ${fileName}.json` }, { quoted: msg });
          } else {
            await sock.sendMessage(from, { text: `❌ الملف ${fileName}.json غير موجود.` }, { quoted: msg });
          }
          break;
        }

        case 'getall': {
          const files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.json'));
          if (files.length === 0) {
            await sock.sendMessage(from, { text: '📂 لا توجد أي ملفات محفوظة حاليًا.' }, { quoted: msg });
          } else {
            const list = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
            await sock.sendMessage(
              from,
              { text: `📂 الملفات المخزّنة (${files.length}):\n\n${list}` },
              { quoted: msg }
            );
          }
          break;
        }

        case 'addadmin': {
          if (args.length === 0) {
            await sock.sendMessage(
              from,
              { text: '❌ الاستخدام: .addadmin رقم_الهاتف\nمثال: .addadmin +212 775-925339' },
              { quoted: msg }
            );
            return;
          }
          const rawNumber = args.join(' ');
          const normalized = normalizePhoneNumber(rawNumber);
          if (!normalized || normalized.length < 8) {
            await sock.sendMessage(from, { text: `❌ رقم غير صالح: "${rawNumber}"` }, { quoted: msg });
            return;
          }
          const newJid = `${normalized}@s.whatsapp.net`;
          if (ADMIN_NUMBERS.includes(newJid)) {
            await sock.sendMessage(from, { text: `⚠️ الرقم ${normalized} أدمن بالفعل.` }, { quoted: msg });
            return;
          }
          ADMIN_NUMBERS.push(newJid);
          saveAdminNumbers();
          await sock.sendMessage(
            from,
            { text: `✅ تم إضافة ${normalized} كأدمن جديد بصلاحيات كاملة في التحكم بالبوت.` },
            { quoted: msg }
          );
          break;
        }

        case 'install': {
          if (args.length === 0) {
            await sock.sendMessage(
              from,
              { text: '❌ الاستخدام: .install اسم_المكتبة\nأو: .install npm install اسم1 اسم2 ...' },
              { quoted: msg }
            );
            return;
          }

          // نسمح بكتابة "npm install" أو "npm i" قبل أسماء المكتبات ونتجاهلها
          let pkgArgs = [...args];
          if (pkgArgs[0]?.toLowerCase() === 'npm') pkgArgs.shift();
          if (pkgArgs[0]?.toLowerCase() === 'install' || pkgArgs[0]?.toLowerCase() === 'i') pkgArgs.shift();

          if (pkgArgs.length === 0) {
            await sock.sendMessage(from, { text: '❌ لم تحدد أي اسم مكتبة بعد npm install.' }, { quoted: msg });
            return;
          }

          const packages = [];
          for (const raw of pkgArgs) {
            const clean = sanitizePackageName(raw);
            if (!clean || !isValidPackageName(clean)) {
              await sock.sendMessage(
                from,
                { text: `❌ اسم المكتبة غير صالح: "${raw}"\nتأكد من كتابته يدوياً بدون نسخ من رسالة أخرى (قد تحتوي حروفاً مخفية).` },
                { quoted: msg }
              );
              return;
            }
            packages.push(clean);
          }

          const pkgList = packages.join(', ');
          await sock.sendMessage(from, { text: `⏳ جاري تحميل المكتبات: ${pkgList} ...` }, { quoted: msg });
          exec(`npm install ${packages.join(' ')}`, { cwd: __dirname }, async (error) => {
            if (error) {
              await sock.sendMessage(
                from,
                { text: `❌ فشل تحميل المكتبات: ${pkgList}\n${error.message}` },
                { quoted: msg }
              );
            } else {
              await sock.sendMessage(from, { text: `✅ تم تحميل المكتبات بنجاح: ${pkgList}` }, { quoted: msg });
            }
          });
          break;
        }

        default: {
          // إذا كان الأمر مطابقاً لاسم إضافة محفوظة مسبقًا، يتم تنفيذها
          if (loadedPlugins[command]) {
            const result = runPlugin(loadedPlugins[command], { sock, msg, args, from, sender });
            if (result) await sock.sendMessage(from, { text: String(result) }, { quoted: msg });
          }
          // أي أمر غير معروف يُتجاهل تمامًا بدون أي رد
          break;
        }
      }
    } catch (e) {
      console.error('[COMMAND ERROR]', e);
    }
  });
}

startBot();
