const axios = require('axios');
const { Session } = require('../models');

const sendWebhook = async (sessionId, event, payload) => {
    try {
        const session = await Session.findOne({ sessionId });
        if (session && session.webhook) {
            const data = { event, session: sessionId, ...payload };
            // Added a 5-second timeout so it doesn't hang
            await axios.post(session.webhook, data, { timeout: 5000 });
        }
    } catch (err) {
        // Clean error logging instead of stack trace spam
        const statusCode = err.response ? err.response.status : 'Timeout/Network';
        console.error(`⚠️ Webhook Failed for\n[Session: ${sessionId}]\n[Event: ${event}] - HTTP ${statusCode}`);
    }
};

module.exports = sendWebhook;