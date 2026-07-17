// =========================================================
// Baytna Render Backend Server - UPDATED FULL VERSION (V2)
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

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Baytna Server V2 is LIVE on port ${PORT}`);
});

// ===============================
// Firebase Admin Setup
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
        console.log("✅ Firebase Admin Connected");
    }
} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
}

// ===============================
// Helpers
// ===============================

function calculateLevel(points) {
    const p = Number(points) || 0;
    if (p < 100) return 1;
    if (p < 300) return 2;
    if (p < 600) return 3;
    if (p < 1000) return 4;
    return 4 + Math.floor((p - 1000) / 500) + 1;
}

const CHALLENGES_DATA = [
    { id: "d1", text: "أرسل رسالة لطيفة لأحد أفراد العائلة 💖", type: "DAILY", points: 10 },
    { id: "d2", text: "التقط صورة لشيء لونه أحمر 🔴", type: "DAILY", points: 15, requiresPhoto: true },
    { id: "w1", text: "تعلم طبخة جديدة وصور النتيجة 👨‍🍳", type: "WEEKLY", points: 70, requiresPhoto: true },
    { id: "m1", text: "تعلم مهارة جديدة 🧠", type: "MONTHLY", points: 150 }
];

// ===============================
// API Routes (Updated)
// ===============================

app.get("/", (req, res) => res.json({ status: "Baytna Server V2 Live", firebase: !!db }));

// 1. نظام المتصدرين والبحث (توفير آلاف القراءات)
app.get("/api/leaderboard", async (req, res) => {
    if (!db) return res.status(503).send("DB Offline");
    const { type = "general", limit = 50 } = req.query;
    const field = type === "weekly" ? "weeklyPoints" : (type === "monthly" ? "monthlyPoints" : "points");
    try {
        const snap = await db.collection("users")
            .where("isAdmin", "==", false)
            .where("isHiddenFromLeaderboard", "==", false)
            .orderBy(field, "desc")
            .limit(Number(limit))
            .get();
        res.json(snap.docs.map(doc => ({ userId: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/api/users/search", async (req, res) => {
    const { query } = req.query;
    try {
        const snap = await db.collection("users").limit(100).get();
        const results = snap.docs
            .map(doc => ({ userId: doc.id, ...doc.data() }))
            .filter(u => u.name.toLowerCase().includes(query.toLowerCase()) || u.userId.includes(query));
        res.json(results.slice(0, 20));
    } catch (e) { res.status(500).send(e.message); }
});

// 2. نظام النقاط (إضافة، خصم، دخول يومي)
app.post("/api/points/add", async (req, res) => {
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
            t.set(db.collection("points_logs").doc(), { userId, userName: data.name, points: pToAdd, actionType, description, timestamp: Date.now(), source: source || "server" });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/points/deduct", async (req, res) => {
    const { userId, reason, points, adminName } = req.body;
    const pToSub = Number(points) || 0;
    try {
        await db.runTransaction(async t => {
            const userRef = db.collection("users").doc(userId);
            const userSnap = await t.get(userRef);
            const data = userSnap.data();
            const newTotal = Math.max(0, (Number(data.points) || 0) - pToSub);
            t.update(userRef, { 
                points: newTotal, 
                weeklyPoints: Math.max(0, (Number(data.weeklyPoints) || 0) - pToSub),
                monthlyPoints: Math.max(0, (Number(data.monthlyPoints) || 0) - pToSub),
                level: calculateLevel(newTotal) 
            });
            t.set(db.collection("points_logs").doc(), { userId, userName: data.name, points: -pToSub, actionType: "manual_deduction", description: reason, timestamp: Date.now(), source: "admin" });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. نظام المتجر الجديد (شراء وتفعيل)
app.post("/api/store/purchase", async (req, res) => {
    const { userId, itemId } = req.body;
    try {
        const result = await db.runTransaction(async t => {
            const userRef = db.collection("users").doc(userId);
            const itemRef = db.collection("store_items").doc(itemId);
            const [uSnap, iSnap] = await Promise.all([t.get(userRef), t.get(itemRef)]);

            if (!uSnap.exists || !iSnap.exists) throw new Error("بيانات غير موجودة");
            const userData = uSnap.data();
            const itemData = iSnap.data();

            if (userData.points < itemData.price) throw new Error("نقاط غير كافية");
            if (userData.ownedItems && userData.ownedItems.includes(itemId)) throw new Error("تملك هذا المنتج بالفعل");

            const newPoints = userData.points - itemData.price;
            t.update(userRef, {
                points: newPoints,
                ownedItems: admin.firestore.FieldValue.arrayUnion(itemId)
            });

            t.set(db.collection("store_purchases").doc(), {
                userId, itemId, itemName: itemData.name, price: itemData.price, timestamp: Date.now()
            });

            return { success: true, message: `تم شراء ${itemData.name} بنجاح ✅` };
        });
        res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/store/toggle-activation", async (req, res) => {
    const { userId, itemId, itemType, isActive } = req.body;
    try {
        const field = itemType === "badge" ? "activeBadge" : (itemType === "frame" ? "activeFrame" : "activeProfileColor");
        const updates = { [field]: isActive ? itemId : "none" };
        await db.collection("users").doc(userId).update(updates);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 4. نظام التحديات (قبول ورفض)
app.post("/api/challenges/approve", async (req, res) => {
    const { progressId, userId, points } = req.body;
    try {
        await db.runTransaction(async t => {
            const pRef = db.collection("challenge_progress").doc(progressId);
            const uRef = db.collection("users").doc(userId);
            const [pS, uS] = await Promise.all([t.get(pRef), t.get(uRef)]);
            
            if (pS.data().pointsGranted) throw new Error("Already granted");
            
            const newTotal = (Number(uS.data().points) || 0) + Number(points);
            t.update(uRef, { points: newTotal, level: calculateLevel(newTotal) });
            t.update(pRef, { status: "completed", pointsGranted: true, completionTime: Date.now() });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/challenges/reject", async (req, res) => {
    const { progressId, userId, reason } = req.body;
    try {
        await db.collection("challenge_progress").doc(progressId).update({
            status: "rejected",
            rejectionReason: reason
        });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 5. الإحصائيات والسجلات (العمليات الثقيلة)
app.get("/api/admin/logs", async (req, res) => {
    const { limit = 50 } = req.query;
    try {
        const snap = await db.collection("admin_logs").orderBy("timestamp", "desc").limit(Number(limit)).get();
        res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/api/stats/store", async (req, res) => {
    try {
        const [items, cats, sales] = await Promise.all([
            db.collection("store_items").get(),
            db.collection("store_categories").get(),
            db.collection("store_purchases").get()
        ]);
        let revenue = 0;
        sales.forEach(s => revenue += (s.data().price || 0));
        res.json({ totalItems: items.size, totalCategories: cats.size, todaySales: sales.size, totalRevenue: revenue });
    } catch (e) { res.status(500).send(e.message); }
});

// استيراد باقي المسارات من الكود القديم (Token, Cloudinary, etc.)
app.get("/token", (req, res) => {
    const { channel, uid } = req.query;
    if (!channel) return res.status(400).send("Channel required");
    try {
        const token = RtcTokenBuilder.buildTokenWithUid(process.env.AGORA_APP_ID, process.env.AGORA_APP_CERTIFICATE, channel, Number(uid || 0), RtcRole.PUBLISHER, Math.floor(Date.now()/1000) + 3600);
        res.json({ token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/get-cloudinary-signature", (req, res) => {
    try {
        const signature = cloudinary.utils.api_sign_request(req.body.params_to_sign, process.env.CLOUDINARY_API_SECRET);
        res.json({ signature, api_key: process.env.CLOUDINARY_API_KEY, cloud_name: process.env.CLOUDINARY_CLOUD_NAME });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
