const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const { exec } = require('child_process');
const pino = require('pino');

// قائمة الأرقام المسموح لها بالتحكم (الأدمن)
const ADMINS = ['212621790049@s.whatsapp.net', '212775925339@s.whatsapp.net'];

async function startBot() {
    // التأكد من وجود المجلدات الضرورية
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    if (!fs.existsSync('./plugins')) fs.mkdirSync('./plugins');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false 
    });

    // نظام الإقتران برمز 8 أرقام (يستخدم رقمك الأول للربط)
    if (!sock.authState.creds.registered) {
        const phoneNumber = '212621790049'; 
        setTimeout(async () => {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`رمز الإقتران الخاص بك هو: ${code}`);
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        // التحقق مما إذا كان المرسل أحد الأدمن
        const sender = m.key.remoteJid;
        if (!ADMINS.includes(sender)) return;

        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const args = text.split(' ');
        const command = args[0];

        // 1. أمر .add
        if (command === '.add') {
            const fileName = args[1];
            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
            if (fileName && quotedMsg) {
                fs.writeFileSync(`./plugins/${fileName}.json`, quotedMsg);
                sock.sendMessage(sender, { text: `✅ تم حفظ السكربت في ملف: ${fileName}.json` });
            }
        }

        // 2. أمر .clear
        else if (command === '.clear') {
            const fileName = args[1];
            if (fs.existsSync(`./plugins/${fileName}.json`)) {
                fs.unlinkSync(`./plugins/${fileName}.json`);
                sock.sendMessage(sender, { text: `🗑️ تم حذف الملف: ${fileName}.json` });
            }
        }

        // 3. أمر .getall
        else if (command === '.getall') {
            const files = fs.readdirSync('./plugins');
            const response = files.length > 0 ? `📁 الملفات الموجودة:\n- ${files.join('\n- ')}` : "لا توجد ملفات مخزنة.";
            sock.sendMessage(sender, { text: response });
        }

        // 4. أمر .install
        else if (command === '.install') {
            const lib = args[1];
            if (!lib) return;
            sock.sendMessage(sender, { text: `⏳ جاري تحميل المكتبة: ${lib}...` });
            exec(`npm install ${lib}`, (err) => {
                if (err) return sock.sendMessage(sender, { text: "❌ فشل تحميل المكتبة." });
                sock.sendMessage(sender, { text: "✅ تم تحميل المكتبة بنجاح." });
            });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') console.log('البوت يعمل الآن!');
        if (connection === 'close') startBot();
    });
}

startBot();
