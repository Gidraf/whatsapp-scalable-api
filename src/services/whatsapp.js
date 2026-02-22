const { default: makeWASocket, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const useMongoAuthState = require('../auth/mongoAuthState');
const { Session, AuthState, Message } = require('../models');
const axios = require('axios');
const pino = require('pino');

const sessions = new Map();

const sendWebhook = async (sessionId, event, data) => {
    try {
        const session = await Session.findOne({ sessionId });
        if (session && session.webhook) {
            await axios.post(session.webhook, { sessionId, event, data });
        }
    } catch (err) {
        console.error(`Webhook error for session ${sessionId}:`, err.message);
    }
};

const createSession = async (sessionId) => {
    const { state, saveCreds } = await useMongoAuthState(sessionId);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
    });

    sessions.set(sessionId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            await sendWebhook(sessionId, 'qrcode', { qr });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                createSession(sessionId);
            } else {
                await Session.findOneAndUpdate({ sessionId }, { status: 'LOGGED_OUT' });
                await AuthState.deleteMany({ sessionId });
                sessions.delete(sessionId);
                await sendWebhook(sessionId, 'connection', { status: 'LOGGED_OUT' });
            }
        } else if (connection === 'open') {
            await Session.findOneAndUpdate({ sessionId }, { status: 'CONNECTED' });
            await sendWebhook(sessionId, 'connection', { status: 'CONNECTED' });
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                await Message.create({
                    messageId: msg.key.id,
                    sessionId: sessionId,
                    remoteJid: msg.key.remoteJid,
                    fromMe: msg.key.fromMe,
                    text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
                    timestamp: new Date(msg.messageTimestamp * 1000)
                });
                
                await sendWebhook(sessionId, 'message', msg);
            }
        }
    });

    return sock;
};

const getSession = (sessionId) => sessions.get(sessionId);

module.exports = { createSession, getSession };