const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';

// --- Database Management ---
let db = {
    defaultRouting: { type: 'folder', destination: '/5' },
    quickOptions: [
        { name: 'תמיכה טכנית', type: 'folder', destination: '/1' },
        { name: 'מחלקת מכירות', type: 'folder', destination: '/2' }
    ],
    contacts: {},
    callLogs: [],
    pendingCalls: []
};

if (fs.existsSync(DB_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DB_FILE));
        db = { ...db, ...savedData, pendingCalls: [] };
    } catch (e) { console.error("Error loading DB", e); }
}

function saveDB() {
    try {
        const dataToSave = { ...db, pendingCalls: [] };
        fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) { console.error("Error saving DB", e); }
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

let activePendingCalls = {};

function formatYemotResponse(type, destination) {
    let cmd = "";
    if (type === 'sip') {
        cmd = `routing_yemot=sip:${destination}`;
    } else if (type === 'folder') {
        const folderPath = destination.startsWith('/') ? destination : `/${destination}`;
        cmd = `go_to_folder=${folderPath}`;
    } else {
        cmd = `routing_yemot=${destination}`;
    }
    const msgText = "שלום. ברוכים הבאים לרחשי לב. אנחנו בודקים לאן להעביר אותך. אנא המתן.";
    const formattedMsg = msgText.replace(/ /g, "_");
    return `id_list_message=t-${formattedMsg}&${cmd}`;
}

function updatePendingList() {
    db.pendingCalls = Object.keys(activePendingCalls).map(id => ({
        id, phone: activePendingCalls[id].phone
    }));
}

app.all('/yemot_webhook', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || 'Unknown';
    
    if (db.contacts[apiPhone]) {
        const c = db.contacts[apiPhone];
        const response = formatYemotResponse(c.routeType, c.destination);
        db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: apiPhone, name: c.name, routeType: c.routeType, destination: c.destination });
        if(db.callLogs.length > 50) db.callLogs.pop();
        saveDB();
        return res.send(response);
    }

    const callId = Date.now().toString();
    const timeoutId = setTimeout(() => {
        if (activePendingCalls[callId]) {
            const pending = activePendingCalls[callId];
            delete activePendingCalls[callId];
            updatePendingList();
            const response = formatYemotResponse(db.defaultRouting.type, db.defaultRouting.destination);
            db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: 'Default Route', routeType: db.defaultRouting.type, destination: db.defaultRouting.destination });
            saveDB();
            pending.res.setHeader('Content-Type', 'text/html; charset=utf-8');
            pending.res.send(response);
        }
    }, 5500);

    activePendingCalls[callId] = { res, timeoutId, phone: apiPhone };
    updatePendingList();
});

