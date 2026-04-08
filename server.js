const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';

// --- ניהול מסד נתונים (Persistence) ---
let db = {
    defaultRouting: { type: 'phone', destination: '0501234567' },
    quickOptions: [
        { name: 'תמיכה (SIP)', type: 'sip', destination: '101' },
        { name: 'מכירות (נייד)', type: 'phone', destination: '0509999999' }
    ],
    contacts: {},
    callLogs: [],
    pendingCalls: []
};

// טעינת נתונים קיימים מהקובץ
if (fs.existsSync(DB_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DB_FILE));
        db = { ...db, ...savedData, pendingCalls: [] };
    } catch (e) { console.error("Error loading DB", e); }
}

// שמירת נתונים לקובץ
function saveDB() {
    try {
        const dataToSave = { ...db, pendingCalls: [] };
        fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) { console.error("Error saving DB", e); }
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// אובייקט לשמירת התגובות הממתינות (Webhook)
let activePendingCalls = {};

// פונקציית עזר לפורמט התשובה של ימות המשיח
function formatYemotResponse(type, destination) {
    let cmd = "";
    if (type === 'sip') {
        cmd = `routing_yemot=sip:${destination}`;
    } else if (type === 'folder') {
        // ניתוב לשלוחה פנימית (לדוגמה: /5)
        cmd = `go_to_folder=${destination}`;
    } else {
        cmd = `routing_yemot=${destination}`;
    }
    return `id_list_message=t-השיחה_מועברת_כעת&${cmd}`;
}

// עדכון רשימת הממתינים לשידור לממשק
function updatePendingList() {
    db.pendingCalls = Object.keys(activePendingCalls).map(id => ({
        id, phone: activePendingCalls[id].phone
    }));
}

// ==========================================
// 1. WEBHOOK - קבלת שיחה מימות המשיח
// ==========================================
app.all('/yemot_webhook', (req, res) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || 'חסוי';
    console.log(`שיחה נכנסת: ${apiPhone}`);

    // אם המספר שמור ב-CRM
    if (db.contacts[apiPhone]) {
        const c = db.contacts[apiPhone];
        const response = formatYemotResponse(c.routeType, c.destination);
        
        db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: apiPhone, name: c.name, routeType: c.routeType, destination: c.destination });
        if(db.callLogs.length > 50) db.callLogs.pop();
        saveDB();
        
        return res.send(response);
    }

    // אם המספר לא מוכר - פתיחת חלון זמן של 4.5 שניות
    const callId = Date.now().toString();
    const timeoutId = setTimeout(() => {
        if (activePendingCalls[callId]) {
            const pending = activePendingCalls[callId];
            delete activePendingCalls[callId];
            updatePendingList();
            
            const response = formatYemotResponse(db.defaultRouting.type, db.defaultRouting.destination);
            db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: 'ללא בחירה (ברירת מחדל)', routeType: db.defaultRouting.type, destination: db.defaultRouting.destination });
            saveDB();
            
            pending.res.send(response);
        }
    }, 4500);

    activePendingCalls[callId] = { res, timeoutId, phone: apiPhone };
    updatePendingList();
});

