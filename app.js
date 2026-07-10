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
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '212775925339,212621790049')
  .split(',')
  .map((n) => n.trim() + '@s.whatsapp.net');

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
    if (!msg?.message || msg.key.fromMe) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    const text = getMessageText(msg).trim();
    const from = msg.key.remoteJid;

    // نتجاهل أي رسالة لا تبدأ بالبريفكس (لا سلام، لا ضحك، لا أي كلام عادي)
    if (!text.startsWith(PREFIX)) return;

    const args = text.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    // كل الأوامر أدناه حصرية على الأدمن فقط
    if (!isAdmin(sender)) return;

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

        case 'install': {
          const pkg = args[0];
          if (!pkg) {
            await sock.sendMessage(from, { text: '❌ الاستخدام: .install اسم_المكتبة' }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: `⏳ جاري تحميل المكتبة: ${pkg} ...` }, { quoted: msg });
          exec(`npm install ${pkg}`, { cwd: __dirname }, async (error) => {
            if (error) {
              await sock.sendMessage(
                from,
                { text: `❌ فشل تحميل المكتبة: ${pkg}\n${error.message}` },
                { quoted: msg }
              );
            } else {
              await sock.sendMessage(from, { text: `✅ تم تحميل المكتبة بنجاح: ${pkg}` }, { quoted: msg });
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
