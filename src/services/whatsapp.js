const { default: makeWASocket, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const usePrismaAuthState = require('../auth/prismaAuthState');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const pino = require('pino');

const prisma = new PrismaClient();
const sessions = new Map();

// Helper to send webhooks
const sendWebhook = async (sessionId, event, data) => {
    try {
        const session = await prisma.session.findUnique({ where: { sessionId } });
        if (session && session.webhook) {
            await axios.post(session.webhook, { sessionId, event, data });
        }
    } catch (err) {
        console.error(`Webhook error for session ${sessionId}:`, err.message);
    }
};

const createSession = async (sessionId) => {
    const { state, saveCreds } = await usePrismaAuthState(sessionId);
    
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
                await prisma.session.update({ where: { sessionId }, data: { status: 'LOGGED_OUT' }});
                await prisma.authState.deleteMany({ where: { sessionId } });
                sessions.delete(sessionId);
                await sendWebhook(sessionId, 'connection', { status: 'LOGGED_OUT' });
            }
        } else if (connection === 'open') {
            await prisma.session.update({ where: { sessionId }, data: { status: 'CONNECTED' }});
            await sendWebhook(sessionId, 'connection', { status: 'CONNECTED' });
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                // Store in PostgreSQL
                await prisma.message.create({
                    data: {
                        messageId: msg.key.id,
                        sessionId: sessionId,
                        remoteJid: msg.key.remoteJid,
                        fromMe: msg.key.fromMe,
                        text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
                        timestamp: new Date(msg.messageTimestamp * 1000)
                    }
                });
                
                // Dispatch Webhook
                await sendWebhook(sessionId, 'message', msg);
            }
        }
    });

    return sock;
};

const getSession = (sessionId) => sessions.get(sessionId);

module.exports = { createSession, getSession };