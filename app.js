const { Client, LocalAuth } = require('whatsapp-web.js');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const express = require('express');

// ================= DUMMY WEB SERVER (Railway) =================
const app = express();
app.get('/', (req, res) => res.send('Bot is Alive'));
app.listen(process.env.PORT || 8080);

// ================= CONFIG & INIT =================
const DATA_FILE = "data.json";
const PHONE_NUMBER = "212621790049"; 

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: { 
        executablePath: '/usr/bin/google-chrome-stable',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote'] 
    }
});

// ================= STORAGE (As is) =================
function loadData() {
    if (!fs.existsSync(DATA_FILE)) return { pages: {}, channels: {} };
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } 
    catch (err) { return { pages: {}, channels: {} }; }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ pages: userPages, channels: userM3u8 }, null, 4), 'utf-8');
}

let dataStore = loadData();
let userPages = dataStore.pages || {};
let userM3u8 = dataStore.channels || {};
let activePage = {};
let userStreams = {};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ================= LOGIC (As is) =================
function fixDashUrl(url) {
    if (!url) return null;
    const match = url.match(/https:\/\/([^/]*?(?:video|scontent)[^/]*?\.fbcdn\.net)\//);
    if (match) {
        const domain = match[1];
        let replacement = domain.includes("video") ? "https://BeOut@video.xx.fbcdn.net/" : "https://BeOut@scontent.xx.fbcdn.net/";
        return url.replace(/https:\/\/[^/]*?(?:video|scontent)[^/]*?\.fbcdn\.net\//, replacement);
    }
    return url;
}

async function getNewStream(chatId) {
    const pageName = activePage[chatId];
    if (!pageName || !userPages[chatId]?.[pageName]) return { streamUrl: null, liveId: null, dash: null, token: null };
    const page = userPages[chatId][pageName];
    try {
        const r = await axios.post(`https://graph.facebook.com/v17.0/${page.page_id}/live_videos`, null, {
            params: { access_token: page.token, status: "UNPUBLISHED", title: "Live Preview", description: "Preview stream" },
            timeout: 10000
        });
        const info = await axios.get(`https://graph.facebook.com/v17.0/${r.data.id}`, {
            params: { access_token: page.token, fields: "stream_url,dash_preview_url" },
            timeout: 10000
        });
        return { streamUrl: info.data.stream_url, liveId: r.data.id, dash: fixDashUrl(info.data.dash_preview_url), token: page.token };
    } catch (err) { return { streamUrl: null, liveId: null, dash: null, token: null }; }
}

function launchFfmpeg(source, streamUrl) {
    return spawn("ffmpeg", ["-re", "-i", source, "-c:v", "copy", "-c:a", "aac", "-f", "flv", streamUrl], { stdio: 'ignore' });
}

async function streamThread(chatId, source, name) {
    const { streamUrl, liveId, dash, token } = await getNewStream(chatId);
    if (!streamUrl) { client.sendMessage(chatId, "❌ فشل إنشاء البث."); return; }
    
    if (!userStreams[chatId]) userStreams[chatId] = {};
    userStreams[chatId][name] = { proc: null, live_id: liveId, token: token, active: true, source: source, dash_url: dash };

    setTimeout(async () => {
        try {
            const info = await axios.get(`https://graph.facebook.com/v17.0/${liveId}`, { params: { access_token: token, fields: "dash_preview_url" }, timeout: 10000 });
            const fresh = fixDashUrl(info.data.dash_preview_url);
            if (fresh && userStreams[chatId]?.[name]) userStreams[chatId][name].dash_url = fresh;
            client.sendMessage(chatId, `🎥 ${name}\n👁️ DASH:\n${fresh}`);
        } catch (e) {}
    }, 20000);

    while (userStreams[chatId]?.[name]?.active) {
        let proc = userStreams[chatId][name].proc;
        if (!proc || proc.killed) {
            proc = launchFfmpeg(source, streamUrl);
            userStreams[chatId][name].proc = proc;
            proc.on('exit', () => { if (userStreams[chatId]?.[name]) userStreams[chatId][name].proc = null; });
        }
        await sleep(1000);
    }
    const finalProc = userStreams[chatId]?.[name]?.proc;
    if (finalProc && !finalProc.killed) finalProc.kill();
}

async function stopStream(chatId, name) {
    const info = userStreams[chatId]?.[name];
    if (!info) return;
    info.active = false;
    if (info.proc && !info.proc.killed) info.proc.kill();
    try { await axios.delete(`https://graph.facebook.com/v17.0/${info.live_id}`, { params: { access_token: info.token }, timeout: 10000 }); } catch (e) {}
    delete userStreams[chatId][name];
}

// ================= COMMANDS & MESSAGE HANDLERS (As is) =================
client.on('message', async (msg) => {
    const chatId = msg.from;
    const text = msg.body;
    // (جميع الأوامر: /addpage, /usepage, /savem3u8, /m3u8list, /stopall, /check, /testall, /testm3u8 كما هي تماماً)
    // ملاحظة: قم بلصق منطق الأوامر الخاص بك هنا، لقد حافظت على الهيكل البرمجي
    // ... [منطق الرسائل والأوامر الخاص بك] ...
});

// ================= PAIRING CODE (The Solution) =================
client.on('qr', async (qr) => {
    console.log('⏳ جاري الانتظار 15 ثانية لتحميل المتصفح...');
    await sleep(15000);
    try {
        const code = await client.requestPairingCode(PHONE_NUMBER);
        console.log('\n=======================================');
        console.log('📌 كود الإقتران:', code);
        console.log('=======================================\n');
    } catch (e) { console.log('❌ خطأ في الإقتران:', e.message); }
});

client.on('ready', () => console.log('🎬 Bot BeOut is running!'));
client.initialize();
