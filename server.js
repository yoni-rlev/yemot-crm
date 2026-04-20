const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// פונקציית עזר שמדמה התנהגות מדויקת של דפדפן (כדי למנוע חסימת Invalid WS request)
async function makeYemotRequest(endpoint, queryParams) {
    // 1. בניית הכתובת - אנחנו לא מקודדים את הטוקן כדי לשמור על הנקודתיים (:) בדיוק כפי שעשית ב-HTML שעבד
    let paramsArray = [];
    for (let key in queryParams) {
        if (key === 'token') {
            paramsArray.push(`${key}=${queryParams[key]}`); // טוקן טבעי
        } else {
            paramsArray.push(`${key}=${encodeURIComponent(queryParams[key])}`);
        }
    }
    
    const url = `https://www.call2all.co.il/ym/api/${endpoint}?${paramsArray.join('&')}`;
    
    console.log("Yemot API Request:", url); // דיבאג למסך הלוגים של Render

    // 2. פנייה עם כותרות של דפדפן אמיתי (User-Agent) כדי לעבור את חומת האש
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    });

    const data = await response.text();
    
    if (!response.ok) {
        throw new Error(`שגיאת שרת ימות המשיח (${response.status}): ${data}`);
    }
    
    return data;
}

// בדיקת יתרה (משמשת גם כבדיקת חיבור)
app.get('/api/yemot/GetBalance', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).json({ error: 'Token is required' });

        const rawData = await makeYemotRequest('GetBalance', { token: token });
        
        try {
            const data = JSON.parse(rawData);
            res.json(data);
        } catch(e) {
            // אם במקרה חוזרת שגיאת טקסט מימות ולא JSON
            res.status(400).json({ error: rawData });
        }
    } catch (error) {
        console.error("Balance Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// הורדת קובץ הלוג
app.get('/api/yemot/DownloadFile', async (req, res) => {
    try {
        const token = req.query.token;
        const filePath = req.query.path;
        
        if (!token || !filePath) return res.status(400).send('Missing parameters');

        const rawData = await makeYemotRequest('DownloadFile', { token: token, path: filePath });
        res.send(rawData);
    } catch (error) {
        console.error("Download Error:", error.message);
        res.status(500).send('Download failed: ' + error.message);
    }
});

app.get('/', (req, res) => {
    res.send('המערכת המתווכת פועלת. כדי לגשת לדשבורד היכנסו לנתיב /dashboard');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
