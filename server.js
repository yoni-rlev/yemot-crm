const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// הפעלת CORS ו-JSON (הגדרות בסיסיות לשרת)
app.use(cors());
app.use(express.json());

// 1. הגשת קובץ הדשבורד (HTML) כשהמשתמש נכנס לכתובת /dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 2. נתיב מתווך לבדיקת יתרה בימות המשיח
app.get('/api/yemot/GetBalance', async (req, res) => {
    const token = req.query.token;
    try {
        // השרת שלנו פונה לימות המשיח
        const yemotRes = await fetch(`https://www.call2all.co.il/ym/api/GetBalance?token=${encodeURIComponent(token)}`);
        const data = await yemotRes.json();
        res.json(data); // מחזיר את התשובה לדשבורד שלנו
    } catch (error) {
        console.error("Error fetching balance:", error);
        res.status(500).json({ error: 'Failed to connect to Yemot HaMashiach' });
    }
});

// 3. נתיב מתווך להורדת קבצים (קובץ יומן השיחות)
app.get('/api/yemot/DownloadFile', async (req, res) => {
    const token = req.query.token;
    const filePath = req.query.path;
    try {
        // השרת שלנו פונה לימות המשיח להורדת קובץ
        const yemotRes = await fetch(`https://www.call2all.co.il/ym/api/DownloadFile?token=${encodeURIComponent(token)}&path=${encodeURIComponent(filePath)}`);
        const textData = await yemotRes.text();
        res.send(textData); // מחזיר את הטקסט של הקובץ לדשבורד
    } catch (error) {
        console.error("Error downloading file:", error);
        res.status(500).send('Failed to download file');
    }
});

// נתיב ברירת מחדל (אם נכנסים לעמוד הראשי)
app.get('/', (req, res) => {
    res.send('המערכת עובדת. כדי לגשת לדשבורד היכנסו ל- /dashboard');
});

// הפעלת השרת
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
