const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';

// --- ניהול מסד נתונים ---
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

// טעינה מהקובץ
if (fs.existsSync(DB_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DB_FILE));
        db = { ...db, ...savedData, pendingCalls: [] };
    } catch (e) { console.error("שגיאה בטעינת מסד הנתונים", e); }
}

function saveDB() {
    try {
        const dataToSave = { ...db, pendingCalls: [] };
        fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) { console.error("שגיאה בשמירת מסד הנתונים", e); }
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

let activePendingCalls = {};

// פורמט תגובה לימות המשיח
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

// ==========================================
// 1. Webhook - שיחה נכנסת
// ==========================================
app.all('/yemot_webhook', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || 'חסוי';
    
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
            db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: 'העברה אוטומטית', routeType: db.defaultRouting.type, destination: db.defaultRouting.destination });
            saveDB();
            pending.res.setHeader('Content-Type', 'text/html; charset=utf-8');
            pending.res.send(response);
        }
    }, 5500);

    activePendingCalls[callId] = { res, timeoutId, phone: apiPhone };
    updatePendingList();
});

// ==========================================
// 2. API פנימי
// ==========================================
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
        db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: `ניתוב: ${name}`, routeType: type, destination: destination });
        delete activePendingCalls[id];
        updatePendingList();
        saveDB();
        pending.res.setHeader('Content-Type', 'text/html; charset=utf-8');
        pending.res.send(response);
        res.json({ success: true });
    } else { res.json({ success: false }); }
});

