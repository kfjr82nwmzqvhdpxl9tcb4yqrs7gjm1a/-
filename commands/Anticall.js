import { getAnticallState, setAnticallState } from '../utils/anticallStore.js';
import { t } from '../france/translator.js';

export const commands = [
  {
    name: 'anticall',
    aliases: ['ac'],
    description: 'Enable or disable anti-call feature',
    category: 'User',
    execute: async ({ sock, from, msg, args, isOwner, sender }) => {
      if (!isOwner && !global.ALLOWED_USERS?.has(sender)) {
        const notAuthorized = await t(from, 'anticall', 'notAuthorized');
        return sock.sendMessage(from, { text: notAuthorized });
      }

      const action = args[0]?.toLowerCase();
      
      if (action === 'status') {
        const currentState = getAnticallState(from);
        const statusMsg = currentState 
          ? await t(from, 'anticall', 'enabled')
          : await t(from, 'anticall', 'disabled');
        
        return sock.sendMessage(from, { 
          text: `🛡️ *Anti-Call Feature*\n\n${statusMsg}` 
        });
      }
      
      if (action === 'on') {
        setAnticallState(from, true);
        const enabledMsg = await t(from, 'anticall', 'toggledOn');
        await sock.sendMessage(from, {
          react: { text: '✅', key: msg.key }
        });
        return sock.sendMessage(from, { text: enabledMsg });
      }
      
      if (action === 'off') {
        setAnticallState(from, false);
        const disabledMsg = await t(from, 'anticall', 'toggledOff');
        await sock.sendMessage(from, {
          react: { text: '❌', key: msg.key }
        });
        return sock.sendMessage(from, { text: disabledMsg });
      }
      
      const currentState = getAnticallState(from);
      const newState = !currentState;
      setAnticallState(from, newState);
      const responseMsg = newState 
        ? await t(from, 'anticall', 'toggledOn')
        : await t(from, 'anticall', 'toggledOff');
      
      await sock.sendMessage(from, {
        react: { text: newState ? '✅' : '❌', key: msg.key }
      });
      
      await sock.sendMessage(from, { text: responseMsg });
    }
  }
]; 
