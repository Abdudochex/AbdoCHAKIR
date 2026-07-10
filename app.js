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
        headless: true, 
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', 
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', 
            '--single-process', '--disable-gpu'
        ] 
    }
});

// ================= STORAGE MECHANISM =================
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

// ================= LOGIC =================
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

// ================= COMMANDS =================
client.on('message', async (msg) => {
    const chatId = msg.from;
    const text = msg.body;
    if (msg.hasMedia && msg.type === 'document') {
        const media = await msg.downloadMedia();
        if (media.filename?.toLowerCase().endsWith('.txt')) {
            const content = Buffer.from(media.data, 'base64').toString('utf-8');
            if (!userM3u8[chatId]) userM3u8[chatId] = {};
            content.split(/\r?\n/).forEach(line => {
                const parts = line.trim().split(/\s+(.+)/);
                if (parts.length >= 2 && parts[1].startsWith("http")) userM3u8[chatId][parts[0]] = parts[1].trim();
            });
            saveData();
            client.sendMessage(chatId, `💾 تم استيراد القنوات بنجاح.`);
        }
    } else if (text.startsWith('/addpage ')) {
        const p = text.split(/\s+/);
        if (!userPages[chatId]) userPages[chatId] = {};
        userPages[chatId][p[1]] = { page_id: p[2], token: p.slice(3).join(' ') };
        saveData();
        client.sendMessage(chatId, `✅ تم إضافة الصفحة ${p[1]}`);
    } else if (text.startsWith('/usepage ')) {
        activePage[chatId] = text.split(' ')[1];
        client.sendMessage(chatId, `🎯 الصفحة النشطة: ${activePage[chatId]}`);
    } else if (text === '/m3u8list') {
        const data = userM3u8[chatId] || {};
        client.sendMessage(chatId, "📺 القنوات:\n" + Object.keys(data).map(n => `- ${n}`).join('\n'));
    } else if (text === '/stopall') {
        for (const name of Object.keys(userStreams[chatId] || {})) { stopStream(chatId, name); client.sendMessage(chatId, `🛑 تم إيقاف: ${name}`); }
    } else if (text === '/testm3u8') {
        let report = "🧪 تقرير الفحص:\n";
        for (const [name, url] of Object.entries(userM3u8[chatId] || {})) {
            try { await axios.head(url, { timeout: 5000 }); report += `- ${name} -> شغال ✅\n`; } catch (e) { report += `- ${name} -> معطل ❌\n`; }
        }
        client.sendMessage(chatId, report);
    } else if (text && !text.startsWith('/')) {
        if (!activePage[chatId]) { client.sendMessage(chatId, "⚠️ اختر صفحة أولاً بـ /usepage"); return; }
        text.split(/\r?\n/).forEach(name => { if (userM3u8[chatId][name]) streamThread(chatId, userM3u8[chatId][name], name); });
    }
});

// ================= PAIRING & READY =================
client.on('qr', async (qr) => {
    console.log('⚠️ جاري محاولة تفعيل كود الإقتران...');
    try {
        const code = await client.requestPairingCode(PHONE_NUMBER);
        console.log('\n=======================================');
        console.log('📌 كود الإقتران الخاص بك هو:', code);
        console.log('=======================================\n');
    } catch (e) { console.error('❌ فشل طلب الكود.'); }
});

client.on('ready', () => console.log('🎬 Bot BeOut is running!'));
client.initialize().catch(err => { process.exit(1); });
