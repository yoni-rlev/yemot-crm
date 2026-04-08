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

// פורמט תגובה לימות המשיח עם הודעת פתיחה
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
    
    // השמעת הודעת ברוכים הבאים לפני הביצוע
    const welcomeMsg = "t-ברוכים_הבאים_למערכת_של_רחשי_לב_אנחנו_בודקים_לאן_להעביר_אותך";
    return `id_list_message=${welcomeMsg}&${cmd}`;
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
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || 'חסוי';
    
    if (db.contacts[apiPhone]) {
        const c = db.contacts[apiPhone];
        const response = formatYemotResponse(c.routeType, c.destination);
        
        db.callLogs.unshift({ 
            time: new Date().toLocaleTimeString('he-IL'), 
            phone: apiPhone, 
            name: c.name, 
            routeType: c.routeType, 
            destination: c.destination 
        });
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
            db.callLogs.unshift({ 
                time: new Date().toLocaleTimeString('he-IL'), 
                phone: pending.phone, 
                name: 'ללא בחירה (ברירת מחדל)', 
                routeType: db.defaultRouting.type, 
                destination: db.defaultRouting.destination 
            });
            saveDB();
            
            pending.res.send(response);
        }
    }, 5500); // הגדלתי מעט ל-5.5 שניות כדי לאפשר להודעה להתחיל

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
        db.callLogs.unshift({ 
            time: new Date().toLocaleTimeString('he-IL'), 
            phone: pending.phone, 
            name: `בחירה: ${name}`, 
            routeType: type, 
            destination: destination 
        });
        
        delete activePendingCalls[id];
        updatePendingList();
        saveDB();
        
        pending.res.send(response);
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// ==========================================
// 3. ממשק ניהול מודרני (HTML)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - ניהול שיחות חכם</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; }
        .loader { border-top-color: #6366f1; animation: spinner 1s linear infinite; }
        @keyframes spinner { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .glass { background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(10px); }
        .card-shadow { box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.05); }
    </style>
</head>
<body class="bg-slate-50 min-h-screen text-slate-700">

    <!-- פופ-אפ שיחה נכנסת -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/60 z-[100] hidden items-center justify-center backdrop-blur-sm transition-all duration-500">
        <div class="bg-white rounded-[2rem] shadow-2xl p-10 w-[28rem] text-center border border-slate-100 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-full h-2 bg-slate-100">
                <div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div>
            </div>
            <div class="bg-indigo-50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg class="w-10 h-10 text-indigo-600 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
            </div>
            <h3 class="text-2xl font-extrabold text-slate-800 mb-2">שיחה נכנסת ל"רחשי לב"</h3>
            <p class="text-slate-500 mb-8 font-medium">הלקוח שומע כעת הודעת פתיחה...</p>
            <div id="popupPhone" class="text-4xl font-black text-indigo-600 mb-10 tracking-wider" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-4 mb-2"></div>
            <div class="text-[10px] font-bold text-slate-400 uppercase tracking-tighter mt-4">
                מעביר לברירת מחדל בעוד <span id="popupTimer" class="text-indigo-600">5</span> שניות
            </div>
        </div>
    </div>

    <!-- Header -->
    <header class="bg-white border-b border-slate-200 sticky top-0 z-50 glass">
        <div class="max-w-7xl mx-auto px-6 h-20 flex justify-between items-center">
            <div class="flex items-center gap-4">
                <div class="bg-indigo-600 p-2.5 rounded-xl shadow-indigo-200 shadow-lg">
                    <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </div>
                <div>
                    <h1 class="text-xl font-extrabold text-slate-800">רחשי לב - CRM</h1>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">מערכת ניתוב שיחות מבוססת תיקיות</p>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <div class="flex items-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-1.5 rounded-full border border-emerald-100 text-xs font-bold">
                    <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                    מחובר לשרת
                </div>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto px-6 py-10 grid grid-cols-1 lg:grid-cols-12 gap-10">
        
        <!-- Sidebar / Settings -->
        <div class="lg:col-span-4 space-y-8">
            
            <!-- חיוג יוצא -->
            <section class="bg-white p-6 rounded-3xl card-shadow border border-slate-100">
                <h2 class="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">חיוג יוצא (Bridge)</h2>
                <div class="space-y-4">
                    <input id="bridgeTarget" type="tel" placeholder="מספר לקוח" class="w-full bg-slate-50 border-none rounded-2xl p-4 outline-none ring-2 ring-transparent focus:ring-indigo-500 transition font-mono text-lg" dir="ltr">
                    <button id="btnBridge" onclick="startBridgeCall()" class="w-full bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition active:scale-95">הוצא שיחה</button>
                </div>
            </section>

            <!-- הגדרות ניתוב -->
            <section class="bg-white p-6 rounded-3xl card-shadow border border-slate-100">
                <h2 class="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">הגדרות ניתוב חכם</h2>
                
                <div class="space-y-6">
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-2">יעד ברירת מחדל</label>
                        <div class="flex gap-2">
                            <select id="defType" class="bg-slate-50 rounded-xl p-2 text-xs border-none outline-none focus:ring-1 focus:ring-indigo-500">
                                <option value="folder">תיקייה</option>
                                <option value="phone">טלפון</option>
                                <option value="sip">SIP</option>
                            </select>
                            <input id="defDest" placeholder="יעד (למשל /5)" class="flex-1 bg-slate-50 rounded-xl p-2 text-xs outline-none focus:ring-1 focus:ring-indigo-500 font-mono" dir="ltr">
                        </div>
                    </div>

                    <div class="space-y-3">
                        <label class="block text-xs font-bold text-slate-500">כפתורי בחירה (פופ-אפ)</label>
                        <div class="grid gap-2">
                            <div class="flex gap-1 bg-slate-50 p-2 rounded-xl">
                                <input id="q1Name" placeholder="שם" class="w-16 bg-transparent text-[10px] font-bold outline-none">
                                <select id="q1Type" class="bg-white text-[10px] rounded p-1"><option value="folder">תיקייה</option><option value="phone">טל</option></select>
                                <input id="q1Dest" placeholder="יעד" class="flex-1 bg-white text-[10px] rounded p-1 font-mono">
                            </div>
                            <div class="flex gap-1 bg-slate-50 p-2 rounded-xl">
                                <input id="q2Name" placeholder="שם" class="w-16 bg-transparent text-[10px] font-bold outline-none">
                                <select id="q2Type" class="bg-white text-[10px] rounded p-1"><option value="folder">תיקייה</option><option value="phone">טל</option></select>
                                <input id="q2Dest" placeholder="יעד" class="flex-1 bg-white text-[10px] rounded p-1 font-mono">
                            </div>
                        </div>
                    </div>
                    
                    <button onclick="saveSettings()" class="w-full bg-slate-800 text-white font-bold py-3 rounded-2xl text-xs hover:bg-slate-900 transition">שמור הגדרות</button>
                </div>
            </section>

            <!-- הגדרות חיבור -->
            <section class="bg-indigo-50 p-6 rounded-3xl border border-indigo-100">
                <h2 class="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-4">פרטי גישה למרכזייה</h2>
                <div class="space-y-4">
                    <input id="globalToken" type="password" placeholder="API Token" class="w-full bg-white rounded-xl p-3 text-xs outline-none focus:ring-2 focus:ring-indigo-500">
                    <input id="mySipExt" type="number" placeholder="ה-SIP שלך (למשל 101)" class="w-full bg-white rounded-xl p-3 text-xs outline-none focus:ring-2 focus:ring-indigo-500">
                </div>
            </section>
        </div>

        <!-- Main Content / CRM & Logs -->
        <div class="lg:col-span-8 space-y-8">
            
            <!-- CRM -->
            <section class="bg-white rounded-3xl card-shadow border border-slate-100 overflow-hidden">
                <div class="p-6 border-b border-slate-50 flex justify-between items-center">
                    <h2 class="font-bold text-slate-800">ספר כתובות וניתובים קבועים</h2>
                    <button onclick="toggleContactForm()" class="bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-100 transition">+ לקוח חדש</button>
                </div>
                
                <div id="contactFormArea" class="hidden p-6 bg-slate-50 border-b border-slate-100">
                    <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-4 gap-3">
                        <input id="cName" placeholder="שם לקוח" class="bg-white p-3 rounded-xl text-sm outline-none">
                        <input id="cPhone" placeholder="מספר טלפון" class="bg-white p-3 rounded-xl text-sm outline-none" dir="ltr">
                        <select id="cType" class="bg-white p-3 rounded-xl text-sm outline-none"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                        <input id="cDest" placeholder="יעד (למשל /10)" class="bg-white p-3 rounded-xl text-sm outline-none" dir="ltr">
                        <div class="md:col-span-4 text-left">
                            <button type="submit" class="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold shadow-lg shadow-indigo-100">שמור איש קשר</button>
                        </div>
                    </form>
                </div>

                <div class="overflow-x-auto">
                    <table class="w-full text-right">
                        <thead class="bg-slate-50/50 text-slate-400 text-[10px] font-bold uppercase tracking-widest">
                            <tr>
                                <th class="p-4 px-6">לקוח</th>
                                <th class="p-4">מספר</th>
                                <th class="p-4">ניתוב</th>
                                <th class="p-4 px-6 text-left">פעולות</th>
                            </tr>
                        </thead>
                        <tbody id="contactsList" class="divide-y divide-slate-50 text-sm"></tbody>
                    </table>
                </div>
            </section>

            <!-- Logs -->
            <section class="bg-slate-900 rounded-3xl shadow-2xl overflow-hidden border border-slate-800">
                <div class="p-5 bg-slate-800/50 border-b border-slate-800 flex justify-between items-center">
                    <h2 class="text-xs font-bold text-slate-300 uppercase tracking-tighter">מוניטור שיחות בזמן אמת</h2>
                    <div class="flex gap-2">
                        <span class="w-2 h-2 bg-indigo-500 rounded-full animate-pulse"></span>
                    </div>
                </div>
                <div id="logsArea" class="h-80 overflow-y-auto p-6 space-y-4 font-mono text-[11px]">
                    <div class="text-slate-600 text-center py-10 italic uppercase tracking-widest">ממתין לתעבורה...</div>
                </div>
            </section>
        </div>
    </main>

    <script>
        const API_YEMOT = 'https://www.call2all.co.il/ym/api';
        const elToken = document.getElementById('globalToken');
        const elMySip = document.getElementById('mySipExt');

        document.addEventListener('DOMContentLoaded', () => {
            if(localStorage.getItem('y_token')) elToken.value = localStorage.getItem('y_token');
            if(localStorage.getItem('y_sip')) elMySip.value = localStorage.getItem('y_sip');
            loadData();
        });

        elToken.oninput = () => localStorage.setItem('y_token', elToken.value);
        elMySip.oninput = () => localStorage.setItem('y_sip', elMySip.value);

        function toggleContactForm() {
            const area = document.getElementById('contactFormArea');
            area.classList.toggle('hidden');
        }

        async function loadData() {
            try {
                const res = await fetch('/api/data');
                const data = await res.json();
                
                if(document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
                    document.getElementById('defType').value = data.defaultRouting.type;
                    document.getElementById('defDest').value = data.defaultRouting.destination;
                    
                    quickOptions = data.quickOptions;
                    if(data.quickOptions[0]) {
                        document.getElementById('q1Name').value = data.quickOptions[0].name;
                        document.getElementById('q1Type').value = data.quickOptions[0].type;
                        document.getElementById('q1Dest').value = data.quickOptions[0].destination;
                    }
                    if(data.quickOptions[1]) {
                        document.getElementById('q2Name').value = data.quickOptions[1].name;
                        document.getElementById('q2Type').value = data.quickOptions[1].type;
                        document.getElementById('q2Dest').value = data.quickOptions[1].destination;
                    }
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
                list.innerHTML += \`<tr class="hover:bg-slate-50/50 transition">
                    <td class="p-4 px-6 font-semibold text-slate-800">\${c.name}</td>
                    <td class="p-4 font-mono text-slate-500" dir="ltr">\${phone}</td>
                    <td class="p-4"><span class="bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase">\${c.routeType}: \${c.destination}</span></td>
                    <td class="p-4 px-6 text-left"><button onclick="deleteContact('\${phone}')" class="text-slate-300 hover:text-red-500 transition">מחק</button></td>
                </tr>\`;
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            if(logs.length === 0) return;
            area.innerHTML = logs.map(l => \`
                <div class="bg-slate-800/30 p-4 rounded-2xl border border-slate-800">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-[9px] text-slate-500 font-bold">\${l.time}</span>
                        <span class="text-indigo-400 font-bold">\${l.name}</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-white font-bold" dir="ltr">\${l.phone}</span>
                        <span class="text-emerald-400 font-bold text-[9px] tracking-widest">&rarr; \${l.routeType.toUpperCase()}: \${l.destination}</span>
                    </div>
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
                    
                    document.getElementById('popupButtons').innerHTML = quickOptions.map(opt => \`
                        <button onclick="resolveCall('\${call.id}', '\${opt.type}', '\${opt.destination}', '\${opt.name}')" 
                                class="bg-indigo-600 text-white py-5 rounded-2xl font-bold hover:bg-indigo-700 shadow-xl shadow-indigo-100 transition">
                            \${opt.name}
                        </button>
                    \`).join('');
                    
                    popup.classList.remove('hidden');
                    popup.classList.add('flex');
                    
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
            const token = elToken.value;
            const mySip = elMySip.value;
            const target = document.getElementById('bridgeTarget').value;
            if(!token || !mySip || !target) return alert('חובה למלא טוקן, SIP ומספר לקוח');

            const btn = document.getElementById('btnBridge');
            btn.innerHTML = 'מחייג...';
            btn.disabled = true;

            const params = new URLSearchParams({
                token: token, Phones: '0000000000', BridgePhones: target,
                DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0'
            });

            try {
                const res = await fetch(\`\${API_YEMOT}/CreateBridgeCall?\${params.toString()}\`);
                const data = await res.json();
                if(data.responseStatus === 'OK') alert('השיחה הוקמה. ענה ב-SIP שלך.');
                else alert('שגיאה: ' + data.message);
            } catch(e) { alert('שגיאת תקשורת'); }
            finally { btn.innerHTML = 'הוצא שיחה'; btn.disabled = false; }
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
            alert('הגדרות נשמרו');
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

        async function deleteContact(p) { await fetch(\`/api/contacts/\${p}\`, {method: 'DELETE'}); loadData(); }

        setInterval(loadData, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
