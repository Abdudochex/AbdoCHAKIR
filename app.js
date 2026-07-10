const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
        auth: state,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    // التحقق من الاتصال قبل طلب الكود
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } 
        
        else if (connection === 'open') {
            console.log('✅ الاتصال مفتوح ومستقر!');
            
            // طلب الكود فقط بعد التأكد من أن الاتصال مفتوح
            if (!sock.authState.creds.registered) {
                try {
                    console.log("--- جاري طلب رمز الإقتران... ---");
                    const code = await sock.requestPairingCode('212621790049');
                    console.log("\n========================================");
                    console.log(`[!] رمز الإقتران الخاص بك: ${code}`);
                    console.log("========================================\n");
                } catch (e) {
                    console.log("فشل طلب الكود، الرجاء إعادة التشغيل.");
                }
            }
        }
    });

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
            exec(`npm install ${lib}`, (error) => {
                if (error) return sock.sendMessage(sender, { text: "❌ فشل التحميل." });
                sock.sendMessage(sender, { text: "✅ تم التحميل بنجاح." });
            });
        }
    });
}

startBot();
