// ================= AUTO INSTALLER ENGINE =================
const { execSync, spawn } = require('child_process');
const fs = require('fs');

const requiredPackages = ['whatsapp-web.js', 'axios', 'qrcode-terminal'];
let needsInstall = false;

for (const pkg of requiredPackages) {
    try {
        require.resolve(pkg);
    } catch (e) {
        needsInstall = true;
        console.log(`📦 جاري اكتشاف مكتبة ناقصة: ${pkg}`);
    }
}

if (needsInstall) {
    console.log("⏳ السكربت يقوم الآن بتثبيت المكتبات المطلوبة تلقائياً... يرجى الانتظار (قد يستغرق بضع دقائق).");
    try {
        execSync(`npm install ${requiredPackages.join(' ')}`, { stdio: 'inherit' });
        console.log("✅ تم التثبيت التلقائي بنجاح! جاري تشغيل البوت...");
    } catch (error) {
        console.error("❌ فشل التثبيت التلقائي. تأكد من اتصال السيرفر بالإنترنت أو امتلاكه صلاحيات npm.");
        process.exit(1);
    }
}

// ================= LOAD MODULES AFTER AUTO-INSTALL =================
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');

// ================= CONFIG =================
const DATA_FILE = "data.json";

// ⚠️ ضع رقم هاتفك هنا مع رمز الدولة وبدون علامة الزائد (+)
// مثال: "201012345678" أو "212612345678"
const PHONE_NUMBER = "212621790049"; 

// تهيئة عميل واتساب ليتوافق مع السيرفرات (سيقوم بتحميل متصفحه تلقائياً)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    }
});

// ================= STORAGE & JSON MECHANISM =================
function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        return { pages: {}, channels: {} };
    }
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf-8');
        return JSON.parse(rawData);
    } catch (err) {
        return { pages: {}, channels: {} };
    }
}

function saveData() {
    const data = {
        pages: userPages,
        channels: userM3u8
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 4), 'utf-8');
}

let dataStore = loadData();
let userPages = dataStore.pages || {};
let userM3u8 = dataStore.channels || {};

