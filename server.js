const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs'); // ספרייה לשמירת קבצים

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json'; // קובץ שמירת הנתונים

// --- מסד נתונים זמני (בזיכרון השרת) ---
let db = {
    defaultRouting: { 
        type: 'phone',
        destination: '0501234567'
    },
    quickOptions: [
        { name: 'תמיכה טכנית', type: 'sip', destination: '101' },
        { name: 'מחלקת מכירות', type: 'phone', destination: '0509999999' }
    ],
    contacts: {},
    callLogs: [],
    pendingCalls: [] // נתונים לשידור לדפדפן על שיחות שממתינות להחלטה
};

// טעינת הנתונים מקובץ בעת הפעלת השרת (אם קיים)
if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE);
        const savedData = JSON.parse(rawData);
        // ממזגים את הנתונים השמורים, מאפסים תמיד את השיחות הממתינות
        db = { ...db, ...savedData, pendingCalls: [] }; 
    } catch(err) {
        console.error("שגיאה בטעינת מסד הנתונים, ממשיך עם נתוני בסיס", err);
    }
}

// פונקציית עזר לשמירת הנתונים לקובץ
function saveDatabase() {
    // שומרים רק את ההגדרות ואנשי הקשר (אין צורך לשמור שיחות ממתינות בענן)
    const dbToSave = {
        defaultRouting: db.defaultRouting,
        quickOptions: db.quickOptions,
        contacts: db.contacts,
        callLogs: db.callLogs
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(dbToSave, null, 2));
}

// אובייקט פנימי לשמירת ה-Response הפתוח מול ימות המשיח
let activePendingCalls = {};

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// פונקציית עזר לבניית פקודת הניתוב
function buildYemotRoute(type, dest) {
    return type === 'sip' ? `sip:${dest}` : dest;
}

// פונקציית עזר להוספת לוגים
function addLog(phone, name, routeType, destination) {
    const time = new Date().toLocaleTimeString('he-IL');
    db.callLogs.unshift({ time, phone, name, routeType, destination });
    if (db.callLogs.length > 50) db.callLogs.pop();
    console.log(`[${time}] שיחה מ: ${phone} (${name}) -> ${routeType}:${destination}`);
    saveDatabase(); // שמירת הלוגים לקובץ
}

// פונקציית עזר לעדכון רשימת השיחות הממתינות לדפדפן
function updatePendingDb() {
    db.pendingCalls = Object.keys(activePendingCalls).map(id => ({
        id, phone: activePendingCalls[id].phone
    }));
}

// ==========================================
// 1. ה-Webhook של ימות המשיח 
// ==========================================
app.all('/yemot_webhook', (req, res) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || 'חסוי';
    
    // 1. בדיקה אם המספר קיים באנשי הקשר (ניתוב מיידי)
    if (apiPhone !== 'חסוי' && db.contacts[apiPhone]) {
        const contact = db.contacts[apiPhone];
        addLog(apiPhone, contact.name, contact.routeType, contact.destination);
        res.send(`id_list_message=t-השיחה_מועברת_כעת&routing_yemot=${buildYemotRoute(contact.routeType, contact.destination)}`);
        return;
    }

    // 2. אם המספר לא מוכר - פתיחת השהייה (Pending Call)
    const callId = Date.now().toString();
    let isResolved = false;

    // טיימר ל-4.5 שניות (קריטי: מונע ניתוק בשרתי ימות המשיח)
    const timeoutId = setTimeout(() => {
        if (!isResolved) {
            isResolved = true;
            delete activePendingCalls[callId];
            updatePendingDb();
            
            addLog(apiPhone, 'לא נבחר (ברירת מחדל)', db.defaultRouting.type, db.defaultRouting.destination);
            res.send(`id_list_message=t-השיחה_מועברת_כעת&routing_yemot=${buildYemotRoute(db.defaultRouting.type, db.defaultRouting.destination)}`);
        }
    }, 4500);

    // שמירת הבקשה בזיכרון עד שהנציג ילחץ על משהו
    activePendingCalls[callId] = { res, timeoutId, phone: apiPhone };
    updatePendingDb();
});

