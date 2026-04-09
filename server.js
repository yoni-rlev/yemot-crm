const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer'); // ספרייה לטיפול בהעלאת קבצים

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';
const UPLOADS_DIR = './uploads';

// יצירת תיקיית העלאות אם לא קיימת
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

// הגדרת אחסון קבצים
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        // שמירה בשם קבוע לפי סוג ההודעה כדי להחליף קבצים קיימים
        const ext = path.extname(file.originalname);
        const fileName = req.body.fileType === 'welcome' ? 'welcome' : 'transition';
        cb(null, fileName + ext);
    }
});
const upload = multer({ storage: storage });

// --- Database Management ---
let db = {
    settings: {
        welcomeFileName: '',      // שם הקובץ בשרת שלנו
        transitionFileName: '',   // שם קובץ המעבר
        defaultRoute: { type: 'folder', destination: '/5' }
    },
    quickOptions: [
        { name: 'תמיכה טכנית', type: 'folder', destination: '/1' },
        { name: 'מחלקת מכירות', type: 'folder', destination: '/2' }
    ],
    contacts: {},
    callLogs: [],
    pendingCalls: []
};

// טעינת נתונים
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
// חשיפת תיקיית הקבצים לאינטרנט כדי שימות המשיח יוכלו להוריד אותם
app.use('/uploads', express.static(UPLOADS_DIR));

let activePendingCalls = {};

// בניית תשובה לימות המשיח המבוססת על קבצים מהשרת שלנו
function formatYemotResponse(req, type, destination, isTransition = false) {
    let cmd = "";
    if (type === 'sip') {
        cmd = `routing_yemot=sip:${destination}`;
    } else if (type === 'folder') {
        const folderPath = destination.startsWith('/') ? destination : `/${destination}`;
        cmd = `go_to_folder=${folderPath}`;
    } else {
        cmd = `routing_yemot=${destination}`;
    }
    
    // יצירת כתובת URL מלאה לקובץ השמע בשרת שלנו
    const protocol = req.protocol;
    const host = req.get('host');
    const fileName = isTransition ? db.settings.transitionFileName : db.settings.welcomeFileName;
    
    let audioCmd = "";
    if (fileName) {
        // h- אומר לימות המשיח להוריד קובץ מכתובת HTTP חיצונית
        const fileUrl = `${protocol}://${host}/uploads/${fileName}`;
        audioCmd = `id_list_message=h-${fileUrl}`;
    } else {
        // ברירת מחדל אם אין קובץ
        audioCmd = `id_list_message=t-אנא_המתן_השיחה_מועברת`;
    }

    return `${audioCmd}&${cmd}`;
}

function updatePendingList() {
    db.pendingCalls = Object.keys(activePendingCalls).map(id => ({
        id, phone: activePendingCalls[id].phone
    }));
}

// 1. Webhook Endpoint
app.all('/yemot_webhook', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || 'חסוי';
    
    if (db.contacts[apiPhone]) {
        const c = db.contacts[apiPhone];
        const response = formatYemotResponse(req, c.routeType, c.destination, true);
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
            
            const response = formatYemotResponse(req, db.settings.defaultRoute.type, db.settings.defaultRoute.destination);
            db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: 'ניתוב אוטומטי', routeType: db.settings.defaultRoute.type, destination: db.settings.defaultRoute.destination });
            saveDB();
            pending.res.send(response);
        }
    }, 5000);

    activePendingCalls[callId] = { res, timeoutId, phone: apiPhone };
    updatePendingList();
});

// 2. API Routes
app.get('/api/data', (req, res) => res.json(db));
app.post('/api/settings', (req, res) => { db.settings = req.body.settings; saveDB(); res.json({ success: true }); });
app.post('/api/contacts', (req, res) => { const { phone, name, routeType, destination } = req.body; db.contacts[phone] = { name, routeType, destination }; saveDB(); res.json({ success: true }); });
app.delete('/api/contacts/:phone', (req, res) => { delete db.contacts[req.params.phone]; saveDB(); res.json({ success: true }); });