let activePage = {};
let userStreams = {};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ================= REGEX DASH FIX =================
function fixDashUrl(url) {
    if (!url) return null;
    const match = url.match(/https:\/\/([^/]*?(?:video|scontent)[^/]*?\.fbcdn\.net)\//);
    if (match) {
        const domain = match[1];
        let replacement = domain.includes("video") 
            ? "https://BeOut@video.xx.fbcdn.net/" 
            : "https://BeOut@scontent.xx.fbcdn.net/";
        return url.replace(/https:\/\/[^/]*?(?:video|scontent)[^/]*?\.fbcdn\.net\//, replacement);
    }
    return url;
}

// ================= FACEBOOK GRAPH API =================
async function getNewStream(chatId) {
    const pageName = activePage[chatId];
    if (!pageName) return { streamUrl: null, liveId: null, dash: null, token: null };

    const page = userPages[chatId][pageName];

    try {
        const r = await axios.post(`https://graph.facebook.com/v17.0/${page.page_id}/live_videos`, null, {
            params: {
                access_token: page.token,
                status: "UNPUBLISHED",
                title: "Live Preview",
                description: "Preview stream"
            },
            timeout: 10000
        });

        if (!r.data || !r.data.id) return { streamUrl: null, liveId: null, dash: null, token: null };

        const liveId = r.data.id;
        const info = await axios.get(`https://graph.facebook.com/v17.0/${liveId}`, {
            params: {
                access_token: page.token,
                fields: "stream_url,dash_preview_url"
            },
            timeout: 10000
        });

        return {
            streamUrl: info.data.stream_url,
            liveId: liveId,
            dash: fixDashUrl(info.data.dash_preview_url),
            token: page.token
        };
    } catch (err) {
        return { streamUrl: null, liveId: null, dash: null, token: null };
    }
}

// ================= FFMPEG ENGINE =================
function launchFfmpeg(source, streamUrl) {
    return spawn("ffmpeg", [
        "-re",
        "-i", source,
        "-c:v", "copy",
        "-c:a", "aac",
        "-f", "flv",
        streamUrl
    ], { stdio: 'ignore' });
}

// ================= STREAM THREAD =================
async function streamThread(chatId, source, name) {
    const { streamUrl, liveId, dash, token } = await getNewStream(chatId);
    if (!streamUrl) {
        client.sendMessage(chatId, "❌ فشل إنشاء البث.");
        return;
    }

    if (!userStreams[chatId]) userStreams[chatId] = {};
    
    userStreams[chatId][name] = {
        proc: null,
        live_id: liveId,
        token: token,
        active: true,
        source: source,
        dash_url: dash
    };

    setTimeout(async () => {
        try {
            const info = await axios.get(`https://graph.facebook.com/v17.0/${liveId}`, {
                params: { access_token: token, fields: "dash_preview_url" },
                timeout: 10000
            });
            const fresh = fixDashUrl(info.data.dash_preview_url);
            if (fresh) {
                if (userStreams[chatId] && userStreams[chatId][name]) {
                    userStreams[chatId][name].dash_url = fresh;
                }
                client.sendMessage(chatId, `🎥 ${name}\n👁️ DASH:\n${fresh}`);
            }
        } catch (e) {}
    }, 20000);

    while (userStreams[chatId] && userStreams[chatId][name] && userStreams[chatId][name].active) {
        let proc = userStreams[chatId][name].proc;

        if (!proc || proc.killed) {
            proc = launchFfmpeg(source, streamUrl);
            userStreams[chatId][name].proc = proc;
            
            proc.on('exit', () => {
                if (userStreams[chatId] && userStreams[chatId][name]) {
                    userStreams[chatId][name].proc = null;
                }
            });
        }
        await sleep(1000);
    }

    const finalProc = userStreams[chatId]?.[name]?.proc;
    if (finalProc && !finalProc.killed) {
        finalProc.kill();
    }
}

// ================= STOP STREAM FUNCTION =================
async function stopStream(chatId, name) {
    const info = userStreams[chatId]?.[name];
    if (!info) return;

    info.active = false;

    try {
        if (info.proc && !info.proc.killed) {
            info.proc.kill();
        }
        await axios.delete(`https://graph.facebook.com/v17.0/${info.live_id}`, {
            params: { access_token: info.token },
            timeout: 10000
        });
    } catch (e) {}

    if (userStreams[chatId] && userStreams[chatId][name]) {
        delete userStreams[chatId][name];
    }
}

// ================= COMMANDS & MESSAGE HANDLERS =================
client.on('message', async (msg) => {
    const chatId = msg.from;
    const text = msg.body;

    if (msg.hasMedia && msg.type === 'document') {
        const media = await msg.downloadMedia();
        if (media && media.filename && media.filename.toLowerCase().endsWith('.txt')) {
            const content = Buffer.from(media.data, 'base64').toString('utf-8');
            
            if (!userM3u8[chatId]) userM3u8[chatId] = {};
            let count = 0;
            
            const lines = content.split(/\r?\n/);
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                
                const parts = line.split(/\s+(.+)/);
                if (parts.length >= 2) {
                    const name = parts[0];
                    const url = parts[1].trim();
                    if (url.startsWith("http")) {
                        userM3u8[chatId][name] = url;
                        count++;
                    }
                }
            }
            saveData();
            client.sendMessage(chatId, `💾 تم استيراد ${count} قناة بنجاح..`);
            return;
        }
    }

    if (!text) return;

    if (text.startsWith('/addpage ')) {
        const parts = text.split(/\s+/);
        if (parts.length < 4) {
            client.sendMessage(chatId, "⚠️ الصيغة: /addpage الاسم ID التوكن");
            return;
        }
        const name = parts[1];
        const pageId = parts[2];
        const token = parts.slice(3).join(' ');

        if (!userPages[chatId]) userPages[chatId] = {};
        userPages[chatId][name] = { page_id: pageId, token: token };
        saveData();
        client.sendMessage(chatId, `✅ تم إضافة الصفحة ${name} بنجاح.`);
        return;
    }

    if (text.startsWith('/usepage ')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) return;
        const name = parts[1];

        if (!userPages[chatId] || !userPages[chatId][name]) {
            client.sendMessage(chatId, "❌ الصفحة غير موجودة");
            return;
        }
        activePage[chatId] = name;
        client.sendMessage(chatId, `🎯 الصفحة النشطة الآن: ${name}`);
        return;
    }

    if (text.startsWith('/savem3u8 ')) {
        const parts = text.split(/\s+/);
        if (parts.length < 3) {
            client.sendMessage(chatId, "⚠️ الصيغة: /savem3u8 الاسم الرابط");
            return;
        }
        const name = parts[1];
        const url = parts[2];

        if (!userM3u8[chatId]) userM3u8[chatId] = {};
        userM3u8[chatId][name] = url;
        saveData();
        client.sendMessage(chatId, `💾 تم حفظ القناة: ${name}`);
        return;
    }

    if (text === '/m3u8list') {
        const data = userM3u8[chatId];
        if (!data || Object.keys(data).length === 0) {
            client.sendMessage(chatId, "❌ قائمة القنوات فارغة..");
            return;
        }
        let txt = "📺 القنوات المحفوظة:\n";
        for (const n in data) {
            txt += `- ${n}\n`;
        }
        client.sendMessage(chatId, txt);
        return;
    }

    if (text === '/stopall') {
        const streams = userStreams[chatId];
        if (!streams || Object.keys(streams).length === 0) {
            client.sendMessage(chatId, "❌ لا توجد بثوث نشطة");
            return;
        }
        
        for (const name of Object.keys(streams)) {
            stopStream(chatId, name);
            client.sendMessage(chatId, `🛑 تم إيقاف: ${name}`);
        }
        client.sendMessage(chatId, "🛑 تم تنظيف الرام وإيقاف جميع العمليات..");
        return;
    }

    if (text === '/check') {
        const pages = userPages[chatId] || {};
        if (Object.keys(pages).length === 0) {
            client.sendMessage(chatId, "❌ لا توجد صفحات مسجلة لفحصها.");
            return;
        }
        
        let report = "📋 تقرير فحص التوكنات:\n";
        for (const [name, info] of Object.entries(pages)) {
            try {
                const r = await axios.get(`https://graph.facebook.com/v17.0/${info.page_id}`, {
                    params: { access_token: info.token, fields: "name" },
                    timeout: 10000
                });
                if (r.status === 200) {
                    report += `✅ ${name}: هذا التوكن شغال\n`;
                } else {
                    report += `❌ ${name}: هذا التوكن غير صالح\n`;
                }
            } catch (e) {
                report += `❌ ${name}: هذا التوكن غير صالح\n`;
            }
        }
        client.sendMessage(chatId, report);
        return;
    }

    if (text === '/testall') {
        const streams = userStreams[chatId] || {};
        if (Object.keys(streams).length === 0) {
            client.sendMessage(chatId, "❌ لا توجد قنوات تبث حالياً لفحصها.");
            return;
        }
        
        let report = "🧪 *فحص روابط DASH للبثوث النشطة:*\n\n";
        for (const [name, info] of Object.entries(streams)) {
            const dashUrl = info.dash_url;
            if (!dashUrl) {
                report += `⚪️ *${name}*: لا يوجد رابط DASH لهذا البث.\n`;
                continue;
            }
            try {
                const res = await axios.get(dashUrl, { timeout: 10000 });
                if (res.status === 200) {
                    report += `✅ *${name}*: رابط DASH يعمل بنجاح.\n`;
                } else {
                    report += `❌ *${name}*: رابط DASH لا يعمل (Error ${res.status}).\n`;
                }
            } catch (e) {
                report += `❌ *${name}*: رابط DASH متعطل (خطأ اتصال).\n`;
            }
        }
        client.sendMessage(chatId, report);
        return;
    }

    if (text === '/testm3u8') {
        const channels = userM3u8[chatId] || {};
        if (Object.keys(channels).length === 0) {
            client.sendMessage(chatId, "❌ قائمة القنوات فارغة..");
            return;
        }
        
        await client.sendMessage(chatId, "⏳ جاري فحص الروابط المحفوظة...");
        let report = "🧪 تقرير فحص القنوات المحفوظة:\n";
        
        for (const [name, url] of Object.entries(channels)) {
            let linkType = "URL";
            if (url.toLowerCase().includes(".m3u8")) linkType = "M3U8";
            else if (url.toLowerCase().includes(".mpd")) linkType = "MPD";
            
            let status = "";
            try {
                const res = await axios.head(url, { timeout: 5000, maxRedirects: 5 });
                if (res.status >= 200 && res.status < 400) {
                    status = "شغال ✅";
                } else {
                    status = `خطأ (${res.status}) ❌`;
                }
            } catch (e) {
                status = "غير مستجيب ❌";
            }
            report += `- ${name} (${linkType}) -> ${status}\n`;
        }
        client.sendMessage(chatId, report);
        return;
    }

    if (text.startsWith('/')) return;

    if (!activePage[chatId]) {
        client.sendMessage(chatId, "⚠️ اختر صفحة أولاً باستخدام /usepage.");
        return;
    }

    const saved = userM3u8[chatId] || {};
    let started = 0;
    let notFound = false;

    const lines = text.split(/\r?\n/);
    for (let name of lines) {
        name = name.trim();
        if (!name) continue;
        
        if (saved[name]) {
            if (userStreams[chatId] && userStreams[chatId][name]) {
                client.sendMessage(chatId, `⚠️ البث '${name}' قيد التشغيل بالفعل.`);
                continue;
            }
            streamThread(chatId, saved[name], name);
            started++;
        } else {
            notFound = true;
        }
    }

    if (started === 0 && notFound) {
        client.sendMessage(chatId, "❌ لم يتم العثور على اسم قناة مطابق.");
    }
});

// ================= WHATSAPP EVENTS & PAIRING =================
client.on('qr', async (qr) => {
    console.log('⏳ جاري طلب كود الإقتران المكون من 8 أرقام...');
    try {
        const pairingCode = await client.requestPairingCode(PHONE_NUMBER);
        console.log('\n=======================================');
        console.log('📌 كود الإقتران الخاص بك هو:');
        console.log(`\x1b[32m${pairingCode}\x1b[0m`); 
        console.log('💡 افتح واتساب في هاتفك > الأجهزة المرتبطة > ربط برقم الهاتف، وأدخل هذا الكود.');
        console.log('=======================================\n');
    } catch (err) {
        console.error('❌ حدث خطأ أثناء طلب كود الإقتران. تأكد من صحة رقمك:', err.message);
    }
});

client.on('ready', () => {
    console.log('🎬 Bot BeOut is running on WhatsApp ...');
    client.sendMessage(`${PHONE_NUMBER}@c.us`, '✅ تم تفعيل البوت بنجاح! السكربت جاهز لاستقبال الأوامر عبر هذه المحادثة.');
});

// ================= RUN =================
client.initialize();
