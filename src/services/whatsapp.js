const { default: makeWASocket, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
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
        if (events['connection.update']) {
            const { connection, lastDisconnect, qr } = events['connection.update'];
            
            // Pass the raw QR string directly to Flask (No Base64 image generation)
            if (qr) {
                await Session.findOneAndUpdate({ sessionId }, { status: 'QR_READY', qrCode: qr });
                await sendWebhook(sessionId, 'qrcode', { qrcode: qr });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                // 401: Logged out from phone | 500: Session keys are corrupted
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession;

                if (isLoggedOut) {
                    console.log(`❌ [${sessionId}] Session explicitly logged out or corrupted.`);
                    
                    // Update Database
                    await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
                    await AuthState.deleteMany({ sessionId });
                    sessions.delete(sessionId);
                    
                    // Notify Flask to update its DB and alert the frontend
                    await sendWebhook(sessionId, 'status-find', { status: 'logoutsession' });
                } else {
                    // It's just a network drop or Baileys internal restart. DO NOT wipe data.
                    console.log(`🔄 [${sessionId}] Network drop (Code: ${statusCode}). Reconnecting silently...`);
                    setTimeout(() => createSession(sessionId), 3000);
                }
            } else if (connection === 'open') {
                console.log(`✅ [${sessionId}] WhatsApp Connected successfully!`);
                await Session.findOneAndUpdate({ sessionId, status: 'CONNECTED', qrCode: null, waNumber: sock.user.id });
                await sendWebhook(sessionId, 'status-find', { status: 'qrReadSuccess' });
            }
        }

        // 2. Save Credentials to MongoDB
        if (events['creds.update']) {
            await saveCreds();
        }

        // 3. Stream Messages to Webhook (Stateless)
       // 3. Stream Messages to Webhook (Stateless)
        if (events['messages.upsert']) {
            const m = events['messages.upsert'];
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    
                    const messageType = Object.keys(msg.message || {})[0];
                    let mediaBase64 = null;
                    let mimetype = null;

                    // Decrypt and download media if the message contains a file/image
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

                    // Send payload to Flask
                    await sendWebhook(sessionId, 'onmessage', {
                        from: msg.key.remoteJid,
                        pushName: msg.pushName,
                        type: messageType,
                        messageId: msg.key.id,
                        message: msg.message,
                        mediaBase64: mediaBase64, // Python will receive this!
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
    
    // Notify Flask
    await sendWebhook(sessionId, 'status-find', { status: 'logoutsession' });
};

// Auto-Restore Function
const restoreSessions = async () => {
    try {
        const activeSessions = await Session.find({ status: 'CONNECTED' });
        console.log(`🔄 Found ${activeSessions.length} active sessions in DB. Booting them up...`);
        
        for (const sessionDb of activeSessions) {
            console.log(`🔌 Restoring session: [${sessionDb.sessionId}]`);
            await createSession(sessionDb.sessionId, sessionDb.webhook);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Prevent rate-limiting
        }
    } catch (error) {
        console.error("❌ Failed to restore sessions:", error.message);
    }
};

module.exports = { createSession, getSession, deleteSession, restoreSessions };