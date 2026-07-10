const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');

// ================= DUMMY WEB SERVER =================
const app = express();
const PORT = process.env.PORT || 8080;
app.get('/', (req, res) => res.send('✅ WhatsApp Bot is Running Successfully!'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Dummy Web Server is listening on port ${PORT}`));

// ================= CONFIG =================
const DATA_FILE = "data.json";
const PHONE_NUMBER = "212621790049"; 

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: { 
        executablePath: '/usr/bin/google-chrome-stable',
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    }
});

// ================= STORAGE & JSON =================
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

// ================= FUNCTIONS =================
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
    if (!pageName || !userPages[chatId][pageName]) return { streamUrl: null };
    const page = userPages[chatId][pageName];
    try {
        const r = await axios.post(`https://graph.facebook.com/v17.0/${page.page_id}/live_videos`, null, {
            params: { access_token: page.token, status: "UNPUBLISHED", title: "Live", description: "Stream" },
            timeout: 10000
        });
        const info = await axios.get(`https://graph.facebook.com/v17.0/${r.data.id}`, {
            params: { access_token: page.token, fields: "stream_url,dash_preview_url" },
            timeout: 10000
        });
        return { streamUrl: info.data.stream_url, liveId: r.data.id, dash: fixDashUrl(info.data.dash_preview_url), token: page.token };
    } catch (err) { return { streamUrl: null }; }
}

function launchFfmpeg(source, streamUrl) {
    return spawn("ffmpeg", ["-re", "-i", source, "-c:v", "copy", "-c:a", "aac", "-f", "flv", streamUrl], { stdio: 'ignore' });
}

async function streamThread(chatId, source, name) {
    const { streamUrl, liveId, dash, token } = await getNewStream(chatId);
    if (!streamUrl) { client.sendMessage(chatId, "❌ فشل إنشاء البث."); return; }
    if (!userStreams[chatId]) userStreams[chatId] = {};
    userStreams[chatId][name] = { proc: null, live_id: liveId, token: token, active: true };
    
    while (userStreams[chatId][name]?.active) {
        let proc = userStreams[chatId][name].proc;
        if (!proc || proc.killed) {
            proc = launchFfmpeg(source, streamUrl);
            userStreams[chatId][name].proc = proc;
        }
        await sleep(2000);
    }
}

// ================= BOT COMMANDS =================
client.on('message', async (msg) => {
    const chatId = msg.from;
    const text = msg.body;
    // (باقي أوامرك الأصلية هنا)
    if (text.startsWith('/addpage ')) { /* ... منطقك الأصلي ... */ }
    // ... إلخ
});

// ================= CONNECTION & PAIRING =================
client.on('qr', async () => {
    console.log('⏳ جاري طلب كود الإقتران الرقمي...');
    try {
        const pairingCode = await client.requestPairingCode(PHONE_NUMBER);
        console.log('\n=======================================');
        console.log('📌 كود الإقتران الخاص بك هو:', pairingCode);
        console.log('💡 افتح الواتساب > الأجهزة المرتبطة > ربط برقم الهاتف > أدخل الكود.');
        console.log('=======================================\n');
    } catch (err) { console.error('❌ تعذر طلب كود الإقتران:', err.message); }
});

client.on('ready', () => {
    console.log('✅ Bot is ready and connected!');
    client.sendMessage(`${PHONE_NUMBER}@c.us`, '✅ البوت متصل وجاهز للعمل.');
});

client.initialize();
