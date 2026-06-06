const express = require("express");
const cors = require("cors");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());

// 🔐 حط بيانات Agora هنا
const APP_ID = "5d0fb4a94efa43e3bf603d253df32ef2";
const APP_CERTIFICATE = "077f785eece04a4f8bf2958ee7f66ede";

// 🎯 توليد Token
app.get("/token", (req, res) => {
    const channelName = req.query.channel;
    const uid = req.query.uid || 0;

    if (!channelName) {
        return res.status(400).json({ error: "channel is required" });
    }

    const role = RtcRole.PUBLISHER;

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        uid,
        role,
        privilegeExpiredTs
    );

    res.json({
        token: token
    });
});

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Agora Token Server running on port " + PORT);
});