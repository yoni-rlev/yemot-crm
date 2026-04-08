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

// פורמט תגובה לימות המשיח עם הודעת פתיחה משופרת
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
    
    // הודעת פתיחה בפורמט TTS נקי ללא רווחים
    const welcomeMsg = "t-שלום.ברוכים_הבאים_לרחשי_לב.אנחנו_בודקים_לאן_להעביר_אותך";
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
    // הגדרת Header כדי להבטיח קריאת עברית תקינה בימות המשיח
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
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
                name: 'ללא בחירה', 
                routeType: db.defaultRouting.type, 
                destination: db.defaultRouting.destination 
            });
            saveDB();
            
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
        db.callLogs.unshift({ 
            time: new Date().toLocaleTimeString('he-IL'), 
            phone: pending.phone, 
            name: `ניתוב: ${name}`, 
            routeType: type, 
            destination: destination 
        });
        
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
// 3. ממשק ניהול משודרג (Premium Design)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@200;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; background-color: #f8fafc; }
        .modern-card { background: white; border-radius: 1.5rem; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02), 0 2px 4px -1px rgba(0,0,0,0.01); transition: transform 0.2s; }
        .modern-card:hover { transform: translateY(-2px); }
        .input-premium { background: #f1f5f9; border: 2px solid transparent; border-radius: 1rem; padding: 0.75rem 1rem; transition: all 0.2s; }
        .input-premium:focus { background: white; border-color: #6366f1; box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1); outline: none; }
        .btn-primary { background: #6366f1; color: white; border-radius: 1rem; font-weight: 700; transition: all 0.2s; }
        .btn-primary:hover { background: #4f46e5; transform: scale(1.02); }
        .btn-secondary { background: #f1f5f9; color: #475569; border-radius: 1rem; font-weight: 700; transition: all 0.2s; }
        .btn-secondary:hover { background: #e2e8f0; }
        .pulse-soft { animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
    </style>
</head>
<body class="p-4 md:p-8">

    <!-- פופ-אפ שיחה נכנסת משופר -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/80 z-[100] hidden items-center justify-center backdrop-blur-md">
        <div class="bg-white rounded-[3rem] shadow-2xl p-12 w-[32rem] text-center relative border border-white/20">
            <div class="absolute top-0 left-0 w-full h-3 bg-slate-100">
                <div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div>
            </div>
            <div class="bg-indigo-600 w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-8 shadow-xl shadow-indigo-200">
                <svg class="w-12 h-12 text-white animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
            </div>
            <h3 class="text-3xl font-extrabold text-slate-800 mb-2 italic">שיחה חדשה!</h3>
            <p class="text-slate-400 font-semibold mb-6">מזהה מספר מחייג:</p>
            <div id="popupPhone" class="text-5xl font-black text-indigo-600 mb-12 tracking-tighter" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-4"></div>
            <p class="mt-8 text-xs font-bold text-slate-300 uppercase tracking-widest">ניתוב אוטומטי בעוד <span id="popupTimer" class="text-indigo-600">5</span> שניות</p>
        </div>
    </div>

    <div class="max-w-7xl mx-auto">
        <!-- Header & Stats -->
        <header class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
            <div class="flex items-center gap-5">
                <div class="bg-indigo-600 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200 rotate-3">
                    <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </div>
                <div>
                    <h1 class="text-4xl font-black text-slate-800 tracking-tight">רחשי לב</h1>
                    <p class="text-slate-400 font-bold uppercase text-[10px] tracking-widest">מערכת בקרה חכמה</p>
                </div>
            </div>

            <div class="flex gap-4">
                <div class="bg-white px-6 py-3 rounded-2xl border border-slate-100 card-shadow flex items-center gap-4">
                    <div class="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center font-bold" id="statCallsToday">0</div>
                    <div class="text-[10px] font-bold text-slate-400 uppercase">שיחות היום</div>
                </div>
                <div class="bg-white px-6 py-3 rounded-2xl border border-slate-100 card-shadow flex items-center gap-4">
                    <div class="w-10 h-10 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold" id="statContacts">0</div>
                    <div class="text-[10px] font-bold text-slate-400 uppercase">אנשי קשר</div>
                </div>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            <!-- Sidebar -->
            <div class="lg:col-span-4 space-y-8">
                
                <!-- חיוג יוצא -->
                <section class="modern-card p-8">
                    <h2 class="text-sm font-black text-slate-400 uppercase mb-6 tracking-widest">חיוג יוצא (Click-to-Call)</h2>
                    <div class="space-y-4">
                        <input id="bridgeTarget" type="tel" placeholder="מספר לקוח..." class="w-full input-premium font-mono text-xl" dir="ltr">
                        <button id="btnBridge" onclick="startBridgeCall()" class="w-full btn-primary py-4 shadow-xl shadow-indigo-100">הוצא שיחה עכשיו</button>
                    </div>
                </section>

                <!-- הגדרות ניתוב -->
                <section class="modern-card p-8">
                    <h2 class="text-sm font-black text-slate-400 uppercase mb-6 tracking-widest">ניתוב חכם</h2>
                    <div class="space-y-6">
                        <div>
                            <label class="block text-xs font-bold text-slate-500 mb-2">יעד ברירת מחדל (למספרים לא מוכרים)</label>
                            <div class="flex gap-2">
                                <select id="defType" class="bg-slate-50 rounded-xl p-3 text-xs outline-none">
                                    <option value="folder">תיקייה</option>
                                    <option value="phone">טלפון</option>
                                    <option value="sip">SIP</option>
                                </select>
                                <input id="defDest" placeholder="יעד (/5)" class="flex-1 input-premium text-sm font-mono" dir="ltr">
                            </div>
                        </div>
                        <div class="space-y-3">
                            <label class="block text-xs font-bold text-slate-500">לחצני בחירה מהירה</label>
                            <div class="space-y-2">
                                <div class="flex gap-1 items-center bg-slate-50 p-2 rounded-2xl">
                                    <input id="q1Name" placeholder="שם" class="w-16 bg-transparent text-[11px] font-bold outline-none px-2">
                                    <select id="q1Type" class="bg-white rounded-lg p-1 text-[10px]"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                                    <input id="q1Dest" placeholder="יעד" class="flex-1 bg-white rounded-lg p-1 text-[11px] font-mono px-2">
                                </div>
                                <div class="flex gap-1 items-center bg-slate-50 p-2 rounded-2xl">
                                    <input id="q2Name" placeholder="שם" class="w-16 bg-transparent text-[11px] font-bold outline-none px-2">
                                    <select id="q2Type" class="bg-white rounded-lg p-1 text-[10px]"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                                    <input id="q2Dest" placeholder="יעד" class="flex-1 bg-white rounded-lg p-1 text-[11px] font-mono px-2">
                                </div>
                            </div>
                        </div>
                        <button onclick="saveSettings()" class="w-full btn-secondary py-3 text-sm">עדכן הגדרות</button>
                    </div>
                </section>

                <!-- הגדרות API -->
                <section class="bg-indigo-50/50 p-8 rounded-[2rem] border border-indigo-100">
                    <h2 class="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-4">הגדרות חיבור אישיות</h2>
                    <div class="space-y-3">
                        <input id="globalToken" type="password" placeholder="API Token" class="w-full bg-white rounded-xl p-3 text-xs outline-none border border-indigo-50 focus:border-indigo-200">
                        <input id="mySipExt" type="number" placeholder="השלוחה שלך (למשל 101)" class="w-full bg-white rounded-xl p-3 text-xs outline-none border border-indigo-50 focus:border-indigo-200">
                    </div>
                </section>
            </div>

            <!-- Content -->
            <div class="lg:col-span-8 space-y-8">
                
                <!-- CRM -->
                <section class="modern-card overflow-hidden">
                    <div class="p-8 border-b border-slate-50 flex justify-between items-center">
                        <h2 class="text-xl font-bold text-slate-800">ספר כתובות (CRM)</h2>
                        <div class="flex gap-3">
                            <input type="text" id="contactSearch" oninput="renderContacts()" placeholder="חיפוש..." class="bg-slate-50 px-4 py-2 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500">
                            <button onclick="toggleContactForm()" class="btn-primary px-5 py-2 text-xs font-bold">+ חדש</button>
                        </div>
                    </div>
                    
                    <div id="contactFormArea" class="hidden p-8 bg-indigo-50/30 border-b border-slate-100">
                        <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <input id="cName" placeholder="שם מלא" class="bg-white p-4 rounded-xl text-sm outline-none border border-indigo-50">
                            <input id="cPhone" placeholder="טלפון" class="bg-white p-4 rounded-xl text-sm outline-none border border-indigo-50" dir="ltr">
                            <select id="cType" class="bg-white p-4 rounded-xl text-sm outline-none border border-indigo-50"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                            <input id="cDest" placeholder="יעד (/10)" class="bg-white p-4 rounded-xl text-sm outline-none border border-indigo-50" dir="ltr">
                            <div class="md:col-span-4 text-left mt-2">
                                <button type="submit" class="btn-primary px-10 py-4">שמור לקוח</button>
                            </div>
                        </form>
                    </div>

                    <div class="overflow-x-auto">
                        <table class="w-full text-right">
                            <thead class="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                <tr>
                                    <th class="p-5 px-8">שם לקוח</th>
                                    <th class="p-5">מספר טלפון</th>
                                    <th class="p-5">יעד ניתוב</th>
                                    <th class="p-5 px-8 text-left">פעולה</th>
                                </tr>
                            </thead>
                            <tbody id="contactsList" class="divide-y divide-slate-50"></tbody>
                        </table>
                    </div>
                </section>

                <!-- Logs -->
                <section class="bg-slate-900 rounded-[2.5rem] shadow-2xl overflow-hidden border border-slate-800">
                    <div class="p-6 bg-slate-800/50 border-b border-slate-800 flex justify-between items-center">
                        <h2 class="text-xs font-bold text-slate-400 uppercase tracking-widest">לוג שיחות אחרונות</h2>
                        <span class="w-2.5 h-2.5 bg-indigo-500 rounded-full animate-ping"></span>
                    </div>
                    <div id="logsArea" class="h-96 overflow-y-auto p-8 space-y-4 font-mono text-[11px] text-slate-400">
                        <div class="text-center py-20 italic">ממתין לשיחות...</div>
                    </div>
                </section>
            </div>
        </div>
    </div>

    <script>
        const API_YEMOT = 'https://www.call2all.co.il/ym/api';
        const elToken = document.getElementById('globalToken');
        const elMySip = document.getElementById('mySipExt');
        let currentContacts = {};

        document.addEventListener('DOMContentLoaded', () => {
            if(localStorage.getItem('y_token')) elToken.value = localStorage.getItem('y_token');
            if(localStorage.getItem('y_sip')) elMySip.value = localStorage.getItem('y_sip');
            
            // אישור התראות דפדפן
            if (Notification.permission !== "granted") Notification.requestPermission();
            
            loadData();
        });

        elToken.oninput = () => localStorage.setItem('y_token', elToken.value);
        elMySip.oninput = () => localStorage.setItem('y_sip', elMySip.value);

        function toggleContactForm() {
            document.getElementById('contactFormArea').classList.toggle('hidden');
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

                currentContacts = data.contacts;
                renderContacts();
                renderLogs(data.callLogs);
                handlePending(data.pendingCalls);
                
                // עדכון סטטיסטיקה
                document.getElementById('statContacts').innerText = Object.keys(data.contacts).length;
                document.getElementById('statCallsToday').innerText = data.callLogs.filter(l => l.time.includes(new Date().toLocaleDateString('he-IL')) || true).length; // סינון פשוט לטסט
                
            } catch(e) {}
        }

        function renderContacts() {
            const list = document.getElementById('contactsList');
            const search = document.getElementById('contactSearch').value.toLowerCase();
            list.innerHTML = '';
            
            for(let phone in currentContacts) {
                const c = currentContacts[phone];
                if(c.name.toLowerCase().includes(search) || phone.includes(search)) {
                    list.innerHTML += \`<tr class="hover:bg-indigo-50/30 transition group">
                        <td class="p-5 px-8 font-extrabold text-slate-700">\${c.name}</td>
                        <td class="p-5 font-mono text-slate-400 group-hover:text-indigo-600 transition" dir="ltr">\${phone}</td>
                        <td class="p-5"><span class="bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full text-[10px] font-black uppercase border border-indigo-100">\${c.routeType}: \${c.destination}</span></td>
                        <td class="p-5 px-8 text-left"><button onclick="deleteContact('\${phone}')" class="text-slate-300 hover:text-red-500 font-bold transition">מחק</button></td>
                    </tr>\`;
                }
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            if(logs.length === 0) return;
            area.innerHTML = logs.map(l => \`
                <div class="bg-white/5 p-5 rounded-[1.5rem] border border-white/5 hover:border-indigo-500/50 transition">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-[9px] text-slate-500 font-bold opacity-50 uppercase tracking-widest">\${l.time}</span>
                        <span class="text-indigo-400 font-black">\${l.name}</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-slate-200 font-bold tracking-tight text-lg" dir="ltr">\${l.phone}</span>
                        <span class="text-emerald-400 font-bold text-[9px] tracking-widest bg-emerald-400/10 px-2 py-1 rounded-lg">&rarr; \${l.routeType.toUpperCase()}: \${l.destination}</span>
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
                    
                    // התראת דפדפן
                    if (Notification.permission === "granted") {
                        new Notification("שיחה חדשה ברחשי לב", { body: "מספר: " + call.phone });
                    }

                    document.getElementById('popupButtons').innerHTML = quickOptions.map((opt, i) => \`
                        <button onclick="resolveCall('\${call.id}', '\${opt.type}', '\${opt.destination}', '\${opt.name}')" 
                                class="bg-indigo-600 text-white py-6 rounded-3xl font-black text-xl hover:bg-indigo-700 shadow-xl shadow-indigo-100 transition active:scale-95">
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
            if(!token || !mySip || !target) return alert('נא למלא פרטי חיבור ויעד');

            const btn = document.getElementById('btnBridge');
            btn.innerHTML = '<span class="pulse-soft">מחייג...</span>';
            btn.disabled = true;

            const params = new URLSearchParams({
                token, Phones: '0000000000', BridgePhones: target,
                DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0'
            });

            try {
                const res = await fetch(\`\${API_YEMOT}/CreateBridgeCall?\${params.toString()}\`);
                const data = await res.json();
                if(data.responseStatus === 'OK') alert('שיחת גישור הוקמה. המתן לצלצול ב-SIP.');
                else alert('שגיאה מהמערכת: ' + data.message);
            } catch(e) { alert('שגיאת תקשורת'); }
            finally { btn.innerHTML = 'הוצא שיחה עכשיו'; btn.disabled = false; }
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
            alert('הגדרות עודכנו בהצלחה');
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

        async function deleteContact(p) { if(confirm('למחוק איש קשר זה?')) { await fetch(\`/api/contacts/\${p}\`, {method: 'DELETE'}); loadData(); } }

        setInterval(loadData, 2000);
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
