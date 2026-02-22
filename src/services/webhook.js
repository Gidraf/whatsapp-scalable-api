const axios = require('axios');
const { Session } = require('../models');

const sendWebhook = async (sessionId, event, payload) => {
    try {
        const session = await Session.findOne({ sessionId });
        
        if (session && session.webhook) {
            console.log(`📡 [WEBHOOK] Sending '${event}' to -> ${session.webhook}`);
            const data = { event, session: sessionId, ...payload };
            await axios.post(session.webhook, data, { timeout: 5000 });
        } else {
            console.log(`⚠️ [WEBHOOK] Skipped '${event}'. No webhook URL saved in MongoDB for session ${sessionId}`);
        }
    } catch (err) {
        const statusCode = err.response ? err.response.status : 'Timeout/Network';
        console.error(`❌ [WEBHOOK] Failed to send '${event}' - HTTP ${statusCode}`);
    }
};

module.exports = sendWebhook;