// ==========================================
// 2. API - תקשורת עם ממשק ה-HTML
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
        db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: `ידני: ${name}`, routeType: type, destination: destination });
        
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
// 3. ממשק הניהול (HTML)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CRM מרכזייה חכמה - ימות המשיח</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .loader { border-top-color: #3b82f6; animation: spinner 1s linear infinite; }
        @keyframes spinner { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .pulse-ring { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
    </style>
</head>
<body class="bg-slate-50 min-h-screen text-slate-800 font-sans">

    <!-- פופ-אפ שיחה נכנסת -->
    <div id="incomingPopup" class="fixed inset-0 bg-black/70 z-[100] hidden items-center justify-center backdrop-blur-md">
        <div class="bg-white rounded-3xl shadow-2xl p-8 w-96 text-center border-4 border-blue-500 relative">
            <div class="absolute -top-6 left-1/2 -translate-x-1/2 bg-blue-500 text-white p-3 rounded-full shadow-lg pulse-ring">
                <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
            </div>
            <h3 class="text-xl font-bold mt-4 mb-1">שיחה מלקוח חדש!</h3>
            <div id="popupPhone" class="text-4xl font-black text-blue-600 mb-6" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-3 mb-6"></div>
            <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                <div id="popupProgress" class="bg-blue-500 h-full w-full transition-all duration-100 ease-linear"></div>
            </div>
            <p class="text-xs mt-3 text-gray-500 font-bold uppercase tracking-widest">ניתוב אוטומטי בעוד <span id="popupTimer" class="text-red-500 text-sm">5</span> שניות</p>
        </div>
    </div>

    <header class="bg-blue-900 text-white p-6 shadow-xl mb-8">
        <div class="max-w-7xl mx-auto flex justify-between items-center">
            <div>
                <h1 class="text-3xl font-black italic tracking-tighter uppercase">Smart Yemot CRM</h1>
                <p class="text-blue-300 text-xs font-bold">מערכת ניהול ניתובים ו-CTI בשידור חי</p>
            </div>
            <div class="flex items-center gap-2">
                 <span class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
                 <span class="text-sm font-mono uppercase tracking-widest">Server Live</span>
            </div>
        </div>
    </header>

    <div class="max-w-7xl mx-auto px-4 grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        <div class="lg:col-span-2 space-y-6">
            <!-- הגדרות ניתוב -->
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                <h2 class="text-lg font-black mb-4 flex items-center gap-2 text-slate-700">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path></svg>
                    הגדרות ניתוב ובחירה מהירה
                </h2>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div class="space-y-4">
                        <label class="block text-xs font-black text-slate-400 uppercase">ניתוב ברירת מחדל</label>
                        <div class="flex gap-2">
                            <select id="defType" class="border rounded-xl p-3 bg-slate-50 w-24">
                                <option value="phone">טלפון</option>
                                <option value="sip">SIP</option>
                                <option value="folder">תיקייה</option>
                            </select>
                            <input id="defDest" type="text" placeholder="מספר יעד" class="border rounded-xl p-3 flex-1 bg-slate-50 font-mono" dir="ltr">
                        </div>
                    </div>
                    <div class="space-y-4">
                        <label class="block text-xs font-black text-slate-400 uppercase">אפשרויות פופ-אפ (Quick Select)</label>
                        <div class="space-y-2">
                            <div class="flex gap-1">
                                <input id="q1Name" placeholder="שם כפתור" class="border rounded-lg p-2 text-sm w-24">
                                <select id="q1Type" class="border rounded-lg p-2 text-sm"><option value="phone">טל</option><option value="sip">SIP</option><option value="folder">תיקייה</option></select>
                                <input id="q1Dest" placeholder="יעד" class="border rounded-lg p-2 text-sm flex-1 font-mono">
                            </div>
                            <div class="flex gap-1">
                                <input id="q2Name" placeholder="שם כפתור" class="border rounded-lg p-2 text-sm w-24">
                                <select id="q2Type" class="border rounded-lg p-2 text-sm"><option value="phone">טל</option><option value="sip">SIP</option><option value="folder">תיקייה</option></select>
                                <input id="q2Dest" placeholder="יעד" class="border rounded-lg p-2 text-sm flex-1 font-mono">
                            </div>
                        </div>
                    </div>
                </div>
                <button onclick="saveSettings()" class="w-full mt-8 bg-slate-800 text-white font-bold py-3 rounded-xl hover:bg-black transition shadow-lg">עדכן הגדרות מערכת</button>
            </div>

            <!-- CRM -->
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                <h2 class="text-lg font-black mb-4 text-slate-700 flex items-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
                    מאגר לקוחות וניתובים קבועים
                </h2>
                <form id="addContactForm" class="flex flex-wrap gap-2 mb-6 bg-blue-50/50 p-4 rounded-2xl border border-blue-100">
                    <input id="cName" placeholder="שם מלא" class="border p-3 rounded-xl flex-1 outline-none focus:ring-2 focus:ring-blue-500">
                    <input id="cPhone" placeholder="מספר מחייג" class="border p-3 rounded-xl flex-1 outline-none font-mono" dir="ltr">
                    <select id="cType" class="border p-3 rounded-xl"><option value="phone">טלפון</option><option value="sip">SIP</option><option value="folder">תיקייה</option></select>
                    <input id="cDest" placeholder="יעד סופי" class="border p-3 rounded-xl flex-1 outline-none font-mono" dir="ltr">
                    <button type="submit" class="bg-blue-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-blue-700">הוסף</button>
                </form>
                <div class="overflow-x-auto">
                    <table class="w-full text-right text-sm">
                        <thead class="bg-slate-100 text-slate-500 font-bold uppercase text-[10px] tracking-widest">
                            <tr><th class="p-4">לקוח</th><th class="p-4">מחייג</th><th class="p-4">סוג ניתוב</th><th class="p-4">יעד</th><th class="p-4"></th></tr>
                        </thead>
                        <tbody id="contactsList" class="divide-y border-t border-slate-100"></tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- לוגים -->
        <div class="space-y-6">
            <div class="bg-slate-900 rounded-2xl shadow-2xl overflow-hidden border border-slate-800">
                <div class="p-4 bg-slate-800/50 border-b border-slate-800 font-black text-white text-xs uppercase tracking-tighter flex justify-between">
                    <span>Call History Monitor</span>
                    <span class="text-blue-400">WebSocket Mirror</span>
                </div>
                <div id="logsArea" class="h-[600px] overflow-y-auto p-4 space-y-3 font-mono text-[11px]">
                    <div class="text-slate-600 text-center py-20">No active traffic detected...</div>
                </div>
            </div>
            <div class="bg-white p-6 rounded-2xl border-2 border-dashed border-slate-300">
                <p class="text-[10px] font-black text-slate-400 uppercase mb-2">Webhook API Endpoint:</p>
                <code class="bg-slate-100 p-2 rounded text-blue-600 block break-all text-[11px] font-mono" id="webhookUrl"></code>
            </div>
        </div>
    </div>

    <script>
        const webhookUrl = window.location.origin + '/yemot_webhook';
        document.getElementById('webhookUrl').innerText = webhookUrl;

        let quickOptions = [];
        let activeCallId = null;
        let timerInterval = null;

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
                list.innerHTML += \`<tr class="hover:bg-slate-50 transition">
                    <td class="p-4 font-bold text-slate-800">\${c.name}</td>
                    <td class="p-4 font-mono text-slate-500" dir="ltr">\${phone}</td>
                    <td class="p-4"><span class="px-2 py-1 bg-slate-100 rounded text-[10px] font-bold opacity-70">\${c.routeType}</span></td>
                    <td class="p-4 font-mono text-blue-600" dir="ltr">\${c.destination}</td>
                    <td class="p-4 text-left"><button onclick="deleteContact('\${phone}')" class="text-red-400 hover:text-red-600">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button></td>
                </tr>\`;
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            if(logs.length === 0) return;
            area.innerHTML = logs.map(l => \`
                <div class="bg-slate-800/30 p-3 rounded-lg border border-slate-800/50 mb-2">
                    <div class="flex justify-between text-[10px] text-slate-500 mb-1">
                        <span>\${l.time}</span>
                        <span class="text-blue-500 font-bold">\${l.name}</span>
                    </div>
                    <div class="flex justify-between items-center text-white">
                        <span dir="ltr">\${l.phone}</span>
                        <span class="text-green-500 text-[10px]">&rarr; \${l.routeType.toUpperCase()} \${l.destination}</span>
                    </div>
                </div>
            \`).join('');
        }

        function handlePending(pending) {
            const popup = document.getElementById('incomingPopup');
            if(pending.length > 0) {
                const call = pending[0];
                if(activeCallId !== call.id) {
                    activeCallId = call.id;
                    document.getElementById('popupPhone').innerText = call.phone;
                    
                    const btnArea = document.getElementById('popupButtons');
                    btnArea.innerHTML = quickOptions.map(opt => \`
                        <button onclick="resolveCall('\${call.id}', '\${opt.type}', '\${opt.destination}', '\${opt.name}')" 
                                class="bg-blue-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-blue-700 shadow-xl transform active:scale-95 transition">
                            \${opt.name}
                        </button>
                    \`).join('');
                    
                    popup.classList.remove('hidden');
                    popup.classList.add('flex');
                    
                    let timeLeft = 45;
                    clearInterval(timerInterval);
                    timerInterval = setInterval(() => {
                        timeLeft--;
                        document.getElementById('popupProgress').style.width = (timeLeft * 2.22) + '%';
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

        async function saveSettings() {
            const settings = {
                defaultRouting: { type: document.getElementById('defType').value, destination: document.getElementById('defDest').value },
                quickOptions: [
                    { name: document.getElementById('q1Name').value, type: document.getElementById('q1Type').value, destination: document.getElementById('q1Dest').value },
                    { name: document.getElementById('q2Name').value, type: document.getElementById('q2Type').value, destination: document.getElementById('q2Dest').value }
                ]
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
            alert('Settings Synchronized!');
        }

        document.getElementById('addContactForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = { name: document.getElementById('cName').value, phone: document.getElementById('cPhone').value, routeType: document.getElementById('cType').value, destination: document.getElementById('cDest').value };
            await fetch('/api/contacts', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            e.target.reset();
            loadData();
        });

        async function deleteContact(p) { await fetch(\`/api/contacts/\${p}\`, {method: 'DELETE'}); loadData(); }

        setInterval(loadData, 1000);
        loadData();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
