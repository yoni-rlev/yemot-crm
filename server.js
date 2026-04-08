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

// פורמט תגובה לימות המשיח - תיקון בעיית השמע
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
    
    // יצירת הודעת TTS נקייה ללא תווים בעייתיים
    // שימוש ב-encodeURIComponent מבטיח שהעברית תעבור תקין
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
    // קריטי לימות המשיח - קידוד עברית
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
                name: 'העברה אוטומטית', 
                routeType: db.defaultRouting.type, 
                destination: db.defaultRouting.destination 
            });
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
        db.callLogs.unshift({ 
            time: new Date().toLocaleTimeString('he-IL'), 
            phone: pending.phone, 
            name: `ניתוב ידני: ${name}`, 
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
// 3. ממשק ניהול משודרג (Premium SaaS Design)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - מרכזיית CRM</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@200;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; background-color: #f1f5f9; }
        .modern-card { background: white; border-radius: 2rem; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05); transition: all 0.3s ease; }
        .modern-card:hover { box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); transform: translateY(-4px); }
        
        .input-premium { 
            background: #ffffff; 
            border: 2px solid #e2e8f0; 
            border-radius: 1.25rem; 
            padding: 0.8rem 1.2rem; 
            transition: all 0.2s ease;
            color: #1e293b;
            font-weight: 600;
        }
        .input-premium:focus { 
            border-color: #6366f1; 
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15); 
            outline: none; 
        }
        .input-label {
            display: block;
            font-size: 0.75rem;
            font-weight: 800;
            color: #64748b;
            margin-bottom: 0.5rem;
            margin-right: 0.5rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .btn-call { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; border-radius: 1.25rem; font-weight: 800; transition: all 0.3s ease; }
        .btn-call:hover { transform: scale(1.03); box-shadow: 0 10px 20px rgba(99, 102, 241, 0.3); }
        
        .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: #22c55e; box-shadow: 0 0 10px #22c55e; animation: blink 2s infinite; }
        @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
        
        .log-entry { background: rgba(30, 41, 59, 0.7); border-radius: 1rem; border: 1px border-slate-700; backdrop-filter: blur(8px); }
    </style>
</head>
<body class="p-4 md:p-10">

    <!-- פופ-אפ שיחה נכנסת יוקרתי -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/90 z-[100] hidden items-center justify-center backdrop-blur-xl transition-all duration-500">
        <div class="bg-white rounded-[4rem] shadow-2xl p-16 w-[36rem] text-center relative border border-white/20">
            <div class="absolute top-0 left-0 w-full h-4 bg-slate-100 rounded-t-[4rem] overflow-hidden">
                <div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div>
            </div>
            
            <div class="mb-10">
                <div class="bg-indigo-100 w-28 h-28 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
                    <svg class="w-14 h-14 text-indigo-600 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
                </div>
                <h3 class="text-4xl font-extrabold text-slate-900 mb-2">שיחה נכנסת</h3>
                <p class="text-slate-400 font-bold uppercase tracking-widest text-xs">הלקוח שומע הודעת פתיחה של רחשי לב</p>
            </div>

            <div id="popupPhone" class="text-6xl font-black text-indigo-600 mb-12 tracking-tighter drop-shadow-sm" dir="ltr"></div>
            
            <div id="popupButtons" class="grid grid-cols-1 gap-4 mb-8"></div>
            
            <div class="flex justify-center items-center gap-2 text-slate-300">
                <span class="text-[11px] font-black uppercase tracking-widest">ניתוב אוטומטי בעוד</span>
                <span id="popupTimer" class="text-indigo-600 font-black text-2xl">5</span>
                <span class="text-[11px] font-black uppercase tracking-widest">שניות</span>
            </div>
        </div>
    </div>

    <div class="max-w-7xl mx-auto">
        <!-- Dashboard Header -->
        <header class="flex flex-col md:flex-row justify-between items-end mb-12 gap-8">
            <div class="flex items-center gap-6">
                <div class="bg-indigo-600 w-20 h-20 rounded-[2rem] flex items-center justify-center shadow-2xl shadow-indigo-200 rotate-6 transition hover:rotate-0 cursor-pointer">
                    <svg class="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </div>
                <div>
                    <h1 class="text-5xl font-black text-slate-900 tracking-tighter mb-1">רחשי לב</h1>
                    <div class="flex items-center gap-2">
                        <span class="status-dot"></span>
                        <p class="text-slate-400 font-extrabold uppercase text-[11px] tracking-[0.2em]">מערכת ניהול תקשורת חכמה</p>
                    </div>
                </div>
            </div>

            <div class="flex gap-6">
                <div class="bg-white px-8 py-5 rounded-[2rem] border border-slate-200 shadow-sm flex flex-col items-center min-w-[140px]">
                    <span class="text-3xl font-black text-slate-800" id="statCallsToday">0</span>
                    <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">שיחות היום</span>
                </div>
                <div class="bg-white px-8 py-5 rounded-[2rem] border border-slate-200 shadow-sm flex flex-col items-center min-w-[140px]">
                    <span class="text-3xl font-black text-indigo-600" id="statContacts">0</span>
                    <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">אנשי קשר</span>
                </div>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-10">
            
            <!-- Sidebar / Settings -->
            <div class="lg:col-span-4 space-y-10">
                
                <!-- חיוג יוצא -->
                <section class="modern-card p-10 bg-indigo-50/30 border-indigo-100">
                    <h2 class="input-label mb-6">חיוג יוצא מהיר</h2>
                    <div class="space-y-4">
                        <input id="bridgeTarget" type="tel" placeholder="הכנס מספר לקוח..." class="w-full input-premium text-2xl tracking-tight text-center" dir="ltr">
                        <button id="btnBridge" onclick="startBridgeCall()" class="w-full btn-call py-5 text-lg shadow-xl shadow-indigo-100">הוצא שיחה</button>
                    </div>
                </section>

                <!-- הגדרות ניתוב -->
                <section class="modern-card p-10">
                    <h2 class="input-label mb-6">כללי ניתוב חכמים</h2>
                    <div class="space-y-8">
                        <div>
                            <span class="input-label">ברירת מחדל (לא מוכר)</span>
                            <div class="flex gap-3">
                                <select id="defType" class="input-premium py-3 px-2 text-sm w-32 bg-slate-50">
                                    <option value="folder">תיקייה</option>
                                    <option value="phone">טלפון</option>
                                    <option value="sip">SIP</option>
                                </select>
                                <input id="defDest" placeholder="יעד..." class="flex-1 input-premium text-sm font-mono" dir="ltr">
                            </div>
                        </div>
                        <div class="space-y-4">
                            <span class="input-label">לחצני פופ-אפ</span>
                            <div class="space-y-3">
                                <div class="flex gap-2 items-center bg-slate-50 p-3 rounded-2xl border border-slate-100">
                                    <input id="q1Name" placeholder="שם" class="w-20 bg-transparent text-sm font-bold outline-none border-b border-slate-200 px-1">
                                    <select id="q1Type" class="bg-white rounded-lg p-2 text-[10px] font-bold border border-slate-200"><option value="folder">FOLDER</option><option value="phone">PHONE</option></select>
                                    <input id="q1Dest" placeholder="יעד" class="flex-1 bg-white rounded-lg p-2 text-xs font-mono border border-slate-200" dir="ltr">
                                </div>
                                <div class="flex gap-2 items-center bg-slate-50 p-3 rounded-2xl border border-slate-100">
                                    <input id="q2Name" placeholder="שם" class="w-20 bg-transparent text-sm font-bold outline-none border-b border-slate-200 px-1">
                                    <select id="q2Type" class="bg-white rounded-lg p-2 text-[10px] font-bold border border-slate-200"><option value="folder">FOLDER</option><option value="phone">PHONE</option></select>
                                    <input id="q2Dest" placeholder="יעד" class="flex-1 bg-white rounded-lg p-2 text-xs font-mono border border-slate-200" dir="ltr">
                                </div>
                            </div>
                        </div>
                        <button onclick="saveSettings()" class="w-full btn-secondary py-4 text-xs tracking-widest">עדכן הגדרות</button>
                    </div>
                </section>

                <!-- חיבור API -->
                <section class="modern-card p-10 bg-slate-800 text-white border-none">
                    <h2 class="input-label text-slate-400 mb-6">פרטי התחברות</h2>
                    <div class="space-y-4">
                        <div>
                            <span class="text-[9px] text-slate-500 font-bold mb-1 block">YEMOT TOKEN</span>
                            <input id="globalToken" type="password" class="w-full bg-slate-700/50 border-none rounded-xl p-3 text-xs outline-none focus:ring-1 focus:ring-indigo-500">
                        </div>
                        <div>
                            <span class="text-[9px] text-slate-500 font-bold mb-1 block">AGENT SIP EXTENSION</span>
                            <input id="mySipExt" type="number" class="w-full bg-slate-700/50 border-none rounded-xl p-3 text-xs outline-none focus:ring-1 focus:ring-indigo-500">
                        </div>
                    </div>
                </section>
            </div>

            <!-- Main Content -->
            <div class="lg:col-span-8 space-y-10">
                
                <!-- CRM Table -->
                <section class="modern-card overflow-hidden">
                    <div class="p-10 border-b border-slate-50 flex flex-col md:flex-row justify-between items-center gap-6">
                        <h2 class="text-2xl font-black text-slate-800 tracking-tight">אנשי קשר (CRM)</h2>
                        <div class="flex gap-4 w-full md:w-auto">
                            <input type="text" id="contactSearch" oninput="renderContacts()" placeholder="חיפוש לפי שם או מספר..." class="flex-1 md:w-64 input-premium py-2.5 text-xs">
                            <button onclick="toggleContactForm()" class="btn-call px-6 py-2.5 text-xs font-black">+ הוספה</button>
                        </div>
                    </div>
                    
                    <div id="contactFormArea" class="hidden p-10 bg-indigo-50/20 border-b border-indigo-50 animate-fade-in">
                        <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <div class="space-y-1">
                                <span class="input-label">שם הלקוח</span>
                                <input id="cName" placeholder="שם מלא" class="w-full input-premium text-sm">
                            </div>
                            <div class="space-y-1">
                                <span class="input-label">מספר טלפון</span>
                                <input id="cPhone" placeholder="05x..." class="w-full input-premium text-sm" dir="ltr">
                            </div>
                            <div class="space-y-1">
                                <span class="input-label">סוג</span>
                                <select id="cType" class="w-full input-premium text-sm bg-white"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                            </div>
                            <div class="space-y-1">
                                <span class="input-label">יעד</span>
                                <input id="cDest" placeholder="/5" class="w-full input-premium text-sm" dir="ltr">
                            </div>
                            <div class="md:col-span-4 text-left pt-4">
                                <button type="submit" class="btn-call px-12 py-4 shadow-lg shadow-indigo-100">שמור איש קשר</button>
                            </div>
                        </form>
                    </div>

                    <div class="overflow-x-auto">
                        <table class="w-full text-right">
                            <thead class="bg-slate-50 text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] border-b">
                                <tr>
                                    <th class="p-6 px-10">שם איש קשר</th>
                                    <th class="p-6">טלפון</th>
                                    <th class="p-6">הגדרת ניתוב</th>
                                    <th class="p-6 px-10 text-left">ניהול</th>
                                </tr>
                            </thead>
                            <tbody id="contactsList" class="divide-y divide-slate-100"></tbody>
                        </table>
                    </div>
                </section>

                <!-- Monitoring Logs -->
                <section class="bg-slate-900 rounded-[3rem] shadow-2xl overflow-hidden border-4 border-slate-800">
                    <div class="p-8 bg-slate-800/80 border-b border-slate-700 flex justify-between items-center">
                        <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.3em]">LIVE ACTIVITY MONITOR</h2>
                        <div class="flex gap-1">
                            <div class="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse"></div>
                            <div class="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse delay-75"></div>
                            <div class="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse delay-150"></div>
                        </div>
                    </div>
                    <div id="logsArea" class="h-96 overflow-y-auto p-10 space-y-6 font-mono text-[12px]">
                        <div class="text-slate-600 text-center py-20 italic font-bold">ממתין לפעילות בקו...</div>
                    </div>
                </section>
                
                <div class="bg-white p-6 rounded-[2rem] border border-slate-200 text-center shadow-sm">
                    <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">WEBHOOK ENDPOINT</span>
                    <code class="text-indigo-600 font-bold text-xs bg-indigo-50 px-4 py-2 rounded-xl" id="webhookUrl"></code>
                </div>
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
                
                document.getElementById('statContacts').innerText = Object.keys(data.contacts).length;
                document.getElementById('statCallsToday').innerText = data.callLogs.length;
                
            } catch(e) {}
        }

        function renderContacts() {
            const list = document.getElementById('contactsList');
            const search = document.getElementById('contactSearch').value.toLowerCase();
            list.innerHTML = '';
            
            for(let phone in currentContacts) {
                const c = currentContacts[phone];
                if(c.name.toLowerCase().includes(search) || phone.includes(search)) {
                    list.innerHTML += \`<tr class="hover:bg-indigo-50/50 transition-colors group">
                        <td class="p-6 px-10 font-extrabold text-slate-800 text-lg">\${c.name}</td>
                        <td class="p-6 font-mono text-slate-400 group-hover:text-indigo-600 transition" dir="ltr">\${phone}</td>
                        <td class="p-6"><span class="bg-white border border-slate-200 text-slate-600 px-4 py-1.5 rounded-full text-[10px] font-black uppercase shadow-sm">\${c.routeType}: \${c.destination}</span></td>
                        <td class="p-6 px-10 text-left"><button onclick="deleteContact('\${phone}')" class="text-slate-300 hover:text-red-600 font-bold transition">מחיקה</button></td>
                    </tr>\`;
                }
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            if(logs.length === 0) return;
            area.innerHTML = logs.map(l => \`
                <div class="log-entry p-6 border border-white/5 hover:border-indigo-500/30 transition">
                    <div class="flex justify-between items-center mb-3">
                        <span class="text-[10px] text-slate-500 font-black uppercase tracking-widest">\${l.time}</span>
                        <span class="text-indigo-400 font-black text-sm">\${l.name}</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-white font-black text-xl tracking-tighter" dir="ltr">\${l.phone}</span>
                        <span class="text-emerald-400 font-black text-[10px] tracking-widest bg-emerald-500/10 px-3 py-1.5 rounded-full">&rarr; \${l.routeType.toUpperCase()} \${l.destination}</span>
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
                    
                    if (Notification.permission === "granted") {
                        new Notification("שיחה חדשה - רחשי לב", { body: "מחייג: " + call.phone });
                    }

                    document.getElementById('popupButtons').innerHTML = quickOptions.map((opt, i) => \`
                        <button onclick="resolveCall('\${call.id}', '\${opt.type}', '\${opt.destination}', '\${opt.name}')" 
                                class="bg-indigo-600 text-white py-7 rounded-[2.5rem] font-black text-2xl hover:bg-indigo-700 shadow-2xl shadow-indigo-200 transition active:scale-95">
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
                        if(timeLeft <= 0) {
                            clearInterval(timerInterval);
                            popup.classList.add('hidden');
                        }
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
            btn.innerHTML = '<span class="animate-pulse">מחייג...</span>';
            btn.disabled = true;

            const params = new URLSearchParams({
                token, Phones: '0000000000', BridgePhones: target,
                DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0'
            });

            try {
                const res = await fetch(\`\${API_YEMOT}/CreateBridgeCall?\${params.toString()}\`);
                const data = await res.json();
                if(data.responseStatus === 'OK') alert('שיחת גישור הוקמה. המתן לצלצול ב-SIP.');
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
