==========================================
// Baytna Render Backend Server - ULTIMATE FULL VERSION
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

// ===============================
// Firebase Admin Setup
// ===============================
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY
                ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
                : undefined
        })
    });
}
const db = admin.firestore();

// ===============================
// Environment Variables
// ===============================
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;

// ===============================
// Utility Functions (Helpers)
// ===============================

function calculateLevel(points) {
    if (points < 100) return 1;
    if (points < 300) return 2;
    if (points < 600) return 3;
    if (points < 1000) return 4;
    return 4 + Math.floor((points - 1000) / 500) + 1;
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
            action,
            details,
            timestamp: Date.now()
        });
    } catch (e) { console.error("LogAdminAction Failed:", e); }
}

// ===============================
// 1. Core Services (Agora, OneSignal, Cloudinary)
// ===============================

app.get("/ping", (req, res) => res.send("pong"));

app.get("/token", (req, res) => {
    const channelName = req.query.channel;
    const uid = Number(req.query.uid || 0);
    if (!channelName) return res.status(400).json({ error: "channel is required" });
    try {
        const privilegeExpiredTs = Math.floor(Date.now() / 1000) + 3600;
        const token = RtcTokenBuilder.buildTokenWithUid(AGORA_APP_ID, AGORA_APP_CERTIFICATE, channelName, uid, RtcRole.PUBLISHER, privilegeExpiredTs);
        res.json({ token });
    } catch (error) { res.status(500).json({ error: "فشل إنشاء Agora Token" }); }
});

app.post("/send-notification", async (req, res) => {
    const { recipientIds, targetRole, targetAll, title, message, type, id, extraData } = req.body;
    const payload = {
        app_id: ONESIGNAL_APP_ID,
        headings: { en: title, ar: title },
        contents: { en: message, ar: message },
        data: { type, id, ...(extraData || {}) }
    };
    if (targetAll) payload.included_segments = ["All"];
    else if (targetRole) payload.filters = [{ field: "tag", key: "role", relation: "=", value: targetRole }];
    else if (recipientIds && recipientIds.length) payload.include_external_user_ids = recipientIds;

    try {
        const response = await axios.post("https://onesignal.com/api/v1/notifications", payload, {
            headers: { Authorization: `Basic ${ONESIGNAL_REST_KEY}`, "Content-Type": "application/json" }
        });
        res.json(response.data);
    } catch (error) { res.status(500).json(error.response ? error.response.data : { error: error.message }); }
});

app.post("/get-cloudinary-signature", (req, res) => {
    const { params_to_sign } = req.body;
    try {
        const signature = cloudinary.utils.api_sign_request(params_to_sign, CLOUDINARY_API_SECRET);
        res.json({ signature, api_key: CLOUDINARY_API_KEY, cloud_name: CLOUDINARY_CLOUD_NAME });
    } catch(error) { res.status(500).json({ error: "فشل توليد توقيع Cloudinary" }); }
});

// ===============================
// 2. Points System
// ===============================

app.get("/api/stats/points", async (req, res) => {
    try {
        const snapshot = await db.collection("users").get();
        let stats = { totalPoints: 0, totalUsers: 0, maxStreak: 0, topUser: "N/A", maxPoints: -1 };
        snapshot.forEach(doc => {
            const data = doc.data();
            const p = data.points || 0;
            stats.totalPoints += p;
            stats.totalUsers++;
            if (p > stats.maxPoints) { stats.maxPoints = p; stats.topUser = data.name || "مستخدم"; }
            if ((data.streakCount || 0) > stats.maxStreak) stats.maxStreak = data.streakCount;
        });
        res.json({ ...stats, avgPoints: stats.totalUsers ? Math.floor(stats.totalPoints / stats.totalUsers) : 0 });
    } catch(error) { res.status(500).json({ error: error.message }); }
});

app.post("/api/points/add", async(req,res)=>{
    const { userId, points, actionType, description, source } = req.body;
    try {
        await db.runTransaction(async(t)=>{
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            if(!userSnap.exists) throw new Error("المستخدم غير موجود");
            const data = userSnap.data();
            const newTotal = (data.points || 0) + points;
            t.update(userRef, {
                points: newTotal,
                weeklyPoints: (data.weeklyPoints || 0) + points,
                monthlyPoints: (data.monthlyPoints || 0) + points,
                level: calculateLevel(newTotal)
            });
            const logRef = db.collection("points_logs").doc();
            t.set(logRef, { logId: logRef.id, userId, userName: data.name || "مستخدم", points, actionType, description, timestamp: Date.now(), source: source || "server" });
        });
        res.json({ success:true });
    } catch(error){ res.status(500).json({ error:error.message }); }
});

