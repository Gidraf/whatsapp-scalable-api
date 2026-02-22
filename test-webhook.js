const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
app.use(express.json());

// The webhook endpoint that your Docker API will send data to
app.post('/webhook', (req, res) => {
    const { sessionId, event, data } = req.body;

    console.log(`\n📦 Received Webhook - Session: [${sessionId}] | Event: [${event}]`);

    if (event === 'qrcode') {
        console.log('\n📱 SCAN THIS QR CODE WITH YOUR WHATSAPP APP:\n');
        // This prints the QR code directly in the terminal
        qrcodeTerminal.generate(data.qr, { small: true });
    } 
    else if (event === 'connection') {
        console.log(`🔄 Status Update: ${data.status}`);
    } 
    else if (event === 'message') {
        const text = data.message?.conversation || data.message?.extendedTextMessage?.text || '[Media/Other]';
        console.log(`💬 Message from ${data.key?.remoteJid}: ${text}`);
    }

    // Always respond with 200 OK so the API knows we received it
    res.sendStatus(200);
});

const PORT = 4000;
app.listen(PORT, () => {
    console.log(`🎧 Webhook listener running on port ${PORT}`);
    console.log(`⏳ Waiting for events...`);
});