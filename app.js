const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');

// ================= DUMMY WEB SERVER =================
const app = express();
const PORT = process.env.PORT || 8080;
app.get('/', (req, res) => res.send('✅ Bot is running!'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Dummy Web Server is listening on port ${PORT}`));

// ================= CONFIG & STORAGE =================
const DATA_FILE = "data.json";
const PHONE_NUMBER = "212621790049"; 

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

// ================= CLIENT INIT =================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: { 
        executablePath: '/usr/bin/google-chrome-stable',
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    }
});

// ================= CORE LOGIC =================
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// ================= BOT COMMANDS =================
client.on('message', async (msg) => {
    const chatId = msg.from;
    const text = msg.body;
    
    // استيراد الملفات
    if (msg.hasMedia && msg.type === 'document') {
        const media = await msg.downloadMedia();
        if (media.filename.endsWith('.txt')) {
            const content = Buffer.from(media.data, 'base64').toString('utf-8');
            if (!userM3u8[chatId]) userM3u8[chatId] = {};
            content.split('\n').forEach(line => {
                const parts = line.split(' ');
                if (parts.length >= 2) userM3u8[chatId][parts[0]] = parts[1];
            });
            saveData();
            client.sendMessage(chatId, "💾 تم الاستيراد.");
        }
    }

    // الأوامر الأساسية
    if (text.startsWith('/addpage ')) {
        const parts = text.split(' ');
        userPages[chatId] = userPages[chatId] || {};
        userPages[chatId][parts[1]] = { page_id: parts[2], token: parts[3] };
        saveData();
        client.sendMessage(chatId, "✅ تم الحفظ.");
    }
});

// ================= PAIRING & READY =================
client.on('qr', async () => {
    try {
        const pairingCode = await client.requestPairingCode(PHONE_NUMBER);
        console.log('📌 كود الإقتران:', pairingCode);
    } catch (e) { console.log(e); }
});

client.on('ready', () => console.log('✅ Bot Ready!'));
client.initialize();
