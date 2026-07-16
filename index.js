// =========================================================
// Baytna Render Backend Server - FINAL STABLE FULL VERSION
// =========================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const admin = require("firebase-admin");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());
app.use(express.json());

// 🚀 الخطوة 1: تشغيل السيرفر فوراً لمنع خطأ "Internal Server Error" في Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Baytna Server is LIVE on port ${PORT}`);
});

// ===============================
// Firebase Admin Setup (Crash-Proof)
// ===============================
let db;
try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY 
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '').trim() 
        : null;

    if (privateKey && process.env.FIREBASE_PROJECT_ID) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey
            })
        });
        db = admin.firestore();
        console.log("✅ Firebase Admin Connected Successfully");
    } else {
        console.error("❌ Firebase Keys are missing in Environment Variables!");
    }
} catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
}

// ===============================
// Utility Functions (Helpers)
// ===============================

function calculateLevel(points) {
    const p = Number(points) || 0;
    if (p < 100) return 1;
    if (p < 300) return 2;
    if (p < 600) return 3;
    if (p < 1000) return 4;
    return 4 + Math.floor((p - 1000) / 500) + 1;
}

// دالة حساب اليوم من السنة (مهمة جداً للمزامنة مع الأندرويد)
function getDayOfYear() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
}

async function logAdminAction(adminName, action, details) {
    if (!db) return;
    try {
        await db.collection("admin_logs").add({
            adminName: adminName || "System",
            action, details, timestamp: Date.now()
        });
    } catch (e) { console.error("LogAdminAction Failed:", e); }
}

const CHALLENGES_DATA = [
    { id: "d1", text: "أرسل رسالة لطيفة لأحد أفراد العائلة 💖", type: "DAILY", points: 10 },
    { id: "d2", text: "التقط صورة لشيء لونه أحمر 🔴", type: "DAILY", points: 15, requiresPhoto: true },
    { id: "w1", text: "تعلم طبخة جديدة وصور النتيجة 👨‍🍳", type: "WEEKLY", points: 70, requiresPhoto: true },
    { id: "m1", text: "تعلم مهارة جديدة 🧠", type: "MONTHLY", points: 150 }
];

// ===============================
// API Routes
// ===============================

app.get("/", (req, res) => res.json({ status: "Baytna Server Live", firebase: !!db }));
app.get("/ping", (req, res) => res.send("pong"));

// --- 1. Core Services ---

