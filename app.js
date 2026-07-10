const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs');
const { exec } = require('child_process');
const pino = require('pino');

const ADMINS = ['212621790049@s.whatsapp.net', '212775925339@s.whatsapp.net'];

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    if (!fs.existsSync('./plugins')) fs.mkdirSync('./plugins');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Desktop'),
        // إضافة توقيت إضافي لضمان استقرار الإتصال
        connectTimeoutMs: 60000, 
    });

    sock.ev.on('creds.update', saveCreds);

    // نظام الإقتران مع تأخير متعمد ومضمون
    if (!state.creds.registered) {
        console.log("--- جاري تجهيز نظام الإقتران، يرجى الانتظار 10 ثوانٍ ---");
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const phoneNumber = '212621790049'; 
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log("\n========================================");
            console.log(`[!] رمز الإقتران الخاص بك: ${code}`);
            console.log("[!] هذا الرمز صالح لمدة دقيقة واحدة");
            console.log("========================================\n");
        } catch (err) {
            console.error("خطأ في توليد الكود، سيتم إعادة المحاولة بعد 10 ثوانٍ:", err);
            setTimeout(startBot, 10000);
        }
    }

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const sender = m.key.remoteJid;
        if (!ADMINS.includes(sender)) return;

        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const args = text.split(' ');
        const command = args[0];

        if (command === '.add') {
            const fileName = args[1];
            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
            if (fileName && quotedMsg) {
                fs.writeFileSync(`./plugins/${fileName}.json`, quotedMsg);
                sock.sendMessage(sender, { text: `✅ تم الحفظ: ${fileName}.json` });
            }
        } else if (command === '.clear') {
            const fileName = args[1];
            if (fs.existsSync(`./plugins/${fileName}.json`)) {
                fs.unlinkSync(`./plugins/${fileName}.json`);
                sock.sendMessage(sender, { text: `🗑️ تم الحذف: ${fileName}.json` });
            }
        } else if (command === '.getall') {
            const files = fs.readdirSync('./plugins');
            sock.sendMessage(sender, { text: files.length > 0 ? `📁 الملفات:\n- ${files.join('\n- ')}` : "لا توجد ملفات." });
        } else if (command === '.install') {
            const lib = args[1];
            if (!lib) return;
            sock.sendMessage(sender, { text: `⏳ جاري تحميل: ${lib}...` });
            exec(`npm install ${lib}`, (err) => {
                if (err) return sock.sendMessage(sender, { text: "❌ فشل التحميل." });
                sock.sendMessage(sender, { text: "✅ تم التحميل بنجاح." });
            });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ البوت متصل بنجاح!');
        }
    });
}

startBot().catch(err => {
    console.error("حدث خطأ فادح، إعادة التشغيل في 5 ثوانٍ...", err);
    setTimeout(startBot, 5000);
});