// ==========================================
// 2. API לממשק הניהול 
// ==========================================
app.get('/api/data', (req, res) => res.json(db));

// עדכון הגדרות ברירת מחדל ובחירות מהירות יחד
app.post('/api/settings', (req, res) => {
    db.defaultRouting = req.body.defaultRouting;
    db.quickOptions = req.body.quickOptions;
    saveDatabase(); // <--- הוסף שמירה
    res.json({ success: true });
});

app.post('/api/contacts', (req, res) => {
    const { phone, name, routeType, destination } = req.body;
    db.contacts[phone] = { name, routeType, destination };
    saveDatabase(); // <--- הוסף שמירה
    res.json({ success: true });
});

app.delete('/api/contacts/:phone', (req, res) => {
    delete db.contacts[req.params.phone];
    saveDatabase(); // <--- הוסף שמירה
    res.json({ success: true });
});

// קבלת ההחלטה מהדפדפן של הנציג (לחיצה על הכפתור בפופ-אפ)
app.post('/api/resolve_call', (req, res) => {
    const { id, type, destination, name } = req.body;
    
    if (activePendingCalls[id]) {
        const pending = activePendingCalls[id];
        clearTimeout(pending.timeoutId); // עצירת הטיימר של ה-5 שניות
        const yemotRes = pending.res;
        
        delete activePendingCalls[id];
        updatePendingDb();
        
        addLog(pending.phone, `בחירה מהירה: ${name}`, type, destination);
        yemotRes.send(`id_list_message=t-השיחה_מועברת_כעת&routing_yemot=${buildYemotRoute(type, destination)}`);
        
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'השיחה כבר נותבה או שהזמן עבר' });
    }
});

