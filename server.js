const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
 
const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';

// --- ניהול מסד נתונים ---
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

// טעינת נתונים
if (fs.existsSync(DB_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DB_FILE));
        db = { ...db, ...savedData, pendingCalls: [] };
    } catch (e) { console.error("שגיאה בטעינת מסד הנתונים", e); }
}

// שמירה לקובץ
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
        // וודא שהנתיב מתחיל בלוכסן, לדוגמה /5
        const folderPath = destination.startsWith('/') ? destination : `/${destination}`;
        cmd = `go_to_folder=${folderPath}`;
    } else {
        cmd = `routing_yemot=${destination}`;
    }
    return `id_list_message=t-השיחה_מועברת_כעת&${cmd}`;
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
    
    // אם המספר שמור
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

    // אם לא מוכר - פופ-אפ ל-4.5 שניות
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
    }, 4500);

    activePendingCalls[callId] = { res, timeoutId, phone: apiPhone };
    updatePendingList();
});

// ==========================================
// 2. API פנימי לממשק
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
// 3. ממשק ניהול (HTML)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>מערכת ניהול שיחות - ימות המשיח</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .loader { border-top-color: #3b82f6; animation: spinner 1s linear infinite; }
        @keyframes spinner { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body class="bg-slate-50 min-h-screen text-slate-800 font-sans">

    <!-- פופ-אפ שיחה נכנסת -->
    <div id="incomingPopup" class="fixed inset-0 bg-black/70 z-[100] hidden items-center justify-center backdrop-blur-md">
        <div class="bg-white rounded-3xl shadow-2xl p-8 w-96 text-center border-4 border-blue-600">
            <h3 class="text-xl font-bold mb-1 text-slate-700">שיחה מלקוח חדש!</h3>
            <div id="popupPhone" class="text-3xl font-black text-blue-600 mb-6" dir="ltr"></div>
            <div id="popupButtons" class="grid grid-cols-1 gap-3 mb-6"></div>
            <div class="w-full bg-gray-200 rounded-full h-2">
                <div id="popupProgress" class="bg-blue-600 h-full w-full transition-all duration-100 linear"></div>
            </div>
            <p class="text-xs mt-3 text-slate-400">העברה אוטומטית בעוד <span id="popupTimer">5</span> שניות</p>
        </div>
    </div>

    <header class="bg-blue-800 text-white p-6 shadow-lg mb-8">
        <div class="max-w-7xl mx-auto flex justify-between items-center">
            <h1 class="text-2xl font-bold italic uppercase tracking-tighter">Smart CRM</h1>
            <div class="flex items-center gap-4 text-sm font-medium">
                <span class="flex items-center gap-2"><span class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span> שרת פעיל</span>
            </div>
        </div>
    </header>

    <div class="max-w-7xl mx-auto px-4 grid grid-cols-1 lg:grid-cols-3 gap-8 pb-10">
        
        <div class="lg:col-span-2 space-y-6">
            
            <!-- הגדרות חיבור -->
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                <h2 class="text-lg font-bold mb-4 text-slate-700">הגדרות חיבור (נשמר בדפדפן)</h2>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">טוקן API (Token)</label>
                        <input id="globalToken" type="password" placeholder="הכנס טוקן כאן..." class="w-full border rounded-xl p-3 bg-slate-50 outline-none focus:ring-2 focus:ring-blue-500">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">שלוחת ה-SIP שלך</label>
                        <input id="mySipExt" type="number" placeholder="לדוגמה: 101" class="w-full border rounded-xl p-3 bg-slate-50 outline-none focus:ring-2 focus:ring-blue-500">
                    </div>
                </div>
            </div>

            <!-- חיוג גישור (Bridge) -->
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-emerald-200">
                <h2 class="text-lg font-bold mb-4 text-emerald-800 flex items-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
                    חיוג יוצא (Bridge Call)
                </h2>
                <div class="flex gap-2">
                    <input id="bridgeTarget" type="tel" placeholder="מספר לקוח לחיוג" class="flex-1 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-emerald-500 font-mono" dir="ltr">
                    <button id="btnBridge" onclick="startBridgeCall()" class="bg-emerald-600 text-white font-bold px-6 py-3 rounded-xl hover:bg-emerald-700 transition shadow-md">חייג עכשיו</button>
                </div>
                <p class="text-[10px] text-slate-400 mt-2 italic">המערכת תחייג קודם אליך לשלוחה, ולאחר שתענה תחבר את הלקוח.</p>
            </div>

            <!-- ניתובים -->
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                <h2 class="text-lg font-bold mb-4 text-slate-700">ניהול ניתובים חכמים</h2>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <div class="space-y-4">
                        <label class="block text-xs font-bold text-slate-500 uppercase">ברירת מחדל</label>
                        <div class="flex gap-1">
                            <select id="defType" class="border rounded-lg p-2 bg-slate-50"><option value="phone">טלפון</option><option value="sip">SIP</option><option value="folder">תיקייה</option></select>
                            <input id="defDest" placeholder="יעד" class="border rounded-lg p-2 flex-1 font-mono">
                        </div>
                    </div>
                    <div class="space-y-4">
                        <label class="block text-xs font-bold text-slate-500 uppercase">לחצני בחירה מהירה בפופ-אפ</label>
                        <div class="space-y-2">
                            <div class="flex gap-1">
                                <input id="q1Name" placeholder="שם" class="border rounded-lg p-1 text-xs w-20">
                                <select id="q1Type" class="border rounded-lg p-1 text-xs"><option value="phone">טל</option><option value="sip">SIP</option><option value="folder">תיקייה</option></select>
                                <input id="q1Dest" placeholder="יעד" class="border rounded-lg p-1 text-xs flex-1">
                            </div>
                            <div class="flex gap-1">
                                <input id="q2Name" placeholder="שם" class="border rounded-lg p-1 text-xs w-20">
                                <select id="q2Type" class="border rounded-lg p-1 text-xs"><option value="phone">טל</option><option value="sip">SIP</option><option value="folder">תיקייה</option></select>
                                <input id="q2Dest" placeholder="יעד" class="border rounded-lg p-1 text-xs flex-1">
                            </div>
                        </div>
                    </div>
                </div>
                <button onclick="saveSettings()" class="w-full bg-slate-800 text-white font-bold py-3 rounded-xl hover:bg-black transition">שמור הגדרות ניתוב</button>
            </div>

            <!-- אנשי קשר -->
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                <h2 class="text-lg font-bold mb-4 text-slate-700">אנשי קשר (CRM)</h2>
                <form id="addContactForm" class="flex flex-wrap gap-2 mb-4 bg-slate-50 p-4 rounded-xl border">
                    <input id="cName" placeholder="שם מלא" class="border p-2 rounded-lg flex-1">
                    <input id="cPhone" placeholder="מספר לקוח" class="border p-2 rounded-lg flex-1" dir="ltr">
                    <select id="cType" class="border p-2 rounded-lg"><option value="phone">טלפון</option><option value="sip">SIP</option><option value="folder">תיקייה</option></select>
                    <input id="cDest" placeholder="יעד ניתוב" class="border p-2 rounded-lg flex-1" dir="ltr">
                    <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-lg font-bold">הוסף</button>
                </form>
                <div class="max-h-60 overflow-y-auto">
                    <table class="w-full text-right text-sm">
                        <thead class="bg-slate-100"><tr><th class="p-2">לקוח</th><th class="p-2">מחייג</th><th class="p-2">סוג</th><th class="p-2">יעד</th><th class="p-2"></th></tr></thead>
                        <tbody id="contactsList" class="divide-y"></tbody>
                    </table>
                </div>
            </div>
        </div>

        <div class="space-y-6">
            <!-- לוגים -->
            <div class="bg-slate-900 rounded-2xl shadow-xl overflow-hidden text-white">
                <div class="p-4 bg-slate-800 border-b border-slate-700 font-bold flex justify-between items-center text-xs">
                    <span>מוניטור שיחות (חי)</span>
                    <span class="text-blue-400">YEMOT MONITOR</span>
                </div>
                <div id="logsArea" class="h-[500px] overflow-y-auto p-4 space-y-3 font-mono text-[11px]">
                    <div class="text-slate-600 text-center py-20 italic">ממתין לתנועה בשרת...</div>
                </div>
            </div>
            
            <div class="bg-slate-100 p-4 rounded-2xl border-2 border-dashed border-slate-300 text-center">
                <p class="text-[10px] text-slate-500 mb-1 uppercase font-bold tracking-widest">כתובת ה-Webhook להגדרה בימות המשיח:</p>
                <code class="text-blue-600 block break-all text-[11px] font-bold" id="webhookUrl"></code>
            </div>
        </div>
    </div>

    <script>
        const API_YEMOT = 'https://www.call2all.co.il/ym/api';
        const elToken = document.getElementById('globalToken');
        const elMySip = document.getElementById('mySipExt');
        const webhookUrl = window.location.origin + '/yemot_webhook';
        document.getElementById('webhookUrl').innerText = webhookUrl;

        let quickOptions = [];
        let activeCallId = null;
        let timerInterval = null;

        // טעינה מהדפדפן
        document.addEventListener('DOMContentLoaded', () => {
            if(localStorage.getItem('y_token')) elToken.value = localStorage.getItem('y_token');
            if(localStorage.getItem('y_sip')) elMySip.value = localStorage.getItem('y_sip');
        });

        elToken.oninput = () => localStorage.setItem('y_token', elToken.value);
        elMySip.oninput = () => localStorage.setItem('y_sip', elMySip.value);

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
                    <td class="p-3 font-bold">\${c.name}</td>
                    <td class="p-3 font-mono" dir="ltr">\${phone}</td>
                    <td class="p-3 text-[10px] opacity-60 font-bold uppercase">\${c.routeType}</td>
                    <td class="p-3 font-mono text-blue-600" dir="ltr">\${c.destination}</td>
                    <td class="p-3 text-left"><button onclick="deleteContact('\${phone}')" class="text-red-500 font-bold hover:underline">מחק</button></td>
                </tr>\`;
            }
        }

        function renderLogs(logs) {
            const area = document.getElementById('logsArea');
            if(logs.length === 0) return;
            area.innerHTML = logs.map(l => \`
                <div class="bg-slate-800/40 p-3 rounded-xl border border-slate-800 mb-2">
                    <div class="flex justify-between text-[10px] text-slate-500 mb-1">
                        <span>\${l.time}</span>
                        <span class="text-blue-400 font-bold">\${l.name}</span>
                    </div>
                    <div class="flex justify-between items-center">
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
                                class="bg-blue-600 text-white py-4 rounded-2xl font-bold hover:bg-blue-700 shadow-lg active:scale-95 transition">
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

        // חיוג יוצא (Bridge)
        async function startBridgeCall() {
            const token = elToken.value;
            const mySip = elMySip.value;
            const target = document.getElementById('bridgeTarget').value;
            
            if(!token || !mySip || !target) return alert('חובה למלא טוקן, שלוחת SIP ומספר לקוח!');

            const btn = document.getElementById('btnBridge');
            btn.innerHTML = '<span class="loader border-2 border-white w-4 h-4 inline-block align-middle ml-2"></span> מחייג...';
            btn.disabled = true;

            const params = new URLSearchParams({
                token: token,
                Phones: '0000000000',
                BridgePhones: target,
                DialSip: '1',
                DialSipExtension: '1',
                SipExtension: mySip,
                RecordCall: '0'
            });

            try {
                const res = await fetch(\`\${API_YEMOT}/CreateBridgeCall?\${params.toString()}\`);
                const data = await res.json();
                if(data.responseStatus === 'OK') {
                    alert('בקשת חיוג נשלחה! ענה בטלפון ה-SIP שלך.');
                } else {
                    alert('שגיאה: ' + (data.message || 'לא ידועה'));
                }
            } catch(e) {
                alert('שגיאת תקשורת');
            } finally {
                btn.innerHTML = 'חייג עכשיו';
                btn.disabled = false;
            }
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
            alert('הגדרות סונכרנו!');
            loadData();
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
    console.log(`השרת רץ על פורט ${PORT}`);
});
