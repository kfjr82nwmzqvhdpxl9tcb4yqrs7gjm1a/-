import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { t, translate, translateAIResponse, getUserLang } from '../france/translator.js';
import { API_CONFIG } from '../france/config.js';

export const commands = [
  {
    name: 'vision',
    aliases: ['describe', 'analyze'],
    description: 'Analyze a replied image using Gemini Vision 2.',
    category: 'AI',
    execute: async ({ sock, from, msg, args, config }) => {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const botName = config.BOT_NAME || 'Flash-MD';

      if (!quoted || !quoted.imageMessage) {
        const noImageMsg = await t(from, 'vision', 'noImage');
        return sock.sendMessage(from, {
          text: noImageMsg
        }, { quoted: msg });
      }

      const query = args.join(' ');
      if (!query) {
        const noQueryMsg = await t(from, 'vision', 'noQuery');
        return sock.sendMessage(from, {
          text: noQueryMsg
        }, { quoted: msg });
      }

      try {
        const buffer = await downloadMediaMessage(
          { message: { imageMessage: quoted.imageMessage } },
          'buffer',
          {},
          { logger: console }
        );

        const base64Image = buffer.toString('base64');
        
        const response = await fetch(API_CONFIG.vision.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            image: base64Image,
            q: query
          })
        });

        const data = await response.json();
        
        if (!data.status) {
          throw new Error('API request failed');
        }

        const translatedResult = await translateAIResponse(from, data.result);
        
        const successTemplate = await t(from, 'vision', 'success');

        await sock.sendMessage(from, {
          text: successTemplate.replace('{result}', translatedResult),
          contextInfo: {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: '120363238139244263@newsletter',
              newsletterName: botName,
              serverMessageId: -1
            }
          }
        }, { quoted: msg });

      } catch (err) {
        const errorTemplate = await t(from, 'vision', 'error');
        await sock.sendMessage(from, {
          text: errorTemplate.replace('{error}', err.message)
        }, { quoted: msg });
      }
    }
  }
];
