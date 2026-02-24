const { default: makeWASocket, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom'); // Added for accurate error parsing
const useMongoAuthState = require('../auth/mongoAuthState');
const { Session, AuthState } = require('../models');
const sendWebhook = require('./webhook');
const pino = require('pino');

const sessions = new Map();

const createSession = async (sessionId, customWebhook = null) => {
    const { state, saveCreds } = await useMongoAuthState(sessionId);
    
    if (customWebhook) {
        await Session.findOneAndUpdate(
            { sessionId }, 
            { webhook: customWebhook }, 
            { upsert: true, returnDocument: 'after' }
        );
    }

    if (customWebhook) {
    await Session.findOneAndUpdate(
        { sessionId }, 
        { $set: { webhook: customWebhook } }, // 👈 ADDED $set
        { upsert: true, returnDocument: 'after' }
    );
}

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false // Prevents massive data downloads on connect
    });

    sessions.set(sessionId, sock);

    sock.ev.process(async (events) => {
        // 1. Connection Lifecycle
// 1. Connection Lifecycle
        if (events['connection.update']) {
            const { connection, lastDisconnect, qr } = events['connection.update'];
            
            if (qr) {
                await Session.findOneAndUpdate(
                    { sessionId }, 
                    { $set: { status: 'QR_READY', qrCode: qr } }
                );
                await sendWebhook(sessionId, 'qrcode', { qrcode: qr });
            }

            if (connection === 'close') {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                if (isLoggedOut) {
                    console.log(`❌ [${sessionId}] Session explicitly logged out by user.`);
                    
                    await Session.findOneAndUpdate(
                        { sessionId }, 
                        { $set: { status: 'DISCONNECTED', qrCode: null } }
                    );
                    await AuthState.deleteMany({ sessionId });
                    sessions.delete(sessionId);
                    
                    await sendWebhook(sessionId, 'connection-state', { status: 'DISCONNECTED', reason: 'logged_out' });
                } else {
                    // Silently handle Code 405 or other temporary disconnects
                    console.log(`🔄 [${sessionId}] Connection dropped (Code: ${statusCode}). Reconnecting silently...`);
                    
                    await Session.findOneAndUpdate(
                        { sessionId }, 
                        { $set: { status: 'RECONNECTING' } }
                    );
                    
                    // Do NOT trigger sendWebhook here to avoid spamming the Python server.
                    
                    // Fetch the existing webhook URL from the DB so we don't lose it during the retry
                    const existingSession = await Session.findOne({ sessionId });
                    
                    setTimeout(() => createSession(sessionId, existingSession?.webhook), 5000);
                }
            } else if (connection === 'open') {
                console.log(`✅ [${sessionId}] WhatsApp Connected successfully!`);
                await Session.findOneAndUpdate(
                    { sessionId }, 
                    { $set: { status: 'CONNECTED', qrCode: null, waNumber: sock.user.id } }
                );
                
                await sendWebhook(sessionId, 'connection-state', { status: 'CONNECTED', waNumber: sock.user.id });
            }
        }

        // 2. Save Credentials to MongoDB
        if (events['creds.update']) {
            await saveCreds();
        }

        // 3. Stream Messages to Webhook (Stateless)
        if (events['messages.upsert']) {
            const m = events['messages.upsert'];
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    
                    const messageType = Object.keys(msg.message || {})[0];
                    let mediaBase64 = null;
                    let mimetype = null;

                    const mediaTypes = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'];
                    if (mediaTypes.includes(messageType)) {
                        try {
                            const buffer = await downloadMediaMessage(
                                msg,
                                'buffer',
                                { },
                                { logger: pino({ level: 'silent' }) }
                            );
                            mediaBase64 = buffer.toString('base64');
                            mimetype = msg.message[messageType]?.mimetype;
                        } catch (err) {
                            console.error(`❌ Failed to decrypt media for ${msg.key.remoteJid}:`, err.message);
                        }
                    }

                    await sendWebhook(sessionId, 'onmessage', {
                        from: msg.key.remoteJid,
                        pushName: msg.pushName,
                        type: messageType,
                        messageId: msg.key.id,
                        message: msg.message,
                        mediaBase64: mediaBase64,
                        mimetype: mimetype
                    });
                }
            }
        }

        // 4. Stream Contacts to Webhook
        if (events['contacts.upsert']) {
            const contacts = events['contacts.upsert'].map(c => ({
                id: c.id,
                name: c.name || c.notify || 'Unknown'
            }));
            await sendWebhook(sessionId, 'contacts-sync', { contacts });
        }

        // 5. Stream Chats to Webhook
        if (events['chats.upsert']) {
            const chats = events['chats.upsert'].map(c => ({
                id: c.id,
                name: c.name || 'Unknown',
                unreadCount: c.unreadCount || 0
            }));
            await sendWebhook(sessionId, 'chats-sync', { chats });
        }
    });

    return sock;
};

const getSession = (sessionId) => sessions.get(sessionId);

const deleteSession = async (sessionId) => {
    const sock = sessions.get(sessionId);
    if (sock) {
        try { await sock.logout(); } catch (e) {}
        sessions.delete(sessionId);
    }
    
    // Wipe DB
    await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
    await AuthState.deleteMany({ sessionId });
    
    // Notify Webhook
    await sendWebhook(sessionId, 'connection-state', { status: 'DISCONNECTED', reason: 'manual_logout' });
};

// Auto-Restore Function
const restoreSessions = async () => {
    try {
        // Find both connected and previously reconnecting sessions to revive them
        const activeSessions = await Session.find({ status: { $in: ['CONNECTED', 'RECONNECTING'] } });
        console.log(`🔄 Found ${activeSessions.length} active sessions in DB. Booting them up...`);
        
        for (const sessionDb of activeSessions) {
            console.log(`🔌 Restoring session: [${sessionDb.sessionId}]`);
            await createSession(sessionDb.sessionId, sessionDb.webhook);
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2s buffer to prevent rate-limiting
        }
    } catch (error) {
        console.error("❌ Failed to restore sessions:", error.message);
    }
};

module.exports = { createSession, getSession, deleteSession, restoreSessions };