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
// 3. ממשק ניהול פרימיום - CRM & SIP Phone
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - מערכת שליטה חכמה</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jssip/3.10.1/jssip.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@200;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; background-color: #f1f5f9; color: #0f172a; }
        
        .premium-card { 
            background: white; 
            border-radius: 2.5rem; 
            border: 2px solid #e2e8f0; 
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.05); 
            transition: all 0.3s ease;
        }
        
        .input-high-vis { 
            background: #ffffff; 
            border: 3px solid #cbd5e1; 
            border-radius: 1.5rem; 
            padding: 1rem 1.5rem; 
            transition: all 0.2s; 
            font-weight: 700;
            color: #1e293b;
        }
        .input-high-vis:focus { 
            border-color: #6366f1; 
            background: #f8faff;
            box-shadow: 0 0 0 6px rgba(99, 102, 241, 0.15); 
            outline: none; 
        }

        .phone-key { 
            width: 75px; height: 75px; border-radius: 2rem; 
            background: #ffffff; border: 2px solid #e2e8f0;
            display: flex; items-center; justify-center; 
            font-size: 1.8rem; font-weight: 800; 
            transition: all 0.2s; cursor: pointer; color: #475569;
            box-shadow: 0 4px 6px rgba(0,0,0,0.02);
        }
        .phone-key:hover { border-color: #6366f1; color: #6366f1; background: #f8faff; }
        .phone-key:active { transform: scale(0.9); background: #6366f1; color: white; }

        .btn-action { 
            padding: 1rem 2rem; border-radius: 1.5rem; 
            font-weight: 800; transition: all 0.3s; 
            text-transform: uppercase; letter-spacing: 0.05em;
        }

        .nav-tab { 
            padding: 1rem 2.5rem; border-radius: 1.5rem; 
            font-weight: 800; cursor: pointer; transition: all 0.3s;
            border: 2px solid transparent;
        }
        .nav-tab-active { background: #6366f1; color: white; box-shadow: 0 10px 15px rgba(99, 102, 241, 0.2); }
        .nav-tab-inactive { background: white; border-color: #e2e8f0; color: #64748b; }
        
        .call-btn { background: #22c55e; color: white; box-shadow: 0 10px 20px rgba(34, 197, 94, 0.3); }
        .hangup-btn { background: #ef4444; color: white; box-shadow: 0 10px 20px rgba(239, 68, 68, 0.3); }

        .status-badge { padding: 0.4rem 1rem; border-radius: 1rem; font-size: 0.7rem; font-weight: 900; letter-spacing: 0.1em; }
    </style>
</head>
<body class="p-4 md:p-12">

    <!-- פופ-אפ שיחה נכנסת -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/90 z-[100] hidden items-center justify-center backdrop-blur-2xl transition-all duration-500">
        <div class="bg-white rounded-[4rem] shadow-2xl p-16 w-[36rem] text-center border border-white/20">
            <div class="absolute top-0 left-0 w-full h-4 bg-slate-100 rounded-t-[4rem] overflow-hidden">
                <div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div>
            </div>
            <div id="popupPhone" class="text-7xl font-black text-slate-900 mb-12 tracking-tighter" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-4 mb-8"></div>
            <div class="text-[12px] font-black uppercase tracking-[0.3em] text-slate-300 italic">Auto-Routing in <span id="popupTimer" class="text-indigo-600 text-2xl">5</span>s</div>
        </div>
    </div>

    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <header class="flex flex-col md:flex-row justify-between items-center mb-16 gap-10">
            <div class="flex items-center gap-8">
                <div class="bg-indigo-600 w-20 h-20 rounded-[2rem] flex items-center justify-center shadow-2xl shadow-indigo-200 rotate-3">
                    <svg class="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </div>
                <div>
                    <h1 class="text-6xl font-black tracking-tight text-slate-900">רחשי לב</h1>
                    <div class="flex items-center gap-3 mt-2">
                        <span id="sipStatusDot" class="w-3 h-3 bg-slate-300 rounded-full"></span>
                        <span id="sipStatusText" class="status-badge bg-slate-100 text-slate-500 uppercase">OFFLINE</span>
                    </div>
                </div>
            </div>
            <div class="flex bg-white p-2 rounded-[2rem] shadow-sm border border-slate-200">
                <div onclick="switchTab('crm')" id="tab-crm" class="nav-tab nav-tab-active">CRM & ניתוב</div>
                <div onclick="switchTab('phone')" id="tab-phone" class="nav-tab nav-tab-inactive">טלפון פנימי</div>
            </div>
        </header>

        <!-- CRM Tab -->
        <div id="view-crm" class="grid grid-cols-1 lg:grid-cols-12 gap-12">
            <!-- Sidebar -->
            <div class="lg:col-span-4 space-y-10">
                <section class="premium-card p-10">
                    <h2 class="text-xs font-black text-slate-400 uppercase tracking-widest mb-8">חיוג יוצא מהיר</h2>
                    <input id="bridgeTarget" type="tel" placeholder="מספר לקוח..." class="w-full input-high-vis text-3xl text-center mb-6" dir="ltr">
                    <button onclick="startBridgeCall()" class="w-full btn-action bg-indigo-600 text-white text-lg">הוצא שיחה</button>
                </section>
                
                <section class="premium-card p-10">
                    <h2 class="text-xs font-black text-slate-400 uppercase tracking-widest mb-8">הגדרות ניתוב</h2>
                    <div class="space-y-6">
                        <div class="space-y-2">
                            <label class="text-[10px] font-black text-slate-400 uppercase px-2">יעד ברירת מחדל</label>
                            <div class="flex gap-2">
                                <select id="defType" class="input-high-vis py-3 px-2 text-sm w-32"><option value="folder">תיקייה</option><option value="phone">טלפון</option><option value="sip">SIP</option></select>
                                <input id="defDest" placeholder="/5" class="flex-1 input-high-vis text-sm font-mono" dir="ltr">
                            </div>
                        </div>
                        <button onclick="saveSettings()" class="w-full btn-action bg-slate-800 text-white text-xs py-4">שמור הגדרות</button>
                    </div>
                </section>
            </div>

            <!-- Main CRM Content -->
            <div class="lg:col-span-8 space-y-10">
                <section class="premium-card overflow-hidden">
                    <div class="p-10 border-b border-slate-100 flex justify-between items-center bg-slate-50/30">
                        <h2 class="text-2xl font-black">ספר כתובות</h2>
                        <button onclick="toggleContactForm()" class="btn-action bg-indigo-50 text-indigo-600 text-[10px] py-3 px-6">+ הוסף לקוח</button>
                    </div>
                    <div id="contactFormArea" class="hidden p-10 bg-indigo-50/30 border-b border-indigo-100">
                        <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-2 gap-6 italic">
                            <input id="cName" placeholder="שם מלא" class="input-high-vis text-sm">
                            <input id="cPhone" placeholder="מספר טלפון" class="input-high-vis text-sm" dir="ltr">
                            <select id="cType" class="input-high-vis text-sm"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                            <input id="cDest" placeholder="יעד ניתוב" class="input-high-vis text-sm" dir="ltr">
                            <button type="submit" class="md:col-span-2 btn-action bg-indigo-600 text-white">שמור איש קשר</button>
                        </form>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-right">
                            <thead class="bg-slate-50 text-[11px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                                <tr><th class="p-8 px-10">לקוח</th><th class="p-8">טלפון</th><th class="p-8">ניתוב</th><th class="p-8"></th></tr>
                            </thead>
                            <tbody id="contactsList" class="divide-y divide-slate-100"></tbody>
                        </table>
                    </div>
                </section>
                
                <section class="bg-slate-900 p-10 rounded-[3rem] shadow-2xl border-4 border-slate-800">
                    <h2 class="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-8">Live Monitor</h2>
                    <div id="logsArea" class="space-y-4 max-h-72 overflow-y-auto font-mono text-xs"></div>
                </section>
            </div>
        </div>

        <!-- Phone Tab -->
        <div id="view-phone" class="hidden grid grid-cols-1 lg:grid-cols-12 gap-12">
            <!-- SIP Login -->
            <div class="lg:col-span-4 space-y-8">
                <section class="premium-card p-10 bg-white">
                    <h2 class="text-xs font-black text-slate-400 uppercase tracking-widest mb-8 text-center">הגדרות SIP</h2>
                    <div class="space-y-4">
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-400 uppercase px-2">DOMAIN</label>
                            <input id="sipDomain" placeholder="sip.call2all.co.il" class="w-full input-high-vis text-sm">
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-400 uppercase px-2">USER ID</label>
                            <input id="sipUser" placeholder="Username" class="w-full input-high-vis text-sm">
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-400 uppercase px-2">PASSWORD</label>
                            <input id="sipPass" type="password" placeholder="Password" class="w-full input-high-vis text-sm">
                        </div>
                        <button onclick="connectSIP()" id="btnSipConnect" class="w-full btn-action bg-slate-900 text-white mt-4">התחבר למרכזיה</button>
                    </div>
                </section>
            </div>

            <!-- Dial Pad -->
            <div class="lg:col-span-8 flex justify-center items-start">
                <div class="premium-card p-12 w-full max-w-lg text-center bg-white border-4 border-slate-100">
                    <div id="phoneStatusLabel" class="text-slate-400 font-black uppercase text-[11px] mb-8 tracking-[0.2em]">Ready to Call</div>
                    <div id="dialDisplay" class="text-6xl font-black text-slate-900 mb-12 h-16 truncate tracking-tighter" dir="ltr"></div>
                    
                    <div class="grid grid-cols-3 gap-8 mb-12 place-items-center">
                        <div onclick="dial('1')" class="phone-key">1</div><div onclick="dial('2')" class="phone-key">2</div><div onclick="dial('3')" class="phone-key">3</div>
                        <div onclick="dial('4')" class="phone-key">4</div><div onclick="dial('5')" class="phone-key">5</div><div onclick="dial('6')" class="phone-key">6</div>
                        <div onclick="dial('7')" class="phone-key">7</div><div onclick="dial('8')" class="phone-key">8</div><div onclick="dial('9')" class="phone-key">9</div>
                        <div onclick="dial('*')" class="phone-key">*</div><div onclick="dial('0')" class="phone-key">0</div><div onclick="dial('#')" class="phone-key">#</div>
                    </div>

                    <div class="flex gap-6">
                        <button id="btnCallSip" onclick="sipCall()" class="flex-1 btn-action call-btn text-2xl py-6">חיוג</button>
                        <button onclick="clearDial()" class="w-24 btn-action bg-slate-100 text-slate-400 py-6">מחק</button>
                    </div>
                    
                    <div id="activeCallTools" class="hidden mt-8 grid grid-cols-2 gap-4">
                        <button id="btnSipHangup" onclick="sipHangup()" class="btn-action hangup-btn py-5">נתק</button>
                        <button onclick="sipTransferPrompt()" class="btn-action bg-blue-600 text-white py-5">העברה</button>
                    </div>

                    <audio id="remoteAudio" autoplay></audio>
                </div>
            </div>
        </div>
    </div>

    <script>
        // --- Navigation ---
        function switchTab(tab) {
            document.getElementById('view-crm').classList.toggle('hidden', tab !== 'crm');
            document.getElementById('view-phone').classList.toggle('hidden', tab !== 'phone');
            document.getElementById('tab-crm').className = tab === 'crm' ? 'nav-tab nav-tab-active' : 'nav-tab nav-tab-inactive';
            document.getElementById('tab-phone').className = tab === 'phone' ? 'nav-tab nav-tab-active' : 'nav-tab nav-tab-inactive';
        }

        // --- SIP Logic ---
        let ua = null;
        let sipSession = null;

        function connectSIP() {
            const domain = document.getElementById('sipDomain').value;
            const user = document.getElementById('sipUser').value;
            const pass = document.getElementById('sipPass').value;

            if(!domain || !user || !pass) return alert('נא למלא את כל פרטי ההתחברות');

            // ניסיון לנחש את ה-WSS באופן אוטומטי (לרוב בפורמט הזה בימות המשיח)
            const wss = \`wss://\${domain}:8089/ws\`; 

            const socket = new JsSIP.WebSocketInterface(wss);
            const configuration = {
                sockets: [socket],
                uri: \`sip:\${user}@\${domain}\`,
                password: pass,
                display_name: user
            };

            ua = new JsSIP.UA(configuration);
            ua.on('registered', () => {
                document.getElementById('sipStatusDot').className = 'w-3 h-3 bg-emerald-500 shadow-lg';
                document.getElementById('sipStatusText').innerText = 'CONNECTED';
                document.getElementById('sipStatusText').className = 'status-badge bg-emerald-50 text-emerald-600';
                document.getElementById('btnSipConnect').innerText = 'Connected Successfully';
                document.getElementById('btnSipConnect').className = 'w-full btn-action bg-emerald-50 text-emerald-700 mt-4';
            });
            ua.on('registrationFailed', (e) => {
                alert('התחברות SIP נכשלה. וודא שחשבון ה-SIP תומך ב-WebRTC / WebSocket.');
                console.error(e);
            });
            
            ua.on('newRTCSession', (data) => {
                sipSession = data.session;
                if(sipSession.direction === 'incoming') {
                    if(confirm('שיחה נכנסת מ-\' + sipSession.remote_identity.uri.user + \'. לענות?')) {
                        sipSession.answer({ mediaConstraints: { audio: true, video: false } });
                    } else { sipSession.terminate(); }
                }
                
                sipSession.on('accepted', () => {
                    document.getElementById('phoneStatusLabel').innerText = 'IN CALL';
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
            document.getElementById('activeCallTools').classList.add('hidden');
            document.getElementById('btnCallSip').classList.remove('hidden');
            sipSession = null;
        }

        function sipCall() {
            const dest = document.getElementById('dialDisplay').innerText;
            if(!ua || !ua.isRegistered()) return alert('נא להתחבר למרכזיה קודם');
            ua.call(\`sip:\${dest}@\${document.getElementById('sipDomain').value}\`, {
                mediaConstraints: { audio: true, video: false },
                rtcOfferConstraints: { offerToReceiveAudio: 1, offerToReceiveVideo: 0 }
            });
        }

        function sipHangup() { if(sipSession) sipSession.terminate(); }
        function sipTransferPrompt() {
            const target = prompt('הכנס מספר שלוחה להעברה:');
            if(target && sipSession) sipSession.refer(\`sip:\${target}@\${document.getElementById('sipDomain').value}\`);
        }

        // --- CRM Logic ---
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
            const search = document.getElementById('contactSearch').value.toLowerCase();
            list.innerHTML = '';
            for(let phone in currentContacts) {
                const c = currentContacts[phone];
                if(c.name.toLowerCase().includes(search) || phone.includes(search)) {
                    list.innerHTML += \`<tr class="hover:bg-indigo-50/50 transition border-b border-slate-50">
                        <td class="p-8 px-10 font-extrabold text-slate-800 text-2xl">\${c.name}</td>
                        <td class="p-8 font-mono text-slate-400 text-lg" dir="ltr">\${phone}</td>
                        <td class="p-8"><span class="bg-white border-2 border-slate-200 text-slate-500 px-5 py-2 rounded-full text-[10px] font-black uppercase">\${c.routeType}: \${c.destination}</span></td>
                        <td class="p-8 px-10 text-left"><button onclick="deleteContact('\${phone}')" class="text-slate-300 hover:text-red-500 font-bold transition">מחיקה</button></td>
                    </tr>\`;
                }
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            area.innerHTML = logs.map(l => \`
                <div class="bg-white/5 p-5 rounded-3xl border border-white/5 flex justify-between items-center text-slate-400">
                    <span class="text-[9px] font-black opacity-50">\${l.time}</span>
                    <span class="text-white font-black text-lg" dir="ltr">\${l.phone}</span>
                    <span class="text-emerald-400 font-bold text-[10px] uppercase tracking-[0.2em]">&rarr; \${l.routeType}: \${l.destination}</span>
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
                    popup.classList.remove('hidden'); popup.classList.add('flex');
                    
                    fetch('/api/data').then(r => r.json()).then(data => {
                        document.getElementById('popupButtons').innerHTML = data.quickOptions.map(opt => \`
                            <button onclick="resolveCall('\${call.id}', '\${opt.type}', '\${opt.destination}', '\${opt.name}')" 
                                    class="bg-indigo-600 text-white py-8 rounded-[3rem] font-black text-3xl hover:bg-indigo-700 shadow-2xl transition active:scale-95">
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
        
        document.getElementById('webhookUrl').innerText = window.location.origin + '/yemot_webhook';
        setInterval(loadData, 2000);
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