// API להעלאת קבצים
app.post('/api/upload', upload.single('audioFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    if (req.body.fileType === 'welcome') {
        db.settings.welcomeFileName = req.file.filename;
    } else {
        db.settings.transitionFileName = req.file.filename;
    }
    saveDB();
    res.json({ success: true, fileName: req.file.filename });
});

app.post('/api/resolve_call', (req, res) => {
    const { id, type, destination, name } = req.body;
    if (activePendingCalls[id]) {
        const pending = activePendingCalls[id];
        clearTimeout(pending.timeoutId);
        const response = formatYemotResponse(req, type, destination, true);
        db.callLogs.unshift({ time: new Date().toLocaleTimeString('he-IL'), phone: pending.phone, name: `ידני: ${name}`, routeType: type, destination: destination });
        delete activePendingCalls[id];
        updatePendingList();
        saveDB();
        pending.res.send(response);
        res.json({ success: true });
    } else { res.json({ success: false }); }
});

// 3. UI Interface
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>רחשי לב - CRM מרכזייה</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@200;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Assistant', sans-serif; background-color: #f1f5f9; color: #1e293b; }
        .premium-card { background: white; border-radius: 1.5rem; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .input-premium { 
            background: #ffffff; 
            border: 3px solid #cbd5e1; 
            border-radius: 0.8rem; 
            padding: 0.6rem 1rem; 
            width: 100%; 
            font-weight: 700; 
            color: #334155;
            transition: all 0.2s;
        }
        .input-premium:focus { border-color: #6366f1; background: #fdfdff; outline: none; }
        .btn-call { background: #6366f1; color: white; border-radius: 0.8rem; padding: 0.8rem; font-weight: 800; transition: all 0.2s; cursor: pointer; text-align: center; }
        .btn-call:hover { background: #4f46e5; transform: translateY(-2px); box-shadow: 0 10px 15px rgba(99, 102, 241, 0.2); }
        .toast-notify { position: fixed; bottom: 30px; left: 30px; z-index: 1000; padding: 1rem 2rem; border-radius: 1rem; color: white; font-weight: 800; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2); transform: translateX(-200%); transition: all 0.5s ease; }
        .file-status { font-size: 10px; font-weight: bold; margin-top: 5px; color: #6366f1; }
    </style>
</head>
<body class="p-4 md:p-8">

    <div id="toast" class="toast-notify bg-indigo-600">פעולה בוצעה</div>

    <!-- פופ-אפ שיחה נכנסת -->
    <div id="incomingPopup" class="fixed inset-0 bg-slate-900/90 z-[100] hidden items-center justify-center backdrop-blur-xl transition-all duration-500">
        <div class="bg-white rounded-[4rem] shadow-2xl p-12 w-[34rem] text-center border-4 border-indigo-600 relative">
            <div class="absolute top-0 left-0 w-full h-4 bg-slate-100 rounded-t-[4rem] overflow-hidden"><div id="popupProgress" class="bg-indigo-600 h-full w-full transition-all duration-100 linear"></div></div>
            <h3 class="text-3xl font-black text-slate-800 mb-8 italic uppercase tracking-tighter underline decoration-indigo-200">Incoming Call</h3>
            <div id="popupPhone" class="text-6xl font-black text-indigo-600 mb-12 tracking-tighter" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-5 mb-8"></div>
            <div class="text-[12px] font-black uppercase text-slate-300 italic tracking-widest">ניתוב אוטומטי בעוד <span id="popupTimer" class="text-indigo-600 text-xl">5</span> שניות</div>
        </div>
    </div>

    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <header class="flex flex-col lg:flex-row justify-between items-center mb-12 gap-6">
            <div class="flex items-center gap-6">
                <div class="bg-indigo-600 w-16 h-16 rounded-2xl flex items-center justify-center shadow-2xl shadow-indigo-100 rotate-3">
                    <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </div>
                <div>
                    <h1 class="text-4xl font-black tracking-tighter text-slate-900 italic underline decoration-indigo-500">רחשי לב</h1>
                    <p class="text-slate-400 font-bold uppercase text-[10px] tracking-[0.3em] mt-1">מערכת ניהול שיחות חכמה</p>
                </div>
            </div>
            <div class="flex items-center gap-4">
                <div class="bg-white px-6 py-3 rounded-full border-2 border-slate-100 shadow-sm flex items-center gap-3">
                    <span class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
                    <span class="text-[11px] font-black text-slate-500 uppercase tracking-widest">System Online</span>
                </div>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-10">
            
            <!-- Left Sidebar -->
            <div class="lg:col-span-4 space-y-8">
                
                <!-- ניהול קבצי שמע -->
                <section class="premium-card p-8 bg-indigo-50/50 border-indigo-100 shadow-lg">
                    <h2 class="text-xs font-black text-indigo-900 uppercase mb-6 tracking-widest border-b border-indigo-100 pb-2">ניהול קבצי שמע בשרת</h2>
                    
                    <div class="space-y-6">
                        <div>
                            <label class="block text-[10px] font-black text-slate-500 mb-2 uppercase">הודעת פתיחה (פופ-אפ)</label>
                            <input type="file" id="fileWelcome" class="hidden" onchange="uploadFile('welcome')">
                            <button onclick="document.getElementById('fileWelcome').click()" class="w-full bg-white border-2 border-dashed border-indigo-300 p-4 rounded-xl text-xs font-bold hover:bg-indigo-100 transition">
                                בחר הודעת פתיחה
                            </button>
                            <div id="statusWelcome" class="file-status">ממתין להעלאה...</div>
                        </div>

                        <div>
                            <label class="block text-[10px] font-black text-slate-500 mb-2 uppercase">הודעת מעבר (מעבירים אותך...)</label>
                            <input type="file" id="fileTransition" class="hidden" onchange="uploadFile('transition')">
                            <button onclick="document.getElementById('fileTransition').click()" class="w-full bg-white border-2 border-dashed border-indigo-300 p-4 rounded-xl text-xs font-bold hover:bg-indigo-100 transition">
                                בחר הודעת מעבר
                            </button>
                            <div id="statusTransition" class="file-status">ממתין להעלאה...</div>
                        </div>
                    </div>
                </section>

                <!-- חיבור כללי -->
                <section class="premium-card p-8">
                    <h2 class="text-xs font-black text-slate-400 uppercase mb-6 tracking-widest border-b border-slate-100 pb-2">הגדרות חיבור</h2>
                    <div class="space-y-4">
                        <div>
                            <label class="block text-[10px] font-black text-slate-400 mb-1">API TOKEN</label>
                            <input id="globalToken" type="password" placeholder="Token..." class="input-premium">
                        </div>
                        <div>
                            <label class="block text-[10px] font-black text-slate-400 mb-1">MY SIP (BRIDGE)</label>
                            <input id="mySipExt" type="number" placeholder="101" class="input-premium">
                        </div>
                        <button onclick="saveSystemSettings()" class="btn-call w-full mt-4 py-4 text-xs tracking-widest uppercase">Update Sync</button>
                    </div>
                </section>
            </div>

            <!-- Right Content -->
            <div class="lg:col-span-8 space-y-10">
                <!-- חיוג גישור מהיר -->
                <section class="premium-card p-10 bg-slate-900 text-white border-none shadow-2xl relative overflow-hidden">
                    <div class="absolute top-0 right-0 w-32 h-32 bg-indigo-600/10 rounded-full -mr-16 -mt-16 blur-3xl"></div>
                    <div class="flex flex-col md:flex-row gap-6 items-end relative z-10">
                        <div class="flex-1 w-full">
                            <label class="text-[10px] font-black text-slate-500 mb-2 block uppercase tracking-widest">Quick Dial Connection</label>
                            <input id="bridgeTarget" placeholder="הזן מספר לקוח..." class="w-full bg-slate-800 border-2 border-slate-700 rounded-2xl p-5 text-white text-4xl font-black outline-none focus:border-indigo-500 transition" dir="ltr">
                        </div>
                        <button onclick="startBridgeCall()" class="btn-call bg-indigo-600 h-[88px] px-14 text-xl shadow-2xl">חייג גשר</button>
                    </div>
                </section>

                <!-- טבלת CRM -->
                <section class="premium-card overflow-hidden">
                    <div class="p-10 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                        <h2 class="text-2xl font-black tracking-tighter">לקוחות וניתובים</h2>
                        <button onclick="document.getElementById('addContactArea').classList.toggle('hidden')" class="bg-indigo-600 text-white py-2.5 px-8 rounded-xl text-xs font-bold shadow-lg shadow-indigo-100 transition active:scale-95">+ Add New</button>
                    </div>
                    
                    <div id="addContactArea" class="hidden p-10 bg-indigo-50/20 border-b border-indigo-100">
                        <form id="addContactForm" class="grid grid-cols-1 md:grid-cols-4 gap-4 italic font-bold">
                            <input id="cName" placeholder="שם מלא" class="input-premium text-sm">
                            <input id="cPhone" placeholder="טלפון" class="input-premium text-sm" dir="ltr">
                            <select id="cType" class="input-premium text-sm bg-white"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                            <input id="cDest" placeholder="יעד (/5)" class="input-premium text-sm" dir="ltr">
                            <button type="submit" class="md:col-span-4 btn-call py-4">שמור לקוח</button>
                        </form>
                    </div>

                    <div class="overflow-x-auto">
                        <table class="w-full text-right">
                            <thead class="bg-slate-50 text-slate-400 font-black uppercase text-[10px] tracking-[0.2em] border-b">
                                <tr><th class="p-8 px-10">שם לקוח</th><th class="p-8">טלפון</th><th class="p-8">ניתוב קבוע</th><th class="p-8 text-left">ניהול</th></tr>
                            </thead>
                            <tbody id="contactsList" class="divide-y divide-slate-100"></tbody>
                        </table>
                    </div>
                </section>

                <!-- הגדרות ניתוב אוטומטי -->
                <section class="premium-card p-10">
                    <h2 class="text-xs font-black text-slate-400 uppercase mb-8 tracking-widest border-b pb-4 italic">Routing Configuration</h2>
                    <div class="flex gap-4">
                        <div class="flex-1">
                            <label class="text-[10px] font-black text-slate-400 uppercase block mb-1">ניתוב ברירת מחדל (Default)</label>
                            <div class="flex gap-2">
                                <select id="defType" class="input-premium w-32 py-3 text-xs"><option value="folder">תיקייה</option><option value="phone">טלפון</option></select>
                                <input id="defDest" placeholder="/5" class="input-premium py-3 text-sm font-mono">
                            </div>
                        </div>
                        <button onclick="saveSystemSettings()" class="bg-slate-800 text-white px-12 rounded-2xl font-black text-xs uppercase tracking-widest mt-5 hover:bg-slate-900 transition">Update</button>
                    </div>
                </section>

                <!-- לוג שיחות -->
                <section class="premium-card p-10 bg-slate-900 border-4 border-slate-800 shadow-2xl">
                    <h2 class="text-[11px] font-black text-slate-500 uppercase mb-8 tracking-[0.5em] flex justify-between items-center">
                        <span>Traffic Monitor</span>
                        <div class="flex gap-1"><span class="w-1.5 h-1.5 bg-blue-500 rounded-full animate-ping"></span></div>
                    </h2>
                    <div id="logsArea" class="h-64 overflow-y-auto space-y-4 font-mono text-[13px]"></div>
                </section>
                
                <div class="bg-white p-6 rounded-[2.5rem] border-2 border-dashed border-slate-300 text-center shadow-sm">
                    <p class="text-[10px] font-black text-slate-400 uppercase mb-2 tracking-widest italic">Yemot Webhook API Endpoint</p>
                    <code class="text-indigo-600 font-bold bg-indigo-50 px-4 py-2 rounded-xl text-xs" id="webhookUrl"></code>
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
            setTimeout(() => { t.style.transform = 'translateX(-200%)'; }, 4000);
        }

        async function uploadFile(type) {
            const input = type === 'welcome' ? document.getElementById('fileWelcome') : document.getElementById('fileTransition');
            const status = type === 'welcome' ? document.getElementById('statusWelcome') : document.getElementById('statusTransition');
            
            if (!input.files[0]) return;
            
            status.innerText = "מעלה קובץ...";
            const formData = new FormData();
            formData.append('audioFile', input.files[0]);
            formData.append('fileType', type);
            
            try {
                const res = await fetch('/api/upload', { method: 'POST', body: formData });
                const data = await res.json();
                if (data.success) {
                    status.innerText = "קובץ פעיל: " + data.fileName;
                    showToast("הקובץ הועלה בהצלחה!");
                }
            } catch (e) {
                status.innerText = "שגיאת העלאה";
                showToast("העלאה נכשלה", true);
            }
        }

        async function loadData() {
            try {
                const res = await fetch('/api/data');
                const data = await res.json();
                
                if(document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
                    document.getElementById('globalToken').value = localStorage.getItem('y_token') || '';
                    document.getElementById('mySipExt').value = localStorage.getItem('y_sip') || '';
                    document.getElementById('defType').value = data.settings.defaultRoute.type;
                    document.getElementById('defDest').value = data.settings.defaultRoute.destination;
                    
                    if (data.settings.welcomeFileName) document.getElementById('statusWelcome').innerText = "קובץ פעיל: " + data.settings.welcomeFileName;
                    if (data.settings.transitionFileName) document.getElementById('statusTransition').innerText = "קובץ פעיל: " + data.settings.transitionFileName;
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
                list.innerHTML += \`<tr class="hover:bg-indigo-50/50 transition"><td class="p-8 px-10 font-black text-2xl text-slate-800 tracking-tight">\${c.name}</td><td class="p-8 font-mono text-slate-400 text-xl">\${phone}</td><td class="p-8 text-indigo-600 font-bold italic">\${c.routeType.toUpperCase()} &rarr; \${c.destination}</td><td class="p-8 text-left"><button onclick="deleteContact('\${phone}')" class="text-red-500 font-black hover:underline uppercase text-[10px]">Delete</button></td></tr>\`;
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            area.innerHTML = logs.map(l => \`<div class="bg-white/5 p-4 rounded-2xl border border-white/5 flex justify-between items-center text-slate-400 group hover:border-indigo-500/20 transition-colors"><span class="text-[9px] font-black opacity-40 uppercase">\${l.time}</span><span class="text-white font-black text-lg tracking-tighter" dir="ltr">\${l.phone}</span><span class="text-emerald-400 font-black text-[11px] uppercase tracking-widest">&rarr; \${l.routeType}: \${l.destination}</span></div>\`).join('');
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

                    let timeLeft = 50; clearInterval(timerInterval);
                    timerInterval = setInterval(() => { timeLeft--; document.getElementById('popupProgress').style.width = (timeLeft * 2) + '%'; document.getElementById('popupTimer').innerText = Math.ceil(timeLeft / 10); if(timeLeft <= 0) { clearInterval(timerInterval); popup.classList.add('hidden'); } }, 100);
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
            if(!token || !mySip || !target) return showToast('מלא פרטים קודם', true);
            localStorage.setItem('y_token', token); localStorage.setItem('y_sip', mySip);
            const params = new URLSearchParams({ token, Phones: '0000000000', BridgePhones: target, DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0' });
            const res = await fetch(\`https://www.call2all.co.il/ym/api/CreateBridgeCall?\${params.toString()}\`);
            const data = await res.json();
            if(data.responseStatus === 'OK') showToast('שיחת גישור הוקמה!');
            else showToast('שגיאה ביצירת הגשר', true);
        }

        async function saveSystemSettings() {
            const settings = {
                settings: {
                    welcomeFileName: db.settings.welcomeFileName,
                    transitionFileName: db.settings.transitionFileName,
                    defaultRoute: { type: document.getElementById('defType').value, destination: document.getElementById('defDest').value }
                }
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
            showToast('הגדרות נשמרו!'); loadData();
        }

        document.getElementById('addContactForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = { name: document.getElementById('cName').value, phone: document.getElementById('cPhone').value, routeType: document.getElementById('cType').value, destination: document.getElementById('cDest').value };
            await fetch('/api/contacts', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            e.target.reset(); loadData();
        });

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