// ==========================================
// 3. ממשק הניהול הויזואלי (HTML מוגש מהשרת)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="he" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>מרכזיית CRM חכמה - ימות המשיח</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                .loader { border-top-color: #3b82f6; animation: spinner 1.5s linear infinite; }
                @keyframes spinner { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                ::-webkit-scrollbar { width: 8px; }
                ::-webkit-scrollbar-track { background: #f1f5f9; }
                ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
                .toast-enter { transform: translateY(-150%); opacity: 0; }
                .toast-active { transform: translateY(0); opacity: 1; }
                /* אנימציה לפופ-אפ */
                @keyframes pulse-border { 0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); } 70% { box-shadow: 0 0 0 20px rgba(59, 130, 246, 0); } 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); } }
                .call-pulse { animation: pulse-border 1.5s infinite; }
            </style>
        </head>
        <body class="bg-slate-100 min-h-screen font-sans text-slate-800 pb-10">
            
            <!-- חלון פופ-אפ לשיחה נכנסת לא מוכרת -->
            <div id="incomingPopup" class="fixed inset-0 bg-slate-900 bg-opacity-70 z-[100] hidden items-center justify-center backdrop-blur-sm transition-all duration-300">
                <div class="bg-white rounded-2xl shadow-2xl p-6 w-96 transform scale-100 border-4 border-blue-500 call-pulse text-center">
                    <div class="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
                    </div>
                    <h3 class="text-xl font-black text-slate-800 mb-1">שיחה מלקוח חדש!</h3>
                    <p class="text-slate-500 text-sm mb-3">אנא בחר לאן לנתב את השיחה</p>
                    <div id="popupPhone" class="text-4xl font-black text-blue-600 mb-6" dir="ltr">050-0000000</div>
                    
                    <div id="popupButtons" class="grid grid-cols-2 gap-3 mb-5">
                        <!-- Buttons injected dynamically -->
                    </div>
                    
                    <div class="w-full bg-slate-200 rounded-full h-2.5 mb-2 overflow-hidden">
                        <div id="popupProgress" class="bg-blue-500 h-2.5 rounded-full w-full"></div>
                    </div>
                    <p class="text-xs text-slate-500 font-bold">מעביר לברירת מחדל בעוד <span id="popupTimer" class="text-red-500 text-base">5</span> שניות...</p>
                </div>
            </div>

            <!-- כותרת ראשית -->
            <header class="bg-blue-700 text-white shadow-lg">
                <div class="max-w-7xl mx-auto px-4 py-4 md:py-6 flex justify-between items-center">
                    <div>
                        <h1 class="text-2xl md:text-3xl font-extrabold tracking-tight">מרכזיית CRM חכמה</h1>
                        <p class="text-blue-200 text-sm mt-1">ממשק משולב: ניתוב נכנסות, חיוג גישור, וניהול תורים</p>
                    </div>
                </div>
            </header>

            <div class="max-w-7xl mx-auto px-4 mt-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
                
                <!-- עמודה ימנית: ניהול נכנסות (Webhook + CRM) -->
                <div class="space-y-6">
                    
                    <!-- מוניטור שיחות -->
                    <div class="bg-slate-900 rounded-2xl shadow-lg overflow-hidden border border-slate-800">
                        <div class="bg-slate-800 px-5 py-4 border-b border-slate-700 flex justify-between items-center">
                            <h2 class="text-lg font-bold text-white flex items-center gap-2">
                                <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                                מוניטור שיחות נכנסות (Webhook)
                            </h2>
                            <span class="text-xs font-mono bg-slate-700 text-slate-300 px-2 py-1 rounded flex items-center gap-2">
                                <span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span></span>
                                Live
                            </span>
                        </div>
                        <div id="logsArea" class="h-64 overflow-y-auto p-4 space-y-3"></div>
                    </div>

                    <!-- CRM ניתובים והגדרות חכמות -->
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                        <div class="px-5 py-4 border-b border-slate-100 bg-slate-50">
                            <h2 class="text-lg font-bold text-slate-800">הגדרות ניתוב ופופ-אפ</h2>
                        </div>
                        
                        <!-- הגדרות חכמות (ברירת מחדל + בחירה מהירה) -->
                        <div class="p-5 border-b border-slate-100">
                            <h3 class="text-sm font-bold text-slate-700 mb-2">ניתוב ברירת מחדל (לאחר 5 שניות התעלמות):</h3>
                            <div class="flex gap-3 mb-4">
                                <select id="defType" class="px-3 py-2 border rounded-lg bg-slate-50 outline-none w-32">
                                    <option value="phone">טלפון רגיל</option>
                                    <option value="sip">שלוחת SIP</option>
                                </select>
                                <input type="text" id="defDest" class="flex-1 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-400" dir="ltr" placeholder="מספר יעד לברירת מחדל">
                            </div>

                            <h3 class="text-sm font-bold text-slate-700 mb-2">אפשרויות בחירה מהירה (יופיעו בחלון הקופץ):</h3>
                            
                            <div class="flex gap-2 mb-2 bg-slate-50 p-2 rounded-lg border border-slate-100">
                                <input type="text" id="q1Name" placeholder="שם כפתור (למשל: תמיכה)" class="flex-1 px-2 py-1.5 border rounded text-sm outline-none">
                                <select id="q1Type" class="px-2 border rounded text-sm"><option value="phone">טלפון</option><option value="sip">SIP</option></select>
                                <input type="text" id="q1Dest" placeholder="יעד" class="w-24 px-2 py-1.5 border rounded text-sm outline-none" dir="ltr">
                            </div>
                            
                            <div class="flex gap-2 mb-4 bg-slate-50 p-2 rounded-lg border border-slate-100">
                                <input type="text" id="q2Name" placeholder="שם כפתור (למשל: מכירות)" class="flex-1 px-2 py-1.5 border rounded text-sm outline-none">
                                <select id="q2Type" class="px-2 border rounded text-sm"><option value="phone">טלפון</option><option value="sip">SIP</option></select>
                                <input type="text" id="q2Dest" placeholder="יעד" class="w-24 px-2 py-1.5 border rounded text-sm outline-none" dir="ltr">
                            </div>

                            <button onclick="saveSettings()" class="w-full bg-slate-800 text-white px-5 py-2.5 rounded-lg hover:bg-slate-900 transition font-bold shadow-sm">שמור הגדרות ניתוב</button>
                        </div>

                        <!-- אנשי קשר -->
                        <div class="p-5 bg-blue-50 border-t border-blue-100">
                            <h3 class="text-sm font-bold text-blue-800 mb-3">אנשי קשר (ניתוב קבוע ללא המתנה):</h3>
                            <form id="addContactForm" class="flex flex-col md:flex-row gap-2 mb-4">
                                <input type="tel" id="contactPhone" required placeholder="מספר טלפון" class="w-full md:w-1/4 px-2 py-2 border rounded outline-none" dir="ltr">
                                <input type="text" id="contactName" required placeholder="שם לקוח" class="w-full md:w-1/4 px-2 py-2 border rounded outline-none">
                                <select id="contactType" class="px-2 border rounded bg-white"><option value="phone">טלפון</option><option value="sip">SIP</option></select>
                                <input type="text" id="contactDest" required placeholder="יעד" class="w-full md:w-1/4 px-2 py-2 border rounded outline-none" dir="ltr">
                                <button type="submit" class="bg-blue-600 text-white px-3 py-2 rounded hover:bg-blue-700 font-bold">הוסף</button>
                            </form>
                            <div class="max-h-40 overflow-y-auto rounded border border-slate-200 bg-white">
                                <table class="w-full text-sm text-right"><tbody id="contactsList" class="divide-y divide-slate-100"></tbody></table>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- עמודה שמאלית: חיוג גישור ותור (Yemot API) -->
                <div class="space-y-6">
                    <!-- הגדרות טוקן ו-SIP -->
                    <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex flex-col gap-3">
                        <div class="text-sm font-bold text-slate-700 border-b pb-2">הגדרות חיבור אישיות (נשמר בדפדפן)</div>
                        <div class="flex gap-4">
                            <div class="flex-1"><label class="block text-xs text-slate-500 mb-1">טוקן מערכת Yemot</label><input type="text" id="globalToken" class="w-full px-3 py-2 border rounded bg-slate-50 outline-none" /></div>
                            <div class="w-32"><label class="block text-xs text-slate-500 mb-1">שלוחת ה-SIP שלך</label><input type="number" id="mySipExt" class="w-full px-3 py-2 border rounded bg-slate-50 outline-none" /></div>
                        </div>
                    </div>

                    <!-- חיוג יוצא (Bridge) -->
                    <div class="bg-white rounded-2xl shadow-sm border border-emerald-200 overflow-hidden">
                        <div class="px-5 py-4 border-b border-emerald-100 bg-emerald-50"><h2 class="text-lg font-bold text-emerald-800">הוצאת שיחת גישור</h2></div>
                        <form id="bridgeForm" class="p-5 space-y-4">
                            <input type="tel" id="bridgeTarget" required placeholder="מספר הלקוח לשיחה (לדוגמה: 0500000000)" class="w-full px-4 py-3 border border-slate-300 rounded-xl outline-none text-lg" dir="ltr" />
                            <button type="submit" id="btnBridge" class="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 rounded-xl transition">חייג עכשיו ללקוח</button>
                        </form>
                    </div>

                    <!-- סטטוס תור בזמן אמת -->
                    <div class="bg-white rounded-2xl shadow-sm border border-purple-200 overflow-hidden">
                        <div class="px-5 py-4 border-b border-purple-100 bg-purple-50"><h2 class="text-lg font-bold text-purple-800">סטטוס תור נציגים</h2></div>
                        <div class="p-5">
                            <form id="queueForm" class="flex gap-3 mb-5">
                                <input type="text" id="queuePath" required placeholder="נתיב תור (למשל 1/2)" class="w-32 px-3 py-2 border rounded-lg outline-none" dir="ltr" />
                                <button type="submit" id="btnQueue" class="flex-1 bg-purple-100 text-purple-800 font-bold py-2 rounded-lg transition border border-purple-300">רענן נתונים כעת</button>
                            </form>
                            <div id="queueDashboard" class="bg-slate-50 border border-slate-200 rounded-xl p-4 min-h-[100px] flex items-center justify-center text-slate-400 text-sm">הזן נתיב ולחץ על רענון כדי לראות מידע</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Toast Container -->
            <div id="toastContainer" class="fixed bottom-5 right-5 z-50 flex flex-col gap-3"></div>

            <script>
                const YEMOT_API = 'https://www.call2all.co.il/ym/api';
                const elToken = document.getElementById('globalToken');
                const elSip = document.getElementById('mySipExt');
                let currentQuickOptions = []; // ישמור את הבחירות כדי לרנדר בפופ-אפ

                function showToast(message, type = 'success') {
                    const container = document.getElementById('toastContainer');
                    const toast = document.createElement('div');
                    toast.className = \`\${type === 'error' ? 'bg-red-600' : 'bg-green-600'} text-white px-6 py-3 rounded-xl shadow-lg font-medium text-sm transition-all duration-300 toast-enter flex items-center gap-2\`;
                    toast.innerHTML = \`<span>\${message}</span>\`;
                    container.appendChild(toast);
                    requestAnimationFrame(() => toast.classList.add('toast-active'));
                    setTimeout(() => { toast.classList.remove('toast-active'); setTimeout(() => toast.remove(), 300); }, 3000);
                }

                document.addEventListener('DOMContentLoaded', () => {
                    if (localStorage.getItem('yemot_token')) elToken.value = localStorage.getItem('yemot_token');
                    if (localStorage.getItem('yemot_my_sip')) elSip.value = localStorage.getItem('yemot_my_sip');
                });
                elToken.addEventListener('input', e => localStorage.setItem('yemot_token', e.target.value.trim()));
                elSip.addEventListener('input', e => localStorage.setItem('yemot_my_sip', e.target.value.trim()));

                // ==========================================
                // מנגנון חלון פופ-אפ (5 שניות בחירה)
                // ==========================================
                let activeCallPopupId = null;
                let popupInterval = null;

                function handlePendingCalls(pendingCalls) {
                    const popup = document.getElementById('incomingPopup');
                    if (pendingCalls.length > 0) {
                        const call = pendingCalls[0];
                        if (activeCallPopupId !== call.id) {
                            activeCallPopupId = call.id;
                            document.getElementById('popupPhone').innerText = call.phone;
                            
                            // יצירת הכפתורים מתוך הבחירות המהירות
                            const btnHtml = currentQuickOptions.map((opt, i) => \`
                                <button onclick="resolveCall('\${call.id}', '\${opt.type}', '\${opt.destination}', '\${opt.name}')" 
                                    class="w-full py-3 rounded-xl font-bold text-white shadow-md transition \${i===0 ? 'bg-blue-500 hover:bg-blue-600' : 'bg-purple-500 hover:bg-purple-600'}">
                                    \${opt.name} (\${opt.type === 'sip' ? 'SIP' : 'טלפון'})
                                </button>
                            \`).join('');
                            document.getElementById('popupButtons').innerHTML = btnHtml;
                            
                            popup.classList.remove('hidden');
                            popup.classList.add('flex');
                            
                            // הפעלת האנימציה והטיימר
                            let timeLeft = 45; // 4.5 שניות (תואם לשינוי בשרת)
                            const progressBar = document.getElementById('popupProgress');
                            const timerText = document.getElementById('popupTimer');
                            progressBar.style.width = '100%';
                            progressBar.style.transition = 'width 0.1s linear';
                            
                            clearInterval(popupInterval);
                            popupInterval = setInterval(() => {
                                timeLeft--;
                                if (timeLeft >= 0) {
                                    progressBar.style.width = (timeLeft * 2.22) + '%'; // התאמה ויזואלית ל-45 צעדים
                                    timerText.innerText = Math.ceil(timeLeft / 10);
                                }
                            }, 100);
                        }
                    } else {
                        // אם הרשימה ריקה (או שהזמן עבר בצד השרת או שלחצו על משהו) - סוגרים
                        if (activeCallPopupId) {
                            popup.classList.add('hidden');
                            popup.classList.remove('flex');
                            activeCallPopupId = null;
                            clearInterval(popupInterval);
                        }
                    }
                }

                // שליחת הבחירה של הנציג חזרה לשרת
                async function resolveCall(id, type, destination, name) {
                    document.getElementById('incomingPopup').classList.add('hidden');
                    document.getElementById('incomingPopup').classList.remove('flex');
                    activeCallPopupId = null;
                    clearInterval(popupInterval);
                    
                    await fetch('/api/resolve_call', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({id, type, destination, name})
                    });
                    loadData(); // ריענון מיידי של הלוגים
                }

                // ==========================================
                // משיכת נתונים ולוגים
                // ==========================================
                async function loadData() {
                    try {
                        const res = await fetch('/api/data');
                        const data = await res.json();
                        
                        // עדכון שדות ההגדרות (רק אם הם לא בפוקוס כדי לא להפריע להקלדה)
                        if(document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
                            document.getElementById('defType').value = data.defaultRouting.type;
                            document.getElementById('defDest').value = data.defaultRouting.destination;
                            
                            currentQuickOptions = data.quickOptions;
                            if(data.quickOptions.length === 2) {
                                document.getElementById('q1Name').value = data.quickOptions[0].name;
                                document.getElementById('q1Type').value = data.quickOptions[0].type;
                                document.getElementById('q1Dest').value = data.quickOptions[0].destination;
                                document.getElementById('q2Name').value = data.quickOptions[1].name;
                                document.getElementById('q2Type').value = data.quickOptions[1].type;
                                document.getElementById('q2Dest').value = data.quickOptions[1].destination;
                            }
                        }
                        
                        renderContacts(data.contacts);
                        renderLogs(data.callLogs);
                        handlePendingCalls(data.pendingCalls); // בדיקת הפופ-אפ
                    } catch(e) {}
                }

                async function saveSettings() {
                    const settings = {
                        defaultRouting: { type: document.getElementById('defType').value, destination: document.getElementById('defDest').value },
                        quickOptions: [
                            { name: document.getElementById('q1Name').value || 'אפשרות 1', type: document.getElementById('q1Type').value, destination: document.getElementById('q1Dest').value },
                            { name: document.getElementById('q2Name').value || 'אפשרות 2', type: document.getElementById('q2Type').value, destination: document.getElementById('q2Dest').value }
                        ]
                    };
                    if(!settings.defaultRouting.destination || !settings.quickOptions[0].destination || !settings.quickOptions[1].destination) {
                        return showToast('נא למלא מספרי יעד בכל השדות', 'error');
                    }
                    await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
                    showToast('הגדרות ניתוב נשמרו!');
                    loadData();
                }

                function renderContacts(contacts) {
                    const list = document.getElementById('contactsList');
                    list.innerHTML = '';
                    if(Object.keys(contacts).length === 0) return list.innerHTML = '<tr><td colspan="4" class="text-center py-2 text-slate-400">אין אנשי קשר</td></tr>';
                    for (const [phone, info] of Object.entries(contacts)) {
                        list.innerHTML += \`<tr class="hover:bg-slate-50 border-b border-slate-50"><td class="p-2 font-bold">\${info.name} <span class="text-xs text-slate-400 ml-2" dir="ltr">\${phone}</span></td><td class="p-2">\${info.routeType === 'sip' ? 'SIP' : 'טלפון'}</td><td class="p-2 font-mono" dir="ltr">\${info.destination}</td><td class="p-2"><button onclick="deleteContact('\${phone}')" class="text-red-500 font-bold">מחק</button></td></tr>\`;
                    }
                }

                function renderLogs(logs) {
                    const area = document.getElementById('logsArea');
                    if (logs.length === 0) return area.innerHTML = '<div class="text-center text-slate-500 mt-10">ממתין לשיחות...</div>';
                    area.innerHTML = '';
                    logs.forEach(log => {
                        const isUnknown = log.name.includes('ברירת מחדל');
                        const cardBg = isUnknown ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-blue-900 border-blue-800 text-white';
                        area.innerHTML += \`<div class="p-3 rounded-xl border \${cardBg} shadow-sm mb-2"><div class="flex justify-between items-start mb-1"><div class="font-bold">\${log.name}</div><span class="text-xs bg-slate-900 px-2 rounded">\${log.time}</span></div><div class="flex justify-between text-sm"><span dir="ltr">\${log.phone}</span><span class="text-emerald-400 font-mono" dir="ltr">\${log.routeType.toUpperCase()} \${log.destination}</span></div></div>\`;
                    });
                }

                document.getElementById('addContactForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const body = { phone: document.getElementById('contactPhone').value, name: document.getElementById('contactName').value, routeType: document.getElementById('contactType').value, destination: document.getElementById('contactDest').value };
                    await fetch('/api/contacts', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
                    e.target.reset(); showToast('איש קשר התווסף'); loadData();
                });

                async function deleteContact(phone) { await fetch(\`/api/contacts/\${phone}\`, { method: 'DELETE' }); loadData(); }

                // ==========================================
                // חיוג יוצא (Bridge)
                // ==========================================
                document.getElementById('bridgeForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const token = elToken.value.trim(); const mySip = elSip.value.trim(); const target = document.getElementById('bridgeTarget').value.trim();
                    if (!token || !mySip) return showToast('חובה להזין טוקן ושלוחת SIP למעלה!', 'error');
                    const params = new URLSearchParams({ token: token, Phones: '0000000000', BridgePhones: target, DialSip: '1', DialSipExtension: '1', SipExtension: mySip, RecordCall: '0' });
                    const btn = document.getElementById('btnBridge'); btn.innerHTML = 'מחייג...'; btn.disabled = true;
                    try {
                        const res = await fetch(\`\${YEMOT_API}/CreateBridgeCall?\${params.toString()}\`);
                        const data = await res.json();
                        if (data.responseStatus === "OK") { showToast('מצלצל... ענה בשלוחת ה-SIP שלך'); document.getElementById('bridgeTarget').value = ''; } 
                        else showToast('שגיאה ביצירת השיחה', 'error');
                    } catch (e) { showToast('שגיאת תקשורת', 'error'); } 
                    finally { btn.innerHTML = 'חייג עכשיו ללקוח'; btn.disabled = false; }
                });

                // ==========================================
                // סטטוס תור (Queue)
                // ==========================================
                document.getElementById('queueForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const token = elToken.value.trim(); const path = document.getElementById('queuePath').value.trim();
                    if (!token) return showToast('חובה להזין טוקן!', 'error');
                    const btn = document.getElementById('btnQueue'); btn.innerHTML = 'טוען...';
                    try {
                        const res = await fetch(\`\${YEMOT_API}/GetQueueRealTime?\${new URLSearchParams({ token, queuePath: path }).toString()}\`);
                        const data = await res.json();
                        if(data.responseStatus === "OK") {
                            let html = \`<div class="w-full"><div class="grid grid-cols-2 gap-3 mb-4"><div class="bg-orange-100 p-2 rounded text-center text-orange-800 font-bold">ממתינים: \${data.queueData.Calls||0}</div><div class="bg-emerald-100 p-2 rounded text-center text-emerald-800 font-bold">טופלו: \${data.queueData.Completed||0}</div></div>\`;
                            if(data.members && data.members.length > 0) { html += data.members.map(m => \`<div class="flex justify-between p-2 mb-1 border rounded \${m.Status==2 ? 'bg-red-50':'bg-green-50'}"><span class="font-bold">שלוחה \${m.agent}</span><span>\${m.Status==2?'בשיחה':'פנוי'}</span></div>\`).join(''); }
                            document.getElementById('queueDashboard').innerHTML = html + '</div>';
                            document.getElementById('queueDashboard').classList.remove('flex', 'items-center', 'justify-center');
                            showToast('תור עודכן');
                        }
                    } catch (e) { showToast('שגיאה', 'error'); } 
                    finally { btn.innerHTML = 'רענן נתונים כעת'; }
                });

                // ריענון מהיר (כל 1 שניה במקום 2) כדי לתפוס את הפופ-אפ בזמן
                loadData();
                setInterval(loadData, 1000);
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});