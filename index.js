// ==========================================
// Baytna Backend Server - DEBUG VERSION
// ==========================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const admin = require("firebase-admin");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());
app.use(express.json());

console.log("Starting Server Initialization...");

// ===============================
// Firebase Admin Setup (With Error Logging)
// ===============================
try {
    if (!admin.apps.length) {
        console.log("Initializing Firebase Admin...");
        
        // التحقق من وجود المفاتيح
        if (!process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_PROJECT_ID) {
            console.error("❌ CRITICAL ERROR: Firebase Environment Variables are MISSING!");
        }

        const privateKey = process.env.FIREBASE_PRIVATE_KEY 
            ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '') 
            : undefined;

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey
            })
        });
        console.log("✅ Firebase Admin Initialized Successfully");
    }
} catch (error) {
    console.error("❌ Firebase Initialization Failed:", error.message);
}

const db = admin.firestore();

// دالة حساب المستوى
function calculateLevel(points) {
    const p = Number(points) || 0;
    if (p < 100) return 1;
    if (p < 300) return 2;
    if (p < 600) return 3;
    if (p < 1000) return 4;
    return 4 + Math.floor((p - 1000) / 500) + 1;
}

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

async function logAdminAction(adminName, action, details) {
    try {
        await db.collection("admin_logs").add({
            adminName: adminName || "System",
            action, details, timestamp: Date.now()
        });
    } catch (e) { console.error("LogAdminAction Failed:", e); }
}

// --- البيانات الثابتة ---
const CHALLENGES_DATA = [
    { id: "d1", text: "أرسل رسالة لطيفة لأحد أفراد العائلة 💖", type: "DAILY", points: 10 },
    { id: "d2", text: "التقط صورة لشيء لونه أحمر 🔴", type: "DAILY", points: 15, requiresPhoto: true },
    { id: "w1", text: "تعلم طبخة جديدة وصور النتيجة 👨‍🍳", type: "WEEKLY", points: 70, requiresPhoto: true },
    { id: "m1", text: "تعلم مهارة جديدة 🧠", type: "MONTHLY", points: 150 }
];

// --- 1. الروابط الأساسية ---
app.get("/", (req, res) => res.json({ status: "Baytna Server Running", time: new Date() }));
app.get("/ping", (req, res) => res.send("pong"));

// --- 2. أجورا وإشعارات وكلاوديناري (نفس الكود السابق) ---
app.get("/token", (req, res) => {
    const channelName = req.query.channel;
    const uid = Number(req.query.uid || 0);
    if (!channelName) return res.status(400).json({ error: "channel is required" });
    try {
        const token = RtcTokenBuilder.buildTokenWithUid(process.env.AGORA_APP_ID, process.env.AGORA_APP_CERTIFICATE, channelName, uid, RtcRole.PUBLISHER, Math.floor(Date.now() / 1000) + 3600);
        res.json({ token });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/send-notification", async (req, res) => {
    const { recipientIds, targetAll, title, message, type } = req.body;
    try {
        const payload = {
            app_id: process.env.ONESIGNAL_APP_ID,
            headings: { ar: title, en: title },
            contents: { ar: message, en: message },
            data: { type }
        };
        if (targetAll) payload.included_segments = ["All"];
        else if (recipientIds) payload.include_external_user_ids = recipientIds;

        await axios.post("https://onesignal.com/api/v1/notifications", payload, {
            headers: { Authorization: `Basic ${process.env.ONESIGNAL_REST_KEY}`, "Content-Type": "application/json" }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- 3. نظام النقاط والتحديات (النسخة المستقرة) ---

app.post("/api/points/add", async(req,res)=>{
    const { userId, points, actionType, description } = req.body;
    const pToAdd = Number(points) || 0;
    try {
        await db.runTransaction(async(t)=>{
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            if(!userSnap.exists) throw new Error("User not found");
            const newTotal = (Number(userSnap.data().points) || 0) + pToAdd;
            t.update(userRef, { points: newTotal, level: calculateLevel(newTotal) });
            t.set(db.collection("points_logs").doc(), { userId, points: pToAdd, actionType, description, timestamp: Date.now() });
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/challenges/sync", async (req, res) => {
    const { userId, type } = req.query;
    try {
        const now = new Date();
        const start = new Date(now.getFullYear(), 0, 0);
        const dayOfYear = Math.floor((now - start) / 86400000);
        let cycleKey = type === "DAILY" ? now.getFullYear() * 1000 + dayOfYear : now.getFullYear() * 100 + now.getMonth();
        const docId = `user_${userId}_${type}_cycle_${cycleKey}`;
        const progSnap = await db.collection("challenge_progress").doc(docId).get();
        if (progSnap.exists) res.json({ progress: progSnap.data(), challenge: CHALLENGES_DATA[0] });
        else res.status(404).json({ error: "No challenge found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/user/daily-login", async(req,res)=>{
    const { userId } = req.body;
    try {
        const result = await db.runTransaction(async(t)=>{
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            if(!userSnap.exists) throw new Error("User not found");
            const today = new Date().setHours(0,0,0,0);
            const lastLogin = new Date(userSnap.data().lastLoginDate || 0).setHours(0,0,0,0);
            if(today === lastLogin) return { isNewDay: false };
            const streak = (today - lastLogin <= 86400000 + 1000) ? (userSnap.data().streakCount || 0)+1 : 1;
            t.update(userRef, { points: (userSnap.data().points || 0) + 5, streakCount: streak, lastLoginDate: Date.now() });
            return { isNewDay: true, pointsEarnedToday: 5, currentStreak: streak, totalPoints: (userSnap.data().points || 0) + 5 };
        });
        res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is up and running on port ${PORT}`);
});