// ==========================================
// 3. ממשק ניהול משולב - הכל במסך אחד
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - ניהול תקשורת משולב</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jssip/3.10.1/jssip.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@200;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; background-color: #f1f5f9; color: #1e293b; }
        .card { background: white; border-radius: 1.5rem; border: 2px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        .input-field { background: #ffffff; border: 2px solid #cbd5e1; border-radius: 0.75rem; padding: 0.6rem 1rem; width: 100%; font-weight: 600; outline: none; transition: border-color 0.2s; }
        .input-field:focus { border-color: #6366f1; }
        .btn-blue { background: #6366f1; color: white; border-radius: 0.75rem; padding: 0.6rem 1.2rem; font-weight: 800; transition: all 0.2s; cursor: pointer; }
        .btn-blue:hover { background: #4f46e5; transform: translateY(-1px); }
        .phone-key { width: 60px; height: 60px; border-radius: 1rem; background: #f8fafc; border: 1px solid #e2e8f0; display: flex; items-center; justify-center; font-size: 1.2rem; font-weight: 800; cursor: pointer; transition: all 0.1s; }
        .phone-key:active { background: #e2e8f0; transform: scale(0.9); }
        .sip-log { font-family: monospace; font-size: 10px; background: #0f172a; color: #94a3b8; padding: 10px; border-radius: 0.5rem; height: 100px; overflow-y: auto; }
    </style>
</head>
<body class="p-4 md:p-8">

    <!-- פופ-אפ שיחה נכנסת -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/90 z-[100] hidden items-center justify-center backdrop-blur-md">
        <div class="bg-white rounded-[3rem] shadow-2xl p-10 w-[30rem] text-center border-4 border-indigo-600">
            <div class="absolute top-0 left-0 w-full h-3 bg-slate-100"><div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div></div>
            <h3 class="text-2xl font-black text-slate-800 mb-6">שיחה נכנסת ל"רחשי לב"</h3>
            <div id="popupPhone" class="text-5xl font-black text-indigo-600 mb-10 tracking-tighter" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-4 mb-4"></div>
            <div class="text-[10px] font-bold text-slate-400 uppercase">ניתוב אוטומטי בעוד <span id="popupTimer">5</span> שניות</div>
        </div>
    </div>

    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <header class="flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
            <div class="flex items-center gap-4">
                <div class="bg-indigo-600 p-3 rounded-2xl shadow-lg"><svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg></div>
                <h1 class="text-3xl font-black tracking-tight">רחשי לב - ניהול מרכזייה</h1>
            </div>
            <div class="flex items-center gap-2 bg-white px-4 py-2 rounded-full border shadow-sm">
                <span id="sipStatusDot" class="w-3 h-3 bg-red-500 rounded-full"></span>
                <span id="sipStatusText" class="text-xs font-bold text-slate-500 uppercase">SIP Disconnected</span>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            <!-- Left Column: Settings & SIP -->
            <div class="lg:col-span-4 space-y-6">
                <!-- 1. הגדרות מערכת (טוקן ושלוחה) -->
                <section class="card p-6 border-indigo-100 bg-indigo-50/30">
                    <h2 class="text-sm font-black text-indigo-900 uppercase mb-4 tracking-widest">הגדרות חיבור ימות המשיח</h2>
                    <div class="space-y-3">
                        <div>
                            <label class="text-[10px] font-bold text-slate-400 mr-2">TOKEN (טוקן מערכת)</label>
                            <input id="globalToken" type="password" placeholder="הכנס טוקן כאן..." class="input-field">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-slate-400 mr-2">MY SIP (שלוחת ה-SIP שלך בגישור)</label>
                            <input id="mySipExt" type="number" placeholder="למשל 101" class="input-field">
                        </div>
                    </div>
                </section>

                <!-- 2. הגדרות טלפון SIP פנימי -->
                <section class="card p-6">
                    <h2 class="text-sm font-black text-slate-400 uppercase mb-4 tracking-widest">חשבון טלפון SIP (לשימוש בדפדפן)</h2>
                    <div class="space-y-3 mb-4">
                        <input id="sipUser" placeholder="שם משתמש (User)" class="input-field text-sm">
                        <input id="sipPass" type="password" placeholder="סיסמה (Password)" class="input-field text-sm">
                        <input id="sipDomain" placeholder="דומיין (sip.call2all.co.il)" class="input-field text-sm">
                        <button id="btnSipConnect" onclick="connectSIP()" class="btn-blue w-full">התחבר למרכזייה</button>
                    </div>
                    <div id="sipLogs" class="sip-log">ממתין לפעולת התחברות...</div>
                </section>

                <!-- 3. לוח מקשים (Dialer) -->
                <section class="card p-6 flex flex-col items-center">
                    <div id="dialDisplay" class="w-full text-center text-3xl font-black text-indigo-600 mb-6 h-10 truncate" dir="ltr"></div>
                    <div class="grid grid-cols-3 gap-3 mb-6">
                        <div onclick="dial('1')" class="phone-key">1</div><div onclick="dial('2')" class="phone-key">2</div><div onclick="dial('3')" class="phone-key">3</div>
                        <div onclick="dial('4')" class="phone-key">4</div><div onclick="dial('5')" class="phone-key">5</div><div onclick="dial('6')" class="phone-key">6</div>
                        <div onclick="dial('7')" class="phone-key">7</div><div onclick="dial('8')" class="phone-key">8</div><div onclick="dial('9')" class="phone-key">9</div>
                        <div onclick="dial('*')" class="phone-key">*</div><div onclick="dial('0')" class="phone-key">0</div><div onclick="dial('#')" class="phone-key">#</div>
                    </div>
                    <div class="flex gap-2 w-full">
                        <button id="btnCall" onclick="sipCall()" class="flex-1 bg-emerald-500 text-white font-bold py-3 rounded-xl shadow-lg shadow-emerald-100">חיוג</button>
                        <button id="btnHangup" onclick="sipHangup()" class="hidden flex-1 bg-red-500 text-white font-bold py-3 rounded-xl shadow-lg">נתק</button>
                        <button onclick="clearDial()" class="w-16 bg-slate-100 text-slate-400 font-bold py-3 rounded-xl">C</button>
                    </div>
                    <audio id="remoteAudio" autoplay></audio>
                </section>
            </div>

            <!-- Right Column: CRM & Activity -->
            <div class="lg:col-span-8 space-y-6">
                <!-- 4. חיוג יוצא CRM (Bridge) -->
                <section class="card p-6 bg-slate-800 text-white border-none">
                    <div class="flex flex-col md:flex-row gap-4 items-end">
                        <div class="flex-1">
                            <label class="text-[10px] font-bold text-slate-400 mr-2 uppercase">חיוג יוצא מהיר (גשר)</label>
                            <input id="bridgeTarget" placeholder="מספר לקוח..." class="input-field bg-slate-700 border-slate-600 text-white text-xl">
                        </div>
                        <button onclick="startBridgeCall()" class="btn-blue h-[50px] px-10">הוצא שיחת גשר</button>
                    </div>
                </section>

                <!-- 5. אנשי קשר וניהול ניתובים -->
                <section class="card overflow-hidden">
                    <div class="p-6 border-b flex justify-between items-center bg-slate-50">
                        <h2 class="text-xl font-black">ניהול לקוחות וניתובים</h2>
                        <button onclick="document.getElementById('addContactArea').classList.toggle('hidden')" class="text-xs font-bold text-indigo-600 underline">+ הוסף לקוח</button>
                    </div>
                    <div id="addContactArea" class="hidden p-6 bg-indigo-50 border-b">
                        <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-4 gap-3">
                            <input id="cName" placeholder="שם" class="input-field text-sm">
                            <input id="cPhone" placeholder="טלפון" class="input-field text-sm" dir="ltr">
                            <select id="cType" class="input-field text-sm"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                            <input id="cDest" placeholder="יעד" class="input-field text-sm" dir="ltr">
                            <button type="submit" class="md:col-span-4 btn-blue">שמור איש קשר</button>
                        </form>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-right text-sm">
                            <thead class="bg-slate-50 text-slate-400 font-bold uppercase text-[10px]">
                                <tr><th class="p-4 px-6">לקוח</th><th class="p-4">מספר</th><th class="p-4">ניתוב קבוע</th><th class="p-4 text-left">ניהול</th></tr>
                            </thead>
                            <tbody id="contactsList" class="divide-y"></tbody>
                        </table>
                    </div>
                </section>

                <!-- 6. הגדרות ניתוב חכם -->
                <section class="card p-6">
                    <h2 class="text-sm font-black text-slate-400 uppercase mb-4">הגדרות ניתוב כלליות</h2>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label class="text-[10px] font-black text-slate-500">ברירת מחדל (לא מוכר)</label>
                            <div class="flex gap-2 mt-1">
                                <select id="defType" class="input-field w-24 py-1 text-xs"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                                <input id="defDest" placeholder="יעד" class="input-field py-1 text-xs font-mono">
                            </div>
                        </div>
                        <div>
                            <label class="text-[10px] font-black text-slate-500">לחצני פופ-אפ</label>
                            <div class="space-y-2 mt-1">
                                <div class="flex gap-1"><input id="q1Name" placeholder="שם" class="input-field py-1 text-xs w-20"><input id="q1Dest" placeholder="יעד" class="input-field py-1 text-xs flex-1"></div>
                                <div class="flex gap-1"><input id="q2Name" placeholder="שם" class="input-field py-1 text-xs w-20"><input id="q2Dest" placeholder="יעד" class="input-field py-1 text-xs flex-1"></div>
                            </div>
                        </div>
                    </div>
                    <button onclick="saveSettings()" class="w-full btn-blue mt-6 opacity-80 py-2">עדכן הגדרות ניתוב</button>
                </section>

                <!-- 7. לוג פעילות (Webhook) -->
                <section class="card p-6 bg-slate-900 text-slate-400">
                    <h2 class="text-xs font-black text-slate-500 uppercase mb-4 tracking-widest flex justify-between">
                        <span>מוניטור שיחות (חי)</span>
                        <span class="text-blue-500 animate-pulse">Live Webhook</span>
                    </h2>
                    <div id="logsArea" class="h-60 overflow-y-auto space-y-3 font-mono text-[11px]"></div>
                </section>
            </div>
        </div>
    </div>

    <script>
        // --- סיסטם ולוגים ---
        function addSipLog(msg) {
            const logEl = document.getElementById('sipLogs');
            const time = new Date().toLocaleTimeString();
            logEl.innerHTML = \`[\${time}] \${msg}<br>\` + logEl.innerHTML;
        }

        // --- טעינת נתונים ---
        async function loadData() {
            try {
                const res = await fetch('/api/data');
                const data = await res.json();
                
                if(document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
                    document.getElementById('globalToken').value = localStorage.getItem('y_token') || '';
                    document.getElementById('mySipExt').value = localStorage.getItem('y_sip') || '';
                    document.getElementById('sipUser').value = localStorage.getItem('sip_user') || '';
                    document.getElementById('sipPass').value = localStorage.getItem('sip_pass') || '';
                    document.getElementById('sipDomain').value = localStorage.getItem('sip_domain') || 'sip.call2all.co.il';
                    
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
                list.innerHTML += \`<tr class="hover:bg-slate-50"><td class="p-4 px-6 font-bold">\${c.name}</td><td class="p-4 font-mono text-slate-400">\${phone}</td><td class="p-4 text-indigo-600 font-bold">\${c.routeType}: \${c.destination}</td><td class="p-4 text-left"><button onclick="deleteContact('\${phone}')" class="text-red-400 font-bold">מחק</button></td></tr>\`;
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            area.innerHTML = logs.map(l => \`<div class="border-b border-slate-800 pb-2"><div class="flex justify-between text-[10px] text-slate-600"><span>\${l.time}</span><span class="text-blue-500">\${l.name}</span></div><div class="flex justify-between text-slate-300"><span>\${l.phone}</span><span>&rarr; \${l.routeType}: \${l.destination}</span></div></div>\`).join('');
        }

        // --- ניהול SIP (טלפון) ---
        let ua = null;
        let sipSession = null;

        function connectSIP() {
            const user = document.getElementById('sipUser').value;
            const pass = document.getElementById('sipPass').value;
            const domain = document.getElementById('sipDomain').value;
            
            localStorage.setItem('sip_user', user); localStorage.setItem('sip_pass', pass); localStorage.setItem('sip_domain', domain);

            addSipLog("מתחיל ניסיון חיבור...");
            const socket = new JsSIP.WebSocketInterface(\`wss://\${domain}:8089/ws\`);
            const configuration = { sockets: [socket], uri: \`sip:\${user}@\${domain}\`, password: pass };

            ua = new JsSIP.UA(configuration);
            ua.on('connecting', () => addSipLog("מתחבר לשרת WebSocket..."));
            ua.on('connected', () => addSipLog("מחובר ל-WebSocket. רושם שלוחה..."));
            ua.on('registered', () => {
                addSipLog("השלוחה רשומה ומוכנה (Registered)");
                document.getElementById('sipStatusDot').className = 'w-3 h-3 bg-green-500 rounded-full shadow-lg';
                document.getElementById('sipStatusText').innerText = 'CONNECTED';
                document.getElementById('btnSipConnect').innerText = 'Connected';
            });
            ua.on('registrationFailed', (e) => { addSipLog("רישום נכשל: " + e.cause); alert("רישום SIP נכשל. וודא פרטים."); });
            
            ua.on('newRTCSession', (data) => {
                sipSession = data.session;
                addSipLog("שיחה חדשה: " + sipSession.direction);
                if(sipSession.direction === 'incoming') {
                    if(confirm('שיחה נכנסת! לענות?')) { sipSession.answer({ mediaConstraints: { audio: true, video: false } }); }
                    else { sipSession.terminate(); }
                }
                
                sipSession.on('accepted', () => {
                    addSipLog("השיחה נענתה.");
                    document.getElementById('btnCall').classList.add('hidden');
                    document.getElementById('btnHangup').classList.remove('hidden');
                    const remoteStream = new MediaStream();
                    sipSession.connection.getReceivers().forEach(r => remoteStream.addTrack(r.track));
                    document.getElementById('remoteAudio').srcObject = remoteStream;
                });
                sipSession.on('ended', () => { addSipLog("השיחה הסתיימה."); resetSipUI(); });
                sipSession.on('failed', (e) => { addSipLog("השיחה נכשלה: " + e.cause); resetSipUI(); });
            });

            ua.start();
        }

        function dial(n) { document.getElementById('dialDisplay').innerText += n; }
        function clearDial() { document.getElementById('dialDisplay').innerText = ''; }
        function resetSipUI() { document.getElementById('btnCall').classList.remove('hidden'); document.getElementById('btnHangup').classList.add('hidden'); sipSession = null; }

        function sipCall() {
            const dest = document.getElementById('dialDisplay').innerText;
            if(!ua || !ua.isRegistered()) return alert('נא להתחבר ל-SIP קודם');
            ua.call(\`sip:\${dest}@\${document.getElementById('sipDomain').value}\`, { mediaConstraints: { audio: true, video: false } });
        }
        function sipHangup() { if(sipSession) sipSession.terminate(); }

        // --- ניהול CRM ---
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
                                    class="bg-indigo-600 text-white py-6 rounded-3xl font-black text-2xl hover:bg-indigo-700 shadow-xl transition active:scale-95">
                                \${opt.name}
                            </button>
                        \`).join('');
                    });

                    let timeLeft = 50;
                    clearInterval(timerInterval);
                    timerInterval = setInterval(() => {
                        timeLeft--;
                        document.getElementById('popupProgress').style.width = (timeLeft * 2) + '%';
                        document.getElementById('popupTimer').innerText = Math.ceil(timeLeft / 10);
                        if(timeLeft <= 0) { clearInterval(timerInterval); popup.classList.add('hidden'); }
                    }, 100);
                }
            } else { popup.classList.add('hidden'); activeCallId = null; clearInterval(timerInterval); }
        }

        async function resolveCall(id, type, dest, name) {
            document.getElementById('incomingPopup').classList.add('hidden');
            await fetch('/api/resolve_call', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, type, destination: dest, name}) });
            loadData();
        }

        async function startBridgeCall() {
            const token = document.getElementById('globalToken').value;
            const mySip = document.getElementById('mySipExt').value;
            const target = document.getElementById('bridgeTarget').value;
            if(!token || !mySip || !target) return alert('נא למלא טוקן, שלוחה ויעד');
            
            localStorage.setItem('y_token', token); localStorage.setItem('y_sip', mySip);

            const params = new URLSearchParams({ token, Phones: '0000000000', BridgePhones: target, DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0' });
            const res = await fetch(\`https://www.call2all.co.il/ym/api/CreateBridgeCall?\${params.toString()}\`);
            const data = await res.json();
            if(data.responseStatus === 'OK') alert('שיחת גישור הוקמה!');
            else alert('שגיאה: ' + data.message);
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
            alert('הגדרות נשמרו'); loadData();
        }

        document.getElementById('addContactForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = { name: document.getElementById('cName').value, phone: document.getElementById('cPhone').value, routeType: document.getElementById('cType').value, destination: document.getElementById('cDest').value };
            await fetch('/api/contacts', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            e.target.reset(); loadData();
        });

        async function deleteContact(p) { if(confirm('למחוק?')) { await fetch(\`/api/contacts/\${p}\`, {method: 'DELETE'}); loadData(); } }
        
        setInterval(loadData, 2000);
        loadData();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