app.get("/token", (req, res) => {
    const { channel, uid } = req.query;
    if (!channel) return res.status(400).send("Channel required");
    try {
        const token = RtcTokenBuilder.buildTokenWithUid(process.env.AGORA_APP_ID, process.env.AGORA_APP_CERTIFICATE, channel, Number(uid || 0), RtcRole.PUBLISHER, Math.floor(Date.now()/1000) + 3600);
        res.json({ token });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

app.post("/get-cloudinary-signature", (req, res) => {
    try {
        const signature = cloudinary.utils.api_sign_request(req.body.params_to_sign, process.env.CLOUDINARY_API_SECRET);
        res.json({ signature, api_key: process.env.CLOUDINARY_API_KEY, cloud_name: process.env.CLOUDINARY_CLOUD_NAME });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 2. Points & Stats ---

app.get("/api/stats/points", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database offline" });
    try {
        const snapshot = await db.collection("users").get();
        let totalPoints = 0, totalUsers = 0, maxStreak = 0, topUser = "N/A", maxP = -1;
        snapshot.forEach(doc => {
            const d = doc.data();
            const p = Number(d.points) || 0;
            totalPoints += p; totalUsers++;
            if (p > maxP) { maxP = p; topUser = d.name || "مستخدم"; }
            if ((d.streakCount || 0) > maxStreak) maxStreak = d.streakCount;
        });
        res.json({ totalPoints, totalUsers, topUser, maxStreak, avgPoints: totalUsers ? Math.floor(totalPoints/totalUsers) : 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/points/add", async (req, res) => {
    if (!db) return res.status(503).send("DB Offline");
    const { userId, points, actionType, description, source } = req.body;
    const pToAdd = Number(points) || 0;
    try {
        await db.runTransaction(async t => {
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            if (!userSnap.exists) throw new Error("User not found");
            const data = userSnap.data();
            const newTotal = (Number(data.points) || 0) + pToAdd;
            t.update(userRef, { 
                points: newTotal, 
                weeklyPoints: (Number(data.weeklyPoints) || 0) + pToAdd,
                monthlyPoints: (Number(data.monthlyPoints) || 0) + pToAdd,
                level: calculateLevel(newTotal) 
            });
            t.set(db.collection("points_logs").doc(), { logId: Date.now().toString(), userId, userName: data.name, points: pToAdd, actionType, description, timestamp: Date.now(), source: source || "server" });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/points/deduct", async(req,res)=>{
    if (!db) return res.status(503).send("DB Offline");
    const { userId, reason, points, adminName } = req.body;
    const pToSub = Number(points) || 0;
    try {
        await db.runTransaction(async t => {
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            const newTotal = Math.max(0, (Number(userSnap.data().points) || 0) - pToSub);
            t.update(userRef, { points: newTotal, level: calculateLevel(newTotal) });
            t.set(db.collection("points_logs").doc(), { userId, points: -pToSub, actionType: "manual_deduction", description: `خصم: ${reason}`, timestamp: Date.now(), source: "admin" });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3. Challenges ---

app.get("/api/challenges/sync", async (req, res) => {
    if (!db) return res.status(503).send("DB Offline");
    const { userId, type } = req.query;
    try {
        const cycleKey = type === "DAILY" ? (new Date().getFullYear() * 1000 + getDayOfYear()) : (new Date().getFullYear() * 100 + new Date().getMonth());
        const docId = `user_${userId}_${type}_cycle_${cycleKey}`;
        const progSnap = await db.collection("challenge_progress").doc(docId).get();
        if (progSnap.exists) {
            const progress = progSnap.data();
            const challenge = CHALLENGES_DATA.find(c => c.id === progress.challengeId) || CHALLENGES_DATA[0];
            res.json({ challenge, progress });
        } else res.status(404).json({ error: "No active challenge" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/challenges/update-all", async (req, res) => {
    if (!db) return res.status(503).send("DB Offline");
    const { types } = req.body;
    try {
        const usersSnapshot = await db.collection("users").get();
        let batch = db.batch(), ops = 0, total = 0;
        const cycleKeyBase = new Date().getFullYear() * 1000 + getDayOfYear();

        for (const userDoc of usersSnapshot.docs) {
            if (userDoc.id === "admin") continue;
            for (const type of types) {
                const available = CHALLENGES_DATA.filter(c => c.type === type);
                if (!available.length) continue;
                const challenge = available[Math.floor(Math.random() * available.length)];
                const cycleKey = type === "DAILY" ? cycleKeyBase : (new Date().getFullYear() * 100 + new Date().getMonth());
                const docId = `user_${userDoc.id}_${type}_cycle_${cycleKey}`;
                
                batch.set(db.collection("challenge_progress").doc(docId), {
                    id: docId, userId: userDoc.id, challengeId: challenge.id,
                    type, status: "pending", cycleKey, pointsEarned: challenge.points,
                    pointsGranted: false, timestamp: Date.now()
                }, { merge: true });

                ops++; total++;
                if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
            }
        }
        await batch.commit();
        res.json({ success: true, message: `Updated ${total} challenges` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/challenges/approve", async (req, res) => {
    const { progressId, userId, points } = req.body;
    try {
        await db.runTransaction(async t => {
            const pRef = db.collection("challenge_progress").doc(progressId), uRef = db.collection("users").doc(userId);
            const [pS, uS] = await Promise.all([t.get(pRef), t.get(uRef)]);
            if (pS.data().pointsGranted) throw new Error("Already granted");
            const newTotal = (Number(uS.data().points) || 0) + Number(points);
            t.update(uRef, { points: newTotal, level: calculateLevel(newTotal) });
            t.update(pRef, { status: "completed", pointsGranted: true, completionTime: Date.now() });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 4. User Systems ---

app.post("/api/user/daily-login", async (req, res) => {
    if (!db) return res.status(503).send("DB Offline");
    const { userId } = req.body;
    try {
        const result = await db.runTransaction(async t => {
            const userRef = db.collection("users").doc(userId);
            const uSnap = await t.get(userRef);
            if (!uSnap.exists) throw new Error("User not found");
            const userData = uSnap.data();
            const today = new Date().setHours(0, 0, 0, 0);
            const lastLogin = new Date(userData.lastLoginDate || 0).setHours(0, 0, 0, 0);

            if (today === lastLogin) return { isNewDay: false, totalPoints: userData.points };

            const streak = (today - lastLogin <= 86400000 + 1000) ? (userData.streakCount || 0) + 1 : 1;
            const newTotal = (Number(userData.points) || 0) + 5;
            t.update(userRef, { points: newTotal, streakCount: streak, lastLoginDate: Date.now(), level: calculateLevel(newTotal) });
            return { isNewDay: true, pointsEarnedToday: 5, currentStreak: streak, totalPoints: newTotal };
        });
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 5. System Operations ---

app.post("/api/notifications/send-bulk", async (req, res) => {
    const { title, message, type, recipients } = req.body;
    try {
        const payload = {
            app_id: ONESIGNAL_APP_ID,
            headings: { ar: title, en: title },
            contents: { ar: message, en: message },
            data: { type }
        };
        if (recipients) payload.include_external_user_ids = recipients;
        else payload.included_segments = ["All"];
        await axios.post("https://onesignal.com/api/v1/notifications", payload, {
            headers: { Authorization: `Basic ${ONESIGNAL_REST_KEY}`, "Content-Type": "application/json" }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/leaderboard", async (req, res) => {
    if (!db) return res.status(503).send("DB Offline");
    const { type = "general", limit = 50 } = req.query;
    const field = type === "weekly" ? "weeklyPoints" : (type === "monthly" ? "monthlyPoints" : "points");
    try {
        const snap = await db.collection("users").where("isAdmin", "==", false).where("isHiddenFromLeaderboard", "==", false).orderBy(field, "desc").limit(Number(limit)).get();
        res.json(snap.docs.map(doc => ({ userId: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).send(e.message); }
});

app.post("/api/admin/force-logout-all", async (req, res) => {
    if (!db) return res.status(503).send("DB Offline");
    try {
        const users = await db.collection("users").get();
        const batch = db.batch();
        users.forEach(doc => { if (doc.id !== 'admin') batch.update(doc.ref, { forceLogout: true }); });
        await batch.commit();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