app.post("/api/points/deduct", async(req,res)=>{
    const { userId, reason, points, adminName } = req.body;
    try {
        await db.runTransaction(async(t)=>{
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            const data = userSnap.data();
            const newTotal = Math.max(0, (data.points || 0) - points);
            t.update(userRef, { points: newTotal, level: calculateLevel(newTotal) });
            const logRef = db.collection("points_logs").doc();
            t.set(logRef, { logId: logRef.id, userId, points: -points, actionType: "manual_deduction", description: `خصم: ${reason}`, timestamp: Date.now(), source: "admin" });
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===============================
// 3. Challenges System
// ===============================

const CHALLENGES_DATA = [
    { id: "d1", text: "أرسل رسالة لطيفة لأحد أفراد العائلة 💖", type: "DAILY", points: 10 },
    { id: "d2", text: "التقط صورة لشيء لونه أحمر 🔴", type: "DAILY", points: 15, requiresPhoto: true },
    { id: "w1", text: "تعلم طبخة جديدة وصور النتيجة 👨‍🍳", type: "WEEKLY", points: 70, requiresPhoto: true },
    { id: "m1", text: "تعلم مهارة جديدة 🧠", type: "MONTHLY", points: 150 }
];

app.get("/api/challenges/sync", async (req, res) => {
    const { userId, type } = req.query;
    try {
        const now = new Date();
        const start = new Date(now.getFullYear(), 0, 0);
        const dayOfYear = Math.floor((now - start) / 86400000);
        let cycleKey = type === "DAILY" ? now.getFullYear() * 1000 + dayOfYear : now.getFullYear() * 100 + now.getMonth();
        const docId = `user_${userId}_${type}_cycle_${cycleKey}`;
        const progSnap = await db.collection("challenge_progress").doc(docId).get();
        if (progSnap.exists) res.json({ progress: progSnap.data() });
        else res.status(404).json({ error: "لا يوجد تحدي حالي" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/challenges/update-all", async(req,res)=>{
    const { types } = req.body;
    try {
        const usersSnapshot = await db.collection("users").get();
        let batch = db.batch();
        let operations = 0; let total = 0;
        for(const userDoc of usersSnapshot.docs){
            if(userDoc.id === "admin") continue;
            for(const type of types){
                const available = CHALLENGES_DATA.filter(c=>c.type === type);
                if(!available.length) continue;
                const challenge = available[Math.floor(Math.random() * available.length)];
                const now = new Date(); const start = new Date(now.getFullYear(), 0, 0);
                const dayOfYear = Math.floor((now - start) / 86400000);
                let cycleKey = type === "DAILY" ? now.getFullYear() * 1000 + dayOfYear : now.getFullYear() * 100 + now.getMonth();
                const docId = `user_${userDoc.id}_${type}_cycle_${cycleKey}`;
                batch.set(db.collection("challenge_progress").doc(docId), {
                    id: docId, userId: userDoc.id, challengeId: challenge.id,
                    challengeText: challenge.text, type, status: "pending",
                    pointsEarned: challenge.points, pointsGranted: false,
                    requiresPhoto: challenge.requiresPhoto || false, timestamp: Date.now()
                }, { merge:true });
                operations++; total++;
                if(operations >= 400){ await batch.commit(); batch = db.batch(); operations = 0; }
            }
        }
        await batch.commit();
        res.json({ success: true, message: `تم تحديث التحديات لـ ${total} عملية` });
    } catch(error){ res.status(500).json({ error:error.message }); }
});

app.post("/api/challenges/approve", async(req,res)=>{
    const { progressId, userId, points } = req.body;
    try {
        await db.runTransaction(async(t)=>{
            const progRef = db.collection("challenge_progress").doc(progressId);
            const userRef = db.collection("users").doc(userId);
            const [pSnap, uSnap] = await Promise.all([t.get(progRef), t.get(userRef)]);
            if(!pSnap.exists || !uSnap.exists) throw new Error("بيانات ناقصة");
            if(pSnap.data().pointsGranted) throw new Error("النقاط منحت مسبقاً");
            const newTotal = (uSnap.data().points || 0) + points;
            t.update(userRef, { points: newTotal, level: calculateLevel(newTotal) });
            t.update(progRef, { status: "completed", pointsGranted: true, completionTime: Date.now() });
            const logRef = db.collection("points_logs").doc();
            t.set(logRef, { logId: logRef.id, userId, points, actionType: "challenge_reward", description: `إكمال تحدي ${pSnap.data().challengeId}`, timestamp: Date.now(), source: "server" });
        });
        res.json({ success:true });
    } catch(error){ res.status(500).json({ error:error.message }); }
});

app.post("/api/challenges/reject", async(req,res)=>{
    const { progressId, reason } = req.body;
    try {
        await db.collection("challenge_progress").doc(progressId).update({
            status: "rejected", rejectionReason: reason, timestamp: Date.now()
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===============================
// 4. Daily Login & Rewards
// ===============================

app.post("/api/user/daily-login", async(req,res)=>{
    const { userId } = req.body;
    try {
        const result = await db.runTransaction(async(t)=>{
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            if(!userSnap.exists) throw new Error("المستخدم غير موجود");
            const userData = userSnap.data();
            const today = new Date().setHours(0, 0, 0, 0);
            const lastLogin = new Date(userData.lastLoginDate || 0).setHours(0, 0, 0, 0);
            if(today === lastLogin) return { isNewDay:false, totalPoints: userData.points || 0 };
            const streak = (today - lastLogin <= 86400000 + 1000) ? (userData.streakCount || 0)+1 : 1;
            const points = 5; const newTotal = (userData.points || 0) + points;
            t.update(userRef, { points: newTotal, streakCount: streak, lastLoginDate: Date.now(), level: calculateLevel(newTotal) });
            const logRef = db.collection("points_logs").doc();
            t.set(logRef, { logId: logRef.id, userId, points, actionType: "daily_login", description: `تسجيل دخول يومي - ${streak} يوم`, timestamp: Date.now(), source: "server" });
            return { isNewDay:true, pointsEarnedToday: points, currentStreak: streak, totalPoints: newTotal };
        });
        res.json(result);
    } catch(error){ res.status(500).json({ error:error.message }); }
});

app.post("/api/rewards/open-box", async(req,res)=>{
    const { userId, boxType } = req.body;
    try {
        const rewardRanges = { bronze: [5,20], silver: [25,100], gold: [150,500] };
        const range = rewardRanges[boxType] || [1,10];
        const points = Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0];
        await db.runTransaction(async(t)=>{
            const userRef = db.collection("users").doc(userId);
            const uSnap = await t.get(userRef);
            const total = (uSnap.data().points || 0) + points;
            t.update(userRef, { points: total, level: calculateLevel(total) });
            const logRef = db.collection("points_logs").doc();
            t.set(logRef, { logId: logRef.id, userId, points, actionType: "box_reward", description: `جائزة صندوق ${boxType}`, timestamp: Date.now(), source: "server" });
        });
        res.json({ success:true, rewardPoints:points });
    } catch(error){ res.status(500).json({ error:error.message }); }
});

// ===============================
// 5. Advanced Admin & System
// ===============================

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

app.post("/api/system/repair-data", async (req, res) => {
    const { adminName } = req.body;
    try {
        await logAdminAction(adminName, "system_repair", "بدء عملية إصلاح البيانات العامة");
        res.json({ message: "تم بدء عملية الإصلاح بنجاح" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/force-logout-all", async (req, res) => {
    const { adminName } = req.body;
    try {
        const users = await db.collection("users").get();
        const batch = db.batch();
        users.forEach(doc => { if (doc.id !== 'admin') batch.update(doc.ref, { forceLogout: true }); });
        await batch.commit();
        await logAdminAction(adminName, "force_logout_all", "إنهاء جلسات جميع المستخدمين");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/logs", async (req, res) => {
    try {
        const snapshot = await db.collection("admin_logs").orderBy("timestamp", "desc").limit(100).get();
        res.json(snapshot.docs.map(doc => doc.data()));
    } catch (e) { res.status(500).send(e.message); }
});

// ===============================
// 6. Store & Leaderboard
// ===============================

app.get("/api/leaderboard", async (req,res)=>{
    const { type="general", limit=50 } = req.query;
    let field = type === "weekly" ? "weeklyPoints" : type === "monthly" ? "monthlyPoints" : "points";
    try {
        const snapshot = await db.collection("users").where("isAdmin", "==", false).where("isHiddenFromLeaderboard", "==", false).orderBy(field, "desc").limit(Number(limit)).get();
        res.json(snapshot.docs.map(doc=>({ userId: doc.id, ...doc.data() })));
    } catch(error){ res.status(500).send(error.message); }
});

app.post("/api/store/purchase", async(req,res)=>{
    const { userId, itemId } = req.body;
    try {
        const result = await db.runTransaction(async(t)=>{
            const userRef = db.collection("users").doc(userId);
            const itemRef = db.collection("store_items").doc(itemId);
            const [uSnap, iSnap] = await Promise.all([t.get(userRef), t.get(itemRef)]);
            if(!uSnap.exists || !iSnap.exists) throw new Error("بيانات غير موجودة");
            if(uSnap.data().points < iSnap.data().price) throw new Error("نقاط غير كافية");
            const newOwned = [...(uSnap.data().ownedItems || []), itemId];
            t.update(userRef, { points: uSnap.data().points - iSnap.data().price, ownedItems: newOwned });
            return { message: "تم الشراء بنجاح" };
        });
        res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===============================
// Server Start
// ===============================
app.get("/", (req, res) => res.json({ status: "Baytna Server Running", time: new Date() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
