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

app.post('/api/settings', (req, res) => {
    db.defaultRouting = req.body.defaultRouting;
    db.quickOptions = req.body.quickOptions;
    saveDB();
    res.json({ success: true });
});

app.post('/api/contacts', (req, res) => {
    const { phone, name, routeType, destination } = req.body;
    db.contacts[phone] = { name, routeType, destination };
    saveDB();
    res.json({ success: true });
});

app.delete('/api/contacts/:phone', (req, res) => {
    delete db.contacts[req.params.phone];
    saveDB();
    res.json({ success: true });
});

app.post('/api/resolve_call', (req, res) => {
    const { id, type, destination, name } = req.body;
    if (activePendingCalls[id]) {
        const pending = activePendingCalls[id];
        clearTimeout(pending.timeoutId);
        const response = formatYemotResponse(type, destination);
        db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: `ניתוב ידני: ${name}`, routeType: type, destination: destination });
        delete activePendingCalls[id];
        updatePendingList();
        saveDB();
        pending.res.setHeader('Content-Type', 'text/html; charset=utf-8');
        pending.res.send(response);
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// ==========================================
// 3. ממשק ניהול משודרג עם טלפון SIP מובנה
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - מרכזיית CRM & SIP</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jssip/3.10.1/jssip.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@200;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; background-color: #f8fafc; color: #1e293b; }
        .glass-panel { background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(10px); border: 1px solid #e2e8f0; }
        .input-premium { background: #fdfdfd; border: 2px solid #e2e8f0; border-radius: 1.25rem; padding: 0.8rem 1.2rem; transition: all 0.2s ease; font-weight: 600; }
        .input-premium:focus { border-color: #6366f1; box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1); outline: none; }
        .phone-btn { width: 60px; height: 60px; border-radius: 50%; background: #f1f5f9; display: flex; items-center; justify-center; font-size: 1.5rem; font-weight: 800; transition: all 0.2s; cursor: pointer; user-select: none; }
        .phone-btn:active { background: #e2e8f0; transform: scale(0.9); }
        .call-active { background: #ef4444; color: white; animation: pulse-red 2s infinite; }
        @keyframes pulse-red { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); } 70% { box-shadow: 0 0 0 15px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
        .tab-btn { padding: 0.75rem 1.5rem; border-radius: 1rem; font-weight: 800; cursor: pointer; transition: all 0.2s; }
        .tab-active { background: #6366f1; color: white; }
    </style>
</head>
<body class="p-4 md:p-8">

    <!-- פופ-אפ שיחה נכנסת (Webhook) -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/90 z-[100] hidden items-center justify-center backdrop-blur-xl transition-all duration-500">
        <div class="bg-white rounded-[4rem] shadow-2xl p-16 w-[36rem] text-center relative">
            <div class="absolute top-0 left-0 w-full h-4 bg-slate-100 rounded-t-[4rem] overflow-hidden">
                <div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div>
            </div>
            <div id="popupPhone" class="text-6xl font-black text-indigo-600 mb-12 tracking-tighter" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-4 mb-8"></div>
            <div class="text-[11px] font-black uppercase tracking-widest text-slate-300">ניתוב אוטומטי בעוד <span id="popupTimer" class="text-indigo-600 text-xl">5</span> שניות</div>
        </div>
    </div>

    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <header class="flex justify-between items-center mb-10">
            <div class="flex items-center gap-6">
                <div class="bg-indigo-600 w-16 h-16 rounded-[1.5rem] flex items-center justify-center shadow-xl shadow-indigo-100">
                    <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </div>
                <div>
                    <h1 class="text-4xl font-black tracking-tighter">רחשי לב - Dashboard</h1>
                    <div class="flex items-center gap-2 mt-1">
                        <span id="sipStatusDot" class="w-2 h-2 bg-slate-300 rounded-full"></span>
                        <span id="sipStatusText" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">SIP Disconnected</span>
                    </div>
                </div>
            </div>
            <div class="flex gap-2">
                <div onclick="switchTab('crm')" id="tab-crm" class="tab-btn tab-active">CRM & ניתוב</div>
                <div onclick="switchTab('phone')" id="tab-phone" class="tab-btn bg-white border border-slate-200">טלפון SIP</div>
            </div>
        </header>

        <!-- CRM Tab -->
        <div id="view-crm" class="grid grid-cols-1 lg:grid-cols-12 gap-10">
            <div class="lg:col-span-4 space-y-8">
                <section class="glass-panel p-8 rounded-[2rem] shadow-sm">
                    <h2 class="text-xs font-black text-slate-400 uppercase tracking-widest mb-6">חיוג יוצא (CRM Bridge)</h2>
                    <input id="bridgeTarget" type="tel" placeholder="מספר לקוח..." class="w-full input-premium text-2xl text-center mb-4" dir="ltr">
                    <button onclick="startBridgeCall()" class="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl hover:bg-indigo-700 transition shadow-lg shadow-indigo-100">הוצא שיחה</button>
                </section>
                
                <section class="glass-panel p-8 rounded-[2rem] shadow-sm">
                    <h2 class="text-xs font-black text-slate-400 uppercase tracking-widest mb-6">הגדרות ניתוב</h2>
                    <div class="space-y-4">
                        <div class="flex gap-2">
                            <select id="defType" class="input-premium py-2 px-1 text-xs w-24"><option value="folder">תיקייה</option><option value="phone">טלפון</option><option value="sip">SIP</option></select>
                            <input id="defDest" placeholder="יעד..." class="flex-1 input-premium text-xs font-mono" dir="ltr">
                        </div>
                        <button onclick="saveSettings()" class="w-full bg-slate-800 text-white font-bold py-3 rounded-xl text-xs">שמור שינויים</button>
                    </div>
                </section>
            </div>

            <div class="lg:col-span-8 space-y-8">
                <section class="glass-panel rounded-[2.5rem] overflow-hidden shadow-sm">
                    <div class="p-8 border-b border-slate-100 flex justify-between items-center">
                        <h2 class="text-xl font-extrabold">אנשי קשר</h2>
                        <button onclick="toggleContactForm()" class="text-xs font-bold text-indigo-600 bg-indigo-50 px-4 py-2 rounded-xl">+ לקוח</button>
                    </div>
                    <div id="contactFormArea" class="hidden p-8 bg-slate-50 border-b border-slate-100">
                        <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-4 gap-4 italic">
                            <input id="cName" placeholder="שם" class="input-premium text-sm">
                            <input id="cPhone" placeholder="טלפון" class="input-premium text-sm" dir="ltr">
                            <select id="cType" class="input-premium text-sm"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                            <input id="cDest" placeholder="יעד" class="input-premium text-sm" dir="ltr">
                            <button type="submit" class="md:col-span-4 bg-indigo-600 text-white font-bold py-3 rounded-xl mt-2">שמור במערכת</button>
                        </form>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-right">
                            <thead class="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                <tr><th class="p-6 px-10">שם</th><th class="p-6">טלפון</th><th class="p-6">ניתוב</th><th class="p-6"></th></tr>
                            </thead>
                            <tbody id="contactsList" class="divide-y divide-slate-100"></tbody>
                        </table>
                    </div>
                </section>
                <section class="bg-slate-900 p-8 rounded-[2.5rem] shadow-2xl">
                    <h2 class="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-6">Activity Logs</h2>
                    <div id="logsArea" class="space-y-3 max-h-60 overflow-y-auto font-mono text-xs"></div>
                </section>
            </div>
        </div>

        <!-- Phone Tab -->
        <div id="view-phone" class="hidden grid grid-cols-1 lg:grid-cols-12 gap-10">
            <div class="lg:col-span-4 glass-panel p-10 rounded-[3rem] shadow-sm">
                <h2 class="text-xs font-black text-slate-400 uppercase tracking-widest mb-8 text-center">SIP Phone Credentials</h2>
                <div class="space-y-4">
                    <input id="sipDomain" placeholder="SIP Domain (e.g. sip.call2all.co.il)" class="w-full input-premium text-xs">
                    <input id="sipWss" placeholder="WebSocket URL (wss://...)" class="w-full input-premium text-xs">
                    <input id="sipUser" placeholder="SIP Username" class="w-full input-premium text-xs">
                    <input id="sipPass" type="password" placeholder="SIP Password" class="w-full input-premium text-xs">
                    <button onclick="connectSIP()" id="btnSipConnect" class="w-full bg-slate-800 text-white font-bold py-4 rounded-2xl">Connect Phone</button>
                </div>
            </div>

            <div class="lg:col-span-8 flex justify-center">
                <div class="glass-panel p-10 rounded-[4rem] shadow-2xl w-full max-w-md text-center">
                    <div id="phoneStatusLabel" class="text-slate-400 font-bold uppercase text-[10px] mb-6 tracking-widest">Ready to dial</div>
                    <div id="dialDisplay" class="text-5xl font-black text-indigo-600 mb-10 h-12 truncate tracking-tighter" dir="ltr"></div>
                    
                    <div class="grid grid-cols-3 gap-6 mb-10 place-items-center">
                        <div onclick="dial('1')" class="phone-btn">1</div><div onclick="dial('2')" class="phone-btn">2</div><div onclick="dial('3')" class="phone-btn">3</div>
                        <div onclick="dial('4')" class="phone-btn">4</div><div onclick="dial('5')" class="phone-btn">5</div><div onclick="dial('6')" class="phone-btn">6</div>
                        <div onclick="dial('7')" class="phone-btn">7</div><div onclick="dial('8')" class="phone-btn">8</div><div onclick="dial('9')" class="phone-btn">9</div>
                        <div onclick="dial('*')" class="phone-btn">*</div><div onclick="dial('0')" class="phone-btn">0</div><div onclick="dial('#')" class="phone-btn">#</div>
                    </div>

                    <div class="flex gap-4">
                        <button id="btnCallSip" onclick="sipCall()" class="flex-1 bg-emerald-500 text-white py-6 rounded-3xl font-black text-xl shadow-lg shadow-emerald-100">Call</button>
                        <button onclick="clearDial()" class="w-20 bg-slate-100 text-slate-400 py-6 rounded-3xl font-bold">C</button>
                    </div>
                    
                    <div id="activeCallTools" class="hidden mt-6 grid grid-cols-2 gap-4">
                        <button id="btnSipHangup" onclick="sipHangup()" class="bg-red-500 text-white py-4 rounded-2xl font-bold">Hang up</button>
                        <button onclick="sipTransferPrompt()" class="bg-blue-500 text-white py-4 rounded-2xl font-bold">Transfer</button>
                    </div>

                    <audio id="remoteAudio" autoplay></audio>
                </div>
            </div>
        </div>
    </div>

    <script>
        // --- ניהול טאבים ---
        function switchTab(tab) {
            document.getElementById('view-crm').classList.toggle('hidden', tab !== 'crm');
            document.getElementById('view-phone').classList.toggle('hidden', tab !== 'phone');
            document.getElementById('tab-crm').classList.toggle('tab-active', tab === 'crm');
            document.getElementById('tab-phone').classList.toggle('tab-active', tab === 'phone');
            document.getElementById('tab-crm').classList.toggle('bg-white', tab !== 'crm');
            document.getElementById('tab-phone').classList.toggle('bg-white', tab !== 'phone');
        }

        // --- ניהול SIP ---
        let ua = null;
        let sipSession = null;

        function connectSIP() {
            const domain = document.getElementById('sipDomain').value;
            const wss = document.getElementById('sipWss').value;
            const user = document.getElementById('sipUser').value;
            const pass = document.getElementById('sipPass').value;

            if(!domain || !wss || !user || !pass) return alert('נא למלא את כל פרטי ה-SIP');

            const socket = new JsSIP.WebSocketInterface(wss);
            const configuration = {
                sockets: [socket],
                uri: \`sip:\${user}@\${domain}\`,
                password: pass
            };

            ua = new JsSIP.UA(configuration);
            ua.on('registered', () => {
                document.getElementById('sipStatusDot').className = 'w-2 h-2 bg-emerald-500 shadow-sm';
                document.getElementById('sipStatusText').innerText = 'SIP Registered';
                document.getElementById('btnSipConnect').innerText = 'Connected';
                document.getElementById('btnSipConnect').className = 'w-full bg-emerald-100 text-emerald-700 font-bold py-4 rounded-2xl';
            });
            ua.on('registrationFailed', (e) => alert('חיבור SIP נכשל: ' + e.cause));
            
            ua.on('newRTCSession', (data) => {
                sipSession = data.session;
                if(sipSession.direction === 'incoming') {
                    if(confirm('שיחה נכנסת מ-\' + sipSession.remote_identity.uri.user + \'. לענות?')) {
                        sipSession.answer({ mediaConstraints: { audio: true, video: false } });
                    } else { sipSession.terminate(); }
                }
                
                sipSession.on('accepted', () => {
                    document.getElementById('phoneStatusLabel').innerText = 'In Call';
                    document.getElementById('activeCallTools').classList.remove('hidden');
                    document.getElementById('btnCallSip').classList.add('hidden');
                    const remoteStream = new MediaStream();
                    sipSession.connection.getReceivers().forEach(r => remoteStream.addTrack(r.track));
                    document.getElementById('remoteAudio').srcObject = remoteStream;
                });

                sipSession.on('ended', () => resetPhoneUI());
                sipSession.on('failed', () => resetPhoneUI());
            });

            ua.start();
        }

        function dial(num) { document.getElementById('dialDisplay').innerText += num; }
        function clearDial() { document.getElementById('dialDisplay').innerText = ''; }
        function resetPhoneUI() {
            document.getElementById('phoneStatusLabel').innerText = 'Ready to dial';
            document.getElementById('activeCallDisplay')?.classList.remove('call-active');
            document.getElementById('activeCallTools').classList.add('hidden');
            document.getElementById('btnCallSip').classList.remove('hidden');
            sipSession = null;
        }

        function sipCall() {
            const dest = document.getElementById('dialDisplay').innerText;
            if(!ua || !ua.isRegistered()) return alert('נא להתחבר ל-SIP קודם');
            ua.call(\`sip:\${dest}@\${document.getElementById('sipDomain').value}\`, {
                mediaConstraints: { audio: true, video: false }
            });
        }

        function sipHangup() { if(sipSession) sipSession.terminate(); }
        function sipTransferPrompt() {
            const target = prompt('הכנס מספר להעברה (Transfer):');
            if(target && sipSession) sipSession.refer(\`sip:\${target}@\${document.getElementById('sipDomain').value}\`);
        }

        // --- ניהול CRM ---
        let currentContacts = {};
        function toggleContactForm() { document.getElementById('contactFormArea').classList.toggle('hidden'); }

        async function loadData() {
            const res = await fetch('/api/data');
            const data = await res.json();
            currentContacts = data.contacts;
            renderContacts();
            renderLogs(data.callLogs);
            handlePending(data.pendingCalls);
            document.getElementById('statContacts').innerText = Object.keys(data.contacts).length;
            document.getElementById('statCallsToday').innerText = data.callLogs.length;
        }

        function renderContacts() {
            const list = document.getElementById('contactsList');
            list.innerHTML = '';
            for(let phone in currentContacts) {
                const c = currentContacts[phone];
                list.innerHTML += \`<tr class="hover:bg-indigo-50/50 transition border-b border-slate-50">
                    <td class="p-4 px-10 font-extrabold text-slate-800 text-lg">\${c.name}</td>
                    <td class="p-4 font-mono text-slate-400" dir="ltr">\${phone}</td>
                    <td class="p-4"><span class="bg-white border border-slate-200 text-slate-600 px-4 py-1.5 rounded-full text-[10px] font-black uppercase shadow-sm">\${c.routeType}: \${c.destination}</span></td>
                    <td class="p-4 text-left"><button onclick="deleteContact('\${phone}')" class="text-slate-300 hover:text-red-500 font-bold transition">מחיקה</button></td>
                </tr>\`;
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            area.innerHTML = logs.map(l => \`
                <div class="bg-white/5 p-4 rounded-2xl border border-white/5 flex justify-between items-center text-slate-400">
                    <span class="text-[9px] font-black">\${l.time}</span>
                    <span class="text-white font-black text-sm" dir="ltr">\${l.phone}</span>
                    <span class="text-emerald-400 font-bold text-[9px] uppercase tracking-widest">&rarr; \${l.routeType}: \${l.destination}</span>
                </div>
            \`).join('');
        }

        let activeCallId = null;
        let timerInterval = null;

        function handlePending(pending) {
            const popup = document.getElementById('incomingPopup');
            if(pending.length > 0) {
                const call = pending[0];
                if(activeCallId !== call.id) {
                    activeCallId = call.id;
                    document.getElementById('popupPhone').innerText = call.phone;
                    popup.classList.remove('hidden');
                    popup.classList.add('flex');
                    
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
                        if(timeLeft <= 0) clearInterval(timerInterval);
                    }, 100);
                }
            } else {
                popup.classList.add('hidden');
                activeCallId = null;
                clearInterval(timerInterval);
            }
        }

        async function resolveCall(id, type, dest, name) {
            document.getElementById('incomingPopup').classList.add('hidden');
            await fetch('/api/resolve_call', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id, type, destination: dest, name})
            });
            loadData();
        }

        async function startBridgeCall() {
            const token = localStorage.getItem('y_token');
            const mySip = localStorage.getItem('y_sip');
            const target = document.getElementById('bridgeTarget').value;
            if(!token || !mySip || !target) return alert('נא למלא פרטי חיבור ב-Sidebar');
            const params = new URLSearchParams({ token, Phones: '0000000000', BridgePhones: target, DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0' });
            const res = await fetch(\`https://www.call2all.co.il/ym/api/CreateBridgeCall?\${params.toString()}\`);
            const data = await res.json();
            if(data.responseStatus === 'OK') alert('שיחת גישור הוקמה.');
            else alert('שגיאה: ' + data.message);
        }

        async function saveSettings() {
            const settings = {
                defaultRouting: { type: document.getElementById('defType').value, destination: document.getElementById('defDest').value },
                quickOptions: [
                    { name: document.getElementById('q1Name').value, type: document.getElementById('q1Type').value, destination: document.getElementById('q1Dest').value },
                    { name: document.getElementById('q2Name').value, type: document.getElementById('q2Type').value, destination: document.getElementById('q2Dest').value }
                ]
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
            alert('הגדרות עודכנו');
            loadData();
        }

        document.getElementById('addContactForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = { name: document.getElementById('cName').value, phone: document.getElementById('cPhone').value, routeType: document.getElementById('cType').value, destination: document.getElementById('cDest').value };
            await fetch('/api/contacts', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            e.target.reset();
            toggleContactForm();
            loadData();
        });

        async function deleteContact(p) { if(confirm('למחוק?')) { await fetch(\`/api/contacts/\${p}\`, {method: 'DELETE'}); loadData(); } }
        
        setInterval(loadData, 2000);
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