app.get('/api/data', (req, res) => res.json(db));
app.post('/api/settings', (req, res) => { db.defaultRouting = req.body.defaultRouting; db.quickOptions = req.body.quickOptions; saveDB(); res.json({ success: true }); });
app.post('/api/contacts', (req, res) => { const { phone, name, routeType, destination } = req.body; db.contacts[phone] = { name, routeType, destination }; saveDB(); res.json({ success: true }); });
app.delete('/api/contacts/:phone', (req, res) => { delete db.contacts[req.params.phone]; saveDB(); res.json({ success: true }); });
app.post('/api/resolve_call', (req, res) => {
    const { id, type, destination, name } = req.body;
    if (activePendingCalls[id]) {
        const pending = activePendingCalls[id];
        clearTimeout(pending.timeoutId);
        const response = formatYemotResponse(type, destination);
        db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: `Manual: ${name}`, routeType: type, destination: destination });
        delete activePendingCalls[id];
        updatePendingList();
        saveDB();
        pending.res.setHeader('Content-Type', 'text/html; charset=utf-8');
        pending.res.send(response);
        res.json({ success: true });
    } else { res.json({ success: false }); }
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - CRM & Softphone</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jssip/3.10.1/jssip.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@200;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; background-color: #f1f5f9; color: #1e293b; }
        .section-card { background: white; border-radius: 1.5rem; border: 2px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); overflow: hidden; }
        
        /* High Contrast Inputs */
        .input-premium { 
            background: #ffffff; 
            border: 3px solid #cbd5e1; 
            border-radius: 1rem; 
            padding: 0.8rem 1.2rem; 
            width: 100%; 
            font-weight: 700; 
            color: #1e293b;
            transition: all 0.2s ease;
        }
        .input-premium:focus { 
            border-color: #6366f1; 
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1); 
            outline: none; 
        }

        .label-style { font-size: 0.75rem; font-weight: 800; color: #64748b; margin-bottom: 0.4rem; display: block; padding-right: 0.5rem; text-transform: uppercase; }

        .btn-main { background: #6366f1; color: white; border-radius: 1rem; padding: 0.8rem 1.5rem; font-weight: 800; transition: all 0.2s; cursor: pointer; text-align: center; }
        .btn-main:hover { background: #4f46e5; transform: translateY(-2px); box-shadow: 0 10px 15px rgba(99, 102, 241, 0.2); }
        
        .phone-key { width: 70px; height: 70px; border-radius: 1.2rem; background: #f8fafc; border: 2px solid #e2e8f0; display: flex; items-center; justify-center; font-size: 1.5rem; font-weight: 800; cursor: pointer; transition: all 0.1s; color: #475569; }
        .phone-key:active { background: #e2e8f0; transform: scale(0.9); }
        
        .log-display { font-family: monospace; font-size: 11px; background: #0f172a; color: #38bdf8; padding: 15px; height: 160px; overflow-y: auto; border-top: 4px solid #1e293b; }
        .toast-notify { position: fixed; bottom: 30px; left: 30px; z-index: 1000; padding: 1rem 2rem; border-radius: 1.25rem; color: white; font-weight: 800; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2); transform: translateX(-200%); transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
    </style>
</head>
<body class="p-4 md:p-8 lg:p-12">

    <div id="toast" class="toast-notify bg-indigo-600 uppercase tracking-widest">מערכת מוכנה</div>

    <!-- פופ-אפ שיחה נכנסת -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/95 z-[100] hidden items-center justify-center backdrop-blur-2xl transition-all duration-500">
        <div class="bg-white rounded-[4rem] shadow-2xl p-14 w-[36rem] text-center border-4 border-indigo-600 relative">
            <div class="absolute top-0 left-0 w-full h-4 bg-slate-100 rounded-t-[4rem] overflow-hidden"><div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div></div>
            <h3 class="text-3xl font-black text-slate-800 mb-4 italic tracking-tight">שיחה נכנסת ל"רחשי לב"</h3>
            <div id="popupPhone" class="text-7xl font-black text-indigo-600 mb-12 tracking-tighter" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-5 mb-10"></div>
            <div class="text-[12px] font-black uppercase text-slate-300 italic tracking-[0.2em]">Redirecting in <span id="popupTimer" class="text-indigo-600 text-2xl">5</span>s</div>
        </div>
    </div>

    <div class="max-w-7xl mx-auto">
        <!-- Dashboard Header -->
        <header class="flex flex-col lg:flex-row justify-between items-center mb-12 gap-8">
            <div class="flex items-center gap-6">
                <div class="bg-indigo-600 w-20 h-20 rounded-[2.2rem] flex items-center justify-center shadow-2xl shadow-indigo-200 rotate-6 hover:rotate-0 transition-transform duration-300">
                    <svg class="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </div>
                <div>
                    <h1 class="text-5xl font-black tracking-tighter text-slate-900 italic">רחשי לב</h1>
                    <p class="text-slate-400 font-bold uppercase text-[10px] tracking-[0.4em] mt-2">Intelligence CTI Control Panel</p>
                </div>
            </div>
            <div class="flex items-center gap-4 bg-white px-8 py-4 rounded-3xl border-2 border-slate-100 shadow-sm">
                <span id="sipStatusDot" class="w-4 h-4 bg-red-500 rounded-full shadow-inner"></span>
                <span id="sipStatusText" class="text-xs font-black text-slate-500 uppercase tracking-widest">SIP Disconnected</span>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-10">
            
            <!-- Left Panel: Connectivity & Dialer -->
            <div class="lg:col-span-4 space-y-8">
                
                <!-- SIP Phone Settings -->
                <section class="section-card border-slate-200 shadow-xl">
                    <div class="p-6 bg-slate-50 border-b border-slate-100"><h2 class="text-xs font-black text-slate-500 uppercase tracking-widest">טלפון פנימי (Web Phone)</h2></div>
                    <div class="p-8 space-y-5">
                        <div>
                            <label class="label-style text-indigo-600">SIP Extension / שם משתמש</label>
                            <input id="sipUser" placeholder="למשל: 101" class="input-premium">
                        </div>
                        <div>
                            <label class="label-style text-indigo-600">SIP Password / סיסמה</label>
                            <input id="sipPass" type="password" placeholder="••••••••" class="input-premium">
                        </div>
                        <button id="btnSipConnect" onclick="connectSIP()" class="btn-main w-full py-5 text-lg">התחבר למרכזייה</button>
                    </div>
                    <div id="sipLogs" class="log-display">ממתין לחיבור...</div>
                </section>

                <!-- DialPad -->
                <section class="section-card p-10 flex flex-col items-center border-slate-200">
                    <div id="dialDisplay" class="w-full text-center text-5xl font-black text-slate-900 mb-10 h-14 truncate tracking-tighter" dir="ltr"></div>
                    <div class="grid grid-cols-3 gap-5 mb-10">
                        <div onclick="dial('1')" class="phone-key">1</div><div onclick="dial('2')" class="phone-key">2</div><div onclick="dial('3')" class="phone-key">3</div>
                        <div onclick="dial('4')" class="phone-key">4</div><div onclick="dial('5')" class="phone-key">5</div><div onclick="dial('6')" class="phone-key">6</div>
                        <div onclick="dial('7')" class="phone-key">7</div><div onclick="dial('8')" class="phone-key">8</div><div onclick="dial('9')" class="phone-key">9</div>
                        <div onclick="dial('*')" class="phone-key text-indigo-600">*</div><div onclick="dial('0')" class="phone-key">0</div><div onclick="dial('#')" class="phone-key text-indigo-600">#</div>
                    </div>
                    <div class="flex gap-4 w-full">
                        <button id="btnCall" onclick="sipCall()" class="flex-1 bg-emerald-500 text-white font-black py-5 rounded-2xl shadow-xl text-xl hover:bg-emerald-600 transition">חיוג</button>
                        <button id="btnHangup" onclick="sipHangup()" class="hidden flex-1 bg-red-500 text-white font-black py-5 rounded-2xl shadow-xl text-xl hover:bg-red-600 transition">נתק</button>
                        <button onclick="clearDial()" class="w-24 bg-slate-100 text-slate-400 font-black py-5 rounded-2xl hover:bg-slate-200 transition uppercase text-xs">Clear</button>
                    </div>
                    <audio id="remoteAudio" autoplay></audio>
                </section>
            </div>

            <!-- Right Panel: CRM & Routing -->
            <div class="lg:col-span-8 space-y-10">
                
                <!-- Quick Bridge (CTI) -->
                <section class="section-card p-10 bg-slate-900 text-white border-none shadow-2xl">
                    <div class="flex flex-col md:flex-row gap-6 items-end">
                        <div class="flex-1 w-full">
                            <label class="text-[10px] font-black text-slate-500 mb-3 block uppercase tracking-[0.3em] italic">Quick Bridge Connection (CTI)</label>
                            <input id="bridgeTarget" placeholder="הזן מספר מחייג..." class="w-full bg-slate-800 border-2 border-slate-700 rounded-3xl p-5 text-white text-4xl font-black tracking-tight outline-none focus:border-indigo-500 transition" dir="ltr">
                        </div>
                        <button onclick="startBridgeCall()" class="btn-main bg-indigo-600 h-[84px] px-14 text-xl shadow-2xl shadow-indigo-500/30">בצע גשר</button>
                    </div>
                </section>

                <!-- Contacts Table -->
                <section class="section-card">
                    <div class="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/40">
                        <h2 class="text-2xl font-black tracking-tight">לקוחות וניתובים קבועים</h2>
                        <button onclick="document.getElementById('addContactArea').classList.toggle('hidden')" class="bg-white text-indigo-600 border-2 border-indigo-100 py-2.5 px-8 rounded-2xl text-[11px] font-black uppercase tracking-widest hover:bg-indigo-50 shadow-sm">Add New Contact</button>
                    </div>
                    <div id="addContactArea" class="hidden p-10 bg-indigo-50/20 border-b border-indigo-50 transition-all">
                        <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-4 gap-5">
                            <div><label class="label-style">שם לקוח</label><input id="cName" placeholder="ישראל ישראלי" class="input-premium text-sm"></div>
                            <div><label class="label-style">טלפון</label><input id="cPhone" placeholder="0500000000" class="input-premium text-sm font-mono" dir="ltr"></div>
                            <div><label class="label-style">סוג</label><select id="cType" class="input-premium text-sm"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select></div>
                            <div><label class="label-style">יעד</label><input id="cDest" placeholder="/5" class="input-premium text-sm font-mono" dir="ltr"></div>
                            <button type="submit" class="md:col-span-4 btn-main py-4 text-lg">שמור לקוח חדש</button>
                        </form>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-right">
                            <thead class="bg-slate-50 text-slate-400 font-black uppercase text-[10px] tracking-widest border-b">
                                <tr><th class="p-8 px-12">שם הלקוח</th><th class="p-8">טלפון</th><th class="p-8">ניתוב קבוע</th><th class="p-8 text-left">ניהול</th></tr>
                            </thead>
                            <tbody id="contactsList" class="divide-y divide-slate-100"></tbody>
                        </table>
                    </div>
                </section>

                <!-- System Config (Yemot API) -->
                <section class="section-card p-10">
                    <h2 class="text-xs font-black text-slate-400 uppercase mb-8 tracking-widest border-b pb-4">הגדרות מערכת ימות המשיח (Webhook API)</h2>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-12">
                        <div class="space-y-6">
                            <div><label class="label-style text-red-500 font-black italic">API Security Token</label><input id="globalToken" type="password" placeholder="Token..." class="input-premium"></div>
                            <div><label class="label-style">Your Bridge Extension</label><input id="mySipExt" type="number" placeholder="101" class="input-premium"></div>
                        </div>
                        <div class="space-y-6">
                            <div>
                                <label class="label-style">ברירת מחדל (לא מוכר)</label>
                                <div class="flex gap-2">
                                    <select id="defType" class="input-premium w-32 py-3 text-xs"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                                    <input id="defDest" placeholder="/5" class="input-premium py-3 text-sm font-mono">
                                </div>
                            </div>
                            <div>
                                <label class="label-style">כפתורי פופ-אפ</label>
                                <div class="grid grid-cols-2 gap-3 mt-1">
                                    <input id="q1Name" placeholder="שם 1" class="input-premium py-2 text-xs"><input id="q1Dest" placeholder="/1" class="input-premium py-2 text-xs font-mono">
                                    <input id="q2Name" placeholder="שם 2" class="input-premium py-2 text-xs"><input id="q2Dest" placeholder="/2" class="input-premium py-2 text-xs font-mono">
                                </div>
                            </div>
                        </div>
                    </div>
                    <button onclick="saveSettings()" class="w-full btn-main bg-slate-900 mt-12 py-5 uppercase tracking-widest">Update Cloud Settings</button>
                </section>

                <!-- Live Monitor -->
                <section class="section-card p-10 bg-slate-900 border-4 border-slate-800 shadow-2xl">
                    <h2 class="text-[11px] font-black text-slate-500 uppercase mb-8 tracking-[0.5em] flex justify-between items-center">
                        <span>Live Traffic Activity</span>
                        <div class="flex gap-1"><span class="w-2 h-2 bg-blue-500 rounded-full animate-pulse shadow-blue-500 shadow-lg"></span></div>
                    </h2>
                    <div id="logsArea" class="h-80 overflow-y-auto space-y-5 font-mono text-[13px]"></div>
                </section>
                
                <div class="bg-white p-8 rounded-[2.5rem] border-2 border-dashed border-slate-300 text-center">
                    <p class="text-[10px] font-black text-slate-400 uppercase mb-3 tracking-widest italic">Yemot Webhook Endpoint URL</p>
                    <code class="text-indigo-600 font-black bg-indigo-50 px-6 py-3 rounded-2xl text-sm" id="webhookUrl"></code>
                </div>
            </div>
        </div>
    </div>

    <script>
        function showToast(msg, isError = false) {
            const t = document.getElementById('toast');
            t.innerText = msg;
            t.style.backgroundColor = isError ? '#ef4444' : '#6366f1';
            t.style.transform = 'translateX(0)';
            setTimeout(() => { t.style.transform = 'translateX(-200%)'; }, 4500);
        }

        function addSipLog(msg, type = 'info') {
            const logEl = document.getElementById('sipLogs');
            const time = new Date().toLocaleTimeString();
            const colors = { error: '#ef4444', debug: '#94a3b8', info: '#38bdf8', success: '#22c55e' };
            logEl.innerHTML = \`[\${time}] <span style="color: \${colors[type] || '#fff'}">\${msg}</span><br>\` + logEl.innerHTML;
        }

        async function loadData() {
            try {
                const res = await fetch('/api/data');
                const data = await res.json();
                if(document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
                    document.getElementById('globalToken').value = localStorage.getItem('y_token') || '';
                    document.getElementById('mySipExt').value = localStorage.getItem('y_sip') || '';
                    document.getElementById('sipUser').value = localStorage.getItem('sip_user') || '';
                    document.getElementById('sipPass').value = localStorage.getItem('sip_pass') || '';
                    document.getElementById('defType').value = data.defaultRouting.type;
                    document.getElementById('defDest').value = data.defaultRouting.destination;
                    if(data.quickOptions[0]) { document.getElementById('q1Name').value = data.quickOptions[0].name; document.getElementById('q1Dest').value = data.quickOptions[0].destination; }
                    if(data.quickOptions[1]) { document.getElementById('q2Name').value = data.quickOptions[1].name; document.getElementById('q2Dest').value = data.quickOptions[1].destination; }
                }
                renderContacts(data.contacts);
                renderLogs(data.callLogs);
                handlePending(data.pendingCalls);
            } catch(e) {}
        }

        function renderContacts(contacts) {
            const list = document.getElementById('contactsList');
            list.innerHTML = '';
            for(let phone in contacts) {
                const c = contacts[phone];
                list.innerHTML += \`<tr class="hover:bg-indigo-50/50 transition"><td class="p-8 px-12 font-black text-2xl text-slate-800 tracking-tight">\${c.name}</td><td class="p-8 font-mono text-slate-400 text-xl tracking-tight">\${phone}</td><td class="p-8 text-indigo-600 font-black italic">\${c.routeType.toUpperCase()} &rarr; \${c.destination}</td><td class="p-8 text-left"><button onclick="deleteContact('\${phone}')" class="text-red-500 font-black hover:bg-red-50 p-3 rounded-xl transition uppercase text-[10px]">Delete</button></td></tr>\`;
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            area.innerHTML = logs.map(l => \`<div class="bg-white/5 p-5 rounded-3xl border border-white/5 flex justify-between items-center text-slate-400 group hover:border-indigo-500/30 transition-colors"><span class="text-[9px] font-black opacity-40 uppercase">\${l.time}</span><span class="text-white font-black text-lg tracking-tighter" dir="ltr">\${l.phone}</span><span class="text-emerald-400 font-black text-[11px] uppercase tracking-widest">&rarr; \${l.routeType}: \${l.destination}</span></div>\`).join('');
        }

        // --- SIP Logic (Hardcoded to Yemot WSS based on your image) ---
        let ua = null;
        let sipSession = null;

        function connectSIP() {
            const user = document.getElementById('sipUser').value;
            const pass = document.getElementById('sipPass').value;
            localStorage.setItem('sip_user', user); localStorage.setItem('sip_pass', pass);
            
            JsSIP.debug.enable('JsSIP:*');

            addSipLog("יוזם חיבור לשרת ימות המשיח...");
            const wss = "wss://sip.yemot.co.il/ws"; // Confirmed from Image
            
            const socket = new JsSIP.WebSocketInterface(wss);
            const configuration = { sockets: [socket], uri: \`sip:\${user}@sip.yemot.co.il\`, password: pass };

            try {
                ua = new JsSIP.UA(configuration);
                ua.on('connecting', () => addSipLog("מנסה להתחבר ל-WebSocket..."));
                ua.on('connected', () => addSipLog("WebSocket מחובר. מבצע Register...", "success"));
                ua.on('registered', () => {
                    addSipLog("השלוחה רשומה! הטלפון מוכן לשימוש.", "success");
                    document.getElementById('sipStatusDot').className = 'w-4 h-4 bg-green-500 rounded-full shadow-lg shadow-green-200';
                    document.getElementById('sipStatusText').innerText = 'SIP Online';
                    showToast("טלפון מחובר בהצלחה");
                });
                ua.on('registrationFailed', (e) => { addSipLog("רישום נכשל: " + e.cause, 'error'); showToast("חיבור SIP נכשל", true); });
                ua.on('newRTCSession', (data) => {
                    sipSession = data.session;
                    if(sipSession.direction === 'incoming') {
                        showToast("שיחה נכנסת!");
                        if(confirm('שיחה נכנסת לטלפון! לענות?')) { sipSession.answer({ mediaConstraints: { audio: true, video: false } }); }
                        else { sipSession.terminate(); }
                    }
                    sipSession.on('accepted', () => { document.getElementById('btnCall').classList.add('hidden'); document.getElementById('btnHangup').classList.remove('hidden'); const remoteStream = new MediaStream(); sipSession.connection.getReceivers().forEach(r => remoteStream.addTrack(r.track)); document.getElementById('remoteAudio').srcObject = remoteStream; });
                    sipSession.on('ended', () => resetSipUI());
                    sipSession.on('failed', (e) => { addSipLog("שיחה נכשלה: " + e.cause, 'error'); resetSipUI(); });
                });
                ua.start();
            } catch(err) { addSipLog("שגיאה: " + err.message, 'error'); }
        }

        function dial(n) { document.getElementById('dialDisplay').innerText += n; }
        function clearDial() { document.getElementById('dialDisplay').innerText = ''; }
        function resetSipUI() { document.getElementById('btnCall').classList.remove('hidden'); document.getElementById('btnHangup').classList.add('hidden'); sipSession = null; }
        function sipCall() { const dest = document.getElementById('dialDisplay').innerText; if(!ua || !ua.isRegistered()) return showToast('התחבר קודם', true); ua.call(\`sip:\${dest}@sip.yemot.co.il\`, { mediaConstraints: { audio: true, video: false } }); }
        function sipHangup() { if(sipSession) sipSession.terminate(); }

        // --- CRM Logic ---
        let activeCallId = null;
        let timerInterval = null;

        function handlePending(pending) {
            const popup = document.getElementById('incomingPopup');
            if(pending.length > 0) {
                const call = pending[0];
                if(activeCallId !== call.id) {
                    activeCallId = call.id;
                    document.getElementById('popupPhone').innerText = call.phone;
                    popup.classList.remove('hidden'); popup.classList.add('flex');
                    fetch('/api/data').then(r => r.json()).then(data => {
                        document.getElementById('popupButtons').innerHTML = data.quickOptions.map(opt => \`
                            <button onclick="resolveCall('\${call.id}', '\${opt.type}', '\${opt.destination}', '\${opt.name}')" 
                                    class="bg-indigo-600 text-white py-10 rounded-[3rem] font-black text-4xl hover:bg-indigo-700 shadow-2xl transition active:scale-95">
                                \${opt.name}
                            </button>
                        \`).join('');
                    });
                    let timeLeft = 50; clearInterval(timerInterval);
                    timerInterval = setInterval(() => { timeLeft--; document.getElementById('popupProgress').style.width = (timeLeft * 2) + '%'; document.getElementById('popupTimer').innerText = Math.ceil(timeLeft / 10); if(timeLeft <= 0) { clearInterval(timerInterval); popup.classList.add('hidden'); } }, 100);
                }
            } else { popup.classList.add('hidden'); activeCallId = null; clearInterval(timerInterval); }
        }

        async function resolveCall(id, type, dest, name) { document.getElementById('incomingPopup').classList.add('hidden'); await fetch('/api/resolve_call', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, type, destination: dest, name}) }); loadData(); }

        async function startBridgeCall() {
            const token = document.getElementById('globalToken').value;
            const mySip = document.getElementById('mySipExt').value;
            const target = document.getElementById('bridgeTarget').value;
            if(!token || !mySip || !target) return showToast('מלא טוקן, שלוחה ויעד', true);
            localStorage.setItem('y_token', token); localStorage.setItem('y_sip', mySip);
            const params = new URLSearchParams({ token, Phones: '0000000000', BridgePhones: target, DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0' });
            const res = await fetch(\`https://www.call2all.co.il/ym/api/CreateBridgeCall?\${params.toString()}\`);
            const data = await res.json();
            if(data.responseStatus === 'OK') showToast('שיחת גישור הוקמה!');
            else showToast('שגיאה: ' + data.message, true);
        }

        async function saveSettings() {
            const settings = {
                defaultRouting: { type: document.getElementById('defType').value, destination: document.getElementById('defDest').value },
                quickOptions: [
                    { name: document.getElementById('q1Name').value, type: 'folder', destination: document.getElementById('q1Dest').value },
                    { name: document.getElementById('q2Name').value, type: 'folder', destination: document.getElementById('q2Dest').value }
                ]
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
            showToast("הגדרות עודכנו בשרת"); loadData();
        }

        document.getElementById('addContactForm').addEventListener('submit', async (e) => { e.preventDefault(); const body = { name: document.getElementById('cName').value, phone: document.getElementById('cPhone').value, routeType: document.getElementById('cType').value, destination: document.getElementById('cDest').value }; await fetch('/api/contacts', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) }); e.target.reset(); loadData(); });
        async function deleteContact(p) { if(confirm('למחוק איש קשר זה?')) { await fetch(\`/api/contacts/\${p}\`, {method: 'DELETE'}); loadData(); } }
        
        document.getElementById('webhookUrl').innerText = window.location.origin + '/yemot_webhook';
        setInterval(loadData, 2000);
        loadData();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
