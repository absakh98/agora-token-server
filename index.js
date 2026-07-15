const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());
app.use(express.json());

// --- قراءة البيانات من إعدادات السيرفر (Render Environment Variables) ---
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;

// [مسار جديد]: للتأكد من أن السيرفر يعمل ومنعه من النوم
app.get("/ping", (req, res) => {
    res.send("pong");
});

// [ENDPOINT 1]: Agora Token
app.get("/token", (req, res) => {
    const channelName = req.query.channel;
    const uid = req.query.uid || 0;
    if (!channelName) return res.status(400).json({ error: "channel is required" });

    try {
        const privilegeExpiredTs = Math.floor(Date.now() / 1000) + 3600;
        const token = RtcTokenBuilder.buildTokenWithUid(
            AGORA_APP_ID, AGORA_APP_CERTIFICATE, channelName, uid, RtcRole.PUBLISHER, privilegeExpiredTs
        );
        res.json({ token });
    } catch (err) {
        res.status(500).json({ error: "فشل في توليد توكن أغورا" });
    }
});

// [ENDPOINT 2]: OneSignal Notifications
app.post("/send-notification", async (req, res) => {
    const { recipientIds, targetRole, targetAll, title, message, type, id, extraData } = req.body;

    const payload = {
        app_id: ONESIGNAL_APP_ID,
        headings: { en: title, ar: title },
        contents: { en: message, ar: message },
        data: { type, id, ...extraData }
    };

    if (targetAll) payload.included_segments = ["All"];
    else if (targetRole) payload.filters = [{ field: "tag", key: "role", relation: "=", value: targetRole }];
    else if (recipientIds && recipientIds.length > 0) payload.include_external_user_ids = recipientIds;

    try {
        const response = await axios.post("https://onesignal.com/api/v1/notifications", payload, {
            headers: { Authorization: `Basic ${ONESIGNAL_REST_KEY}`, "Content-Type": "application/json" }
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json(err.response ? err.response.data : { error: err.message });
    }
});

// [ENDPOINT 3]: Cloudinary Signature
app.post("/get-cloudinary-signature", (req, res) => {
    const { params_to_sign } = req.body;
    try {
        const signature = cloudinary.utils.api_sign_request(params_to_sign, CLOUDINARY_API_SECRET);
        res.json({
            signature: signature,
            api_key: CLOUDINARY_API_KEY,
            cloud_name: CLOUDINARY_CLOUD_NAME
        });
    } catch (err) {
        res.status(500).json({ error: "فشل توليد توقيع كلاوديناري" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
