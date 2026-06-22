import { createRequire } from 'module';
globalThis.require = createRequire(import.meta.url);

import Pino from 'pino'
import fs from 'fs'
import path from 'path'
import express from 'express'
import { Boom } from '@hapi/boom'
import { fileURLToPath } from 'url'
import moment from 'moment-timezone'
import { loadSudoList } from './utils/sudoStore.js'
import CONFIG from './config.js'
import { 
  seenStatusIds,
  processStatusMessage,
  handleStatusReply,
  logStatus
} from './bc.js'
import { 
  default as makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  useMultiFileAuthState, 
  downloadMediaMessage 
} from '@whiskeysockets/baileys'
import { handleDeletedMessage, handleEditedMessage, messageStore, cleanMessageStore } from './anti.js'

global.ALLOWED_USERS = loadSudoList()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let OWNER_NUMBER = null
let OWNER_LIDS = []
let OWNER_FULL_JID = null

const DEV_NUMBERS = ['254742063632', '254757835036']
const DEV_LIDS = ['20397286285438@lid', '41391036067990@lid']
const DEV_PHONE_SET = new Set(DEV_NUMBERS)
const DEV_LID_SET = new Set(DEV_LIDS)

const processedMessages = new Set()
const MESSAGE_TIMEOUT = 3000
const executingCommands = new Set()
const presenceTimers = new Map()

const phoneToLidMap = new Map()
const lidToPhoneMap = new Map()

function getPhoneFromJid(jid) {
  if (!jid) return null
  if (jid.includes('@s.whatsapp.net')) {
    const match = jid.match(/^(\d+)@/)
    return match ? match[1] : null
  }
  if (jid.includes('@lid')) {
    const match = jid.match(/^(\d+)@lid/)
    return match ? match[1] : null
  }
  const match = jid.match(/^(\d+):/)
  if (match) return match[1]
  const simpleMatch = jid.match(/^(\d+)@/)
  return simpleMatch ? simpleMatch[1] : null
}

function getLidFromJid(jid) {
  if (!jid) return null
  if (jid.includes('@lid')) {
    if (jid.includes(':')) {
      const match = jid.match(/^(\d+):\d+@lid/)
      if (match) return `${match[1]}@lid`
    }
    return jid
  }
  return null
}

function getCleanJid(jid) {
  if (!jid) return null
  if (jid.includes(':')) {
    const parts = jid.split(':')
    return parts[0] + '@' + parts[1].split('@')[1]
  }
  return jid
}

function getRealSenderJid(msg) {
  const remoteJid = msg.key?.remoteJidAlt || msg.key?.remoteJid
  const participant = msg.key?.participantAlt || msg.key?.participant
  const fromMe = msg.key?.fromMe
  
  if (fromMe) {
    return sock?.user?.id || remoteJid
  }
  
  if (participant) {
    return getCleanJid(participant)
  }
  
  if (remoteJid && remoteJid.includes('@g.us')) {
    return getCleanJid(participant || remoteJid)
  }
  
  return getCleanJid(remoteJid)
}

function getSenderPhone(jid) {
  if (!jid) return 'Unknown'
  const phone = getPhoneFromJid(jid)
  if (phone) return phone
  
  if (lidToPhoneMap.has(jid)) {
    return lidToPhoneMap.get(jid)
  }
  
  return jid.split('@')[0]
}

function formatPhoneNumber(phone) {
  if (!phone || phone === 'Unknown') return 'Unknown'
  const cleaned = phone.replace(/[^\d+]/g, '')
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`
}

function isDevUser(jid) {
  if (!jid) return false
  
  const cleanJid = getCleanJid(jid)
  const phone = getPhoneFromJid(cleanJid)
  const lid = getLidFromJid(cleanJid)
  
  if (phone && DEV_PHONE_SET.has(phone)) return true
  if (lid && DEV_LID_SET.has(lid)) return true
  
  if (lid && lidToPhoneMap.has(lid)) {
    const mappedPhone = lidToPhoneMap.get(lid)
    if (DEV_PHONE_SET.has(mappedPhone)) return true
  }
  
  return false
}

function formatLogMessage(type, chatJid, senderJid, senderName, body, isGroup = false, groupName = '', messageId = '', messageType = '') {
  const timestamp = moment().tz(CONFIG.TZ).format('DD/MM/YYYY HH:mm:ss')
  const logType = isGroup ? '👥 GROUP' : '👤 PRIVATE'
  console.log(`\n[📅 ${timestamp}] [${logType}]`)
  console.log(`├─ 💬 Chat: ${groupName || senderName} (${chatJid})`)
  const senderPhone = getSenderPhone(senderJid)
  const senderLid = getLidFromJid(senderJid)
  console.log(`├─ 👤 Sender: ${senderName} (+${senderPhone})${senderLid ? ` [LID: ${senderLid}]` : ''}`)
  if (body) console.log(`├─ 📝 Message: ${body}`)
  console.log(`└─ 🔍 Details: ${messageType} | ${isGroup ? 'Group' : 'Private'} | ${messageId}\n`)
}

function logError(context, command, user, error) {
  const timestamp = moment().tz(CONFIG.TZ).format('DD/MM/YYYY HH:mm:ss')
  console.log(`\n[📅 ${timestamp}] [❌ ERROR]`)
  console.log(`├─ 🔧 Context: ${context}`)
  if (command) console.log(`├─ 🎯 Command: ${command}`)
  if (user) console.log(`├─ 👤 User: ${user}`)
  console.log(`└─ 💬 Error: ${error}\n`)
}

function logConnection(event, details = {}) {
  const timestamp = moment().tz(CONFIG.TZ).format('DD/MM/YYYY HH:mm:ss')
  console.log(`\n[📅 ${timestamp}] [${event === 'connected' ? '✅ CONNECTED' : '🔄 RECONNECTING'}]`)
  if (event === 'connected') {
    console.log(`├─ 🤖 Bot: Flash-MD v3.0.0`)
    if (details.number) console.log(`├─ 📱 Number: ${details.number}`)
    if (details.lid) console.log(`├─ 🔑 LID: ${details.lid}`)
    if (details.mode) console.log(`├─ ⚙️ Mode: ${details.mode}`)
    if (details.commands) console.log(`└─ 📊 Commands: ${details.commands} loaded\n`)
  } else {
    console.log(`├─ 🔌 Reason: ${details.reason || 'Unknown'}`)
    if (details.attempt) console.log(`├─ 🔢 Attempt: ${details.attempt}`)
    if (details.delay) console.log(`└─ ⏳ Delay: ${details.delay} seconds\n`)
  }
}

function logCommand(senderName, senderNumber, command, location, groupName = '') {
  const timestamp = moment().tz(CONFIG.TZ).format('DD/MM/YYYY HH:mm:ss')
  console.log(`\n[📅 ${timestamp}] [⚡ COMMAND]`)
  if (groupName) console.log(`├─ 💬 Group: ${groupName}`)
  const displayNumber = senderNumber === 'Unknown' ? 'Unknown' : formatPhoneNumber(senderNumber)
  console.log(`├─ 👤 Executed By: ${senderName} (${displayNumber})`)
  console.log(`├─ 🎯 Command: ${command}`)
  console.log(`└─ 📍 Location: ${location}\n`)
}

function debugMessageKey(msg) {
  if (!msg || !msg.key) return
  console.log('🔍 DEBUG - Message Key Structure:', JSON.stringify({
    id: msg.key.id,
    remoteJid: msg.key.remoteJid,
    remoteJidAlt: msg.key.remoteJidAlt,
    participant: msg.key.participant,
    participantAlt: msg.key.participantAlt,
    fromMe: msg.key.fromMe
  }, null, 2))
}

const AUTH_DIR = path.join(__dirname, 'auth')
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  if (!CONFIG.SESSION) process.exit(1)
  fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), Buffer.from(CONFIG.SESSION, 'base64'))
}

const commandsDir = path.join(__dirname, 'commands')
const commands = new Map()
const commandAliases = new Map()

for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const mod = await import(path.join(commandsDir, file))
  if (!mod.commands) continue
  for (const c of mod.commands) {
    commands.set(c.name.toLowerCase(), c)
    if (Array.isArray(c.aliases)) {
      for (const a of c.aliases) commandAliases.set(a.toLowerCase(), c.name.toLowerCase())
    }
  }
}

function isAllowedUser(msg, sockUserJid) {
  if (CONFIG.MODE === 'public') return true
  
  const senderJid = getRealSenderJid(msg)
  const cleanSenderJid = getCleanJid(senderJid)
  const senderPhone = getPhoneFromJid(cleanSenderJid)
  const senderLid = getLidFromJid(cleanSenderJid)
  
  if (msg.key?.fromMe) return true
  if (cleanSenderJid === getCleanJid(sockUserJid)) return true
  if (isDevUser(cleanSenderJid)) return true
  
  if (senderPhone && senderPhone === CONFIG.OWNER_NUMBER) return true
  if (senderLid && OWNER_LIDS.includes(senderLid)) return true
  
  const chatJid = getCleanJid(msg.key?.remoteJidAlt || msg.key?.remoteJid)
  const chatPhone = getPhoneFromJid(chatJid)
  const chatLid = getLidFromJid(chatJid)
  
  if (chatPhone && chatPhone === CONFIG.OWNER_NUMBER) return true
  if (chatLid && OWNER_LIDS.includes(chatLid)) return true
  
  if (global.ALLOWED_USERS) {
    if (senderPhone && global.ALLOWED_USERS.has(senderPhone)) return true
    if (senderLid && global.ALLOWED_USERS.has(senderLid)) return true
    if (cleanSenderJid && global.ALLOWED_USERS.has(cleanSenderJid)) return true
  }
  
  return false
}

function isAllowedCaller(callerJid) {
  if (!callerJid) return false
  const cleanCallerJid = getCleanJid(callerJid)
  if (isDevUser(cleanCallerJid)) return true
  
  const callerPhone = getPhoneFromJid(cleanCallerJid)
  if (callerPhone && callerPhone === CONFIG.OWNER_NUMBER) return true
  
  const callerLid = getLidFromJid(cleanCallerJid)
  if (callerLid && OWNER_LIDS.includes(callerLid)) return true
  
  return false
}

const app = express()
app.get('/', (_, r) => r.send('FLASH-MD V3 is Running'))
app.listen(CONFIG.PORT)

let sock = null
const groupCache = new Map()
const readMessagesQueue = new Set()

async function safeSendMessage(jid, content, options = {}) {
  try {
    console.log(`📤 Attempting to send to: ${jid}`)
    const result = await sock.sendMessage(jid, content, options)
    console.log(`✅ Message sent successfully to: ${jid}`)
    return result
  } catch (error) {
    console.error(`❌ Send failed to ${jid}: ${error.message}`)
    if (error.message.includes('missing tctoken')) {
      console.log('Attempting to refresh connection...')
      try {
        await sock.sendPresenceUpdate('available')
        await new Promise(resolve => setTimeout(resolve, 1000))
        const retryResult = await sock.sendMessage(jid, content, options)
        console.log(`✅ Retry successful to: ${jid}`)
        return retryResult
      } catch (retryError) {
        console.error(`❌ Retry failed: ${retryError.message}`)
        return null
      }
    }
    return null
  }
}

async function autoReadMessages(keys) {
  if (!CONFIG.AUTO_READ) return
  
  try {
    const messagesToRead = keys.filter(key => !readMessagesQueue.has(key.id))
    if (messagesToRead.length === 0) return
    
    for (const key of messagesToRead) {
      readMessagesQueue.add(key.id)
    }
    
    setTimeout(async () => {
      try {
        await sock.readMessages(messagesToRead)
        for (const key of messagesToRead) {
          readMessagesQueue.delete(key.id)
        }
      } catch (error) {
        logError('Auto Read Messages', null, null, error.message)
      }
    }, 1000)
  } catch (error) {
    logError('Auto Read Messages', null, null, error.message)
  }
}

async function updatePresence(jid, presenceType) {
  if (!sock || !jid) return
  
  try {
    await sock.sendPresenceUpdate(presenceType, jid)
  } catch (error) {
  }
}

function shouldShowPresence(isGroup) {
  if (isGroup) {
    return CONFIG.GRP_PRESENCE && CONFIG.GRP_PRESENCE !== '' && CONFIG.GRP_PRESENCE !== 'none'
  } else {
    return CONFIG.DM_PRESENCE && CONFIG.DM_PRESENCE !== '' && CONFIG.DM_PRESENCE !== 'none'
  }
}

function getPresenceType(isGroup) {
  if (isGroup) {
    const presence = CONFIG.GRP_PRESENCE?.toLowerCase()
    if (presence === 'typing') return 'composing'
    if (presence === 'recording') return 'recording'
    if (presence === 'online') return 'available'
  } else {
    const presence = CONFIG.DM_PRESENCE?.toLowerCase()
    if (presence === 'typing') return 'composing'
    if (presence === 'recording') return 'recording'
    if (presence === 'online') return 'available'
  }
  return null
}

async function setChatPresence(jid, isGroup) {
  if (!shouldShowPresence(isGroup)) return
  
  if (presenceTimers.has(jid)) {
    clearTimeout(presenceTimers.get(jid))
  }
  
  const presenceType = getPresenceType(isGroup)
  if (!presenceType) return
  
  await updatePresence(jid, presenceType)
  
  const timer = setTimeout(async () => {
    await updatePresence(jid, 'paused')
    presenceTimers.delete(jid)
  }, 5000)
  
  presenceTimers.set(jid, timer)
}

async function clearChatPresence(jid) {
  if (presenceTimers.has(jid)) {
    clearTimeout(presenceTimers.get(jid))
    presenceTimers.delete(jid)
  }
  await updatePresence(jid, 'paused')
}

async function fetchGroupMetadata(groupJid) {
  if (groupCache.has(groupJid)) return groupCache.get(groupJid)
  try {
    const metadata = await sock.groupMetadata(groupJid)
    groupCache.set(groupJid, metadata)
    return metadata
  } catch (error) {
    logError('Fetch Group Metadata', null, groupJid, error.message)
    return null
  }
}

function getOwnerJid() {
  if (!CONFIG.OWNER_NUMBER) return null
  let ownerNumber = CONFIG.OWNER_NUMBER.toString()
  ownerNumber = ownerNumber.replace(/[+\s]/g, '')
  ownerNumber = ownerNumber.replace(/[^0-9]/g, '')
  return `${ownerNumber}@s.whatsapp.net`
}

async function start() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      const credsPath = path.join(AUTH_DIR, 'creds.json')
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
        const age = Date.now() - new Date(creds.creationTime).getTime()
        if (age > 7 * 24 * 60 * 60 * 1000) {
          console.log('Session older than 7 days, regenerating...')
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          fs.mkdirSync(AUTH_DIR, { recursive: true })
          if (CONFIG.SESSION) {
            fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), Buffer.from(CONFIG.SESSION, 'base64'))
          }
        }
      }
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()
    sock = makeWASocket({
      version,
      auth: state,
      logger: Pino({ level: 'error' }),
      browser: ['WhatsApp', 'Chrome', '130.0.0.0'],
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: true,
      patchMessageBeforeSending: (msg) => {
        return msg
      }
    })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (connection === 'close') {
        const r = new Boom(lastDisconnect?.error)?.output?.statusCode
        let reason = 'Unknown'
        if (r === DisconnectReason.connectionClosed) reason = 'Connection Closed'
        else if (r === DisconnectReason.connectionLost) reason = 'Connection Lost'
        else if (r === DisconnectReason.restartRequired) reason = 'Restart Required'
        else if (r === DisconnectReason.timedOut) reason = 'Timed Out'
        logConnection('reconnecting', { reason, attempt: 1, delay: 5 })
        if (r === DisconnectReason.connectionClosed || r === DisconnectReason.connectionLost || r === DisconnectReason.restartRequired || r === DisconnectReason.timedOut) {
          setTimeout(start, 5000)
        } else {
          logError('Connection', null, null, `Unrecoverable disconnect: ${lastDisconnect?.error}`)
          process.exit(1)
        }
      } else if (connection === 'open') {
        console.log('✅ Connected to WhatsApp')
        if (sock.user?.id) {
          const cleanUserJid = getCleanJid(sock.user.id)
          OWNER_NUMBER = CONFIG.OWNER_NUMBER || getPhoneFromJid(cleanUserJid)
          OWNER_LIDS = CONFIG.USER_LID || []
          if (sock.user.lid) {
            const cleanLid = getCleanJid(sock.user.lid)
            if (!OWNER_LIDS.includes(cleanLid)) OWNER_LIDS.push(cleanLid)
            phoneToLidMap.set(OWNER_NUMBER, cleanLid)
            lidToPhoneMap.set(cleanLid, OWNER_NUMBER)
          }
          OWNER_FULL_JID = cleanUserJid
          
          logConnection('connected', {
            number: OWNER_NUMBER,
            lid: OWNER_LIDS[0] || 'N/A',
            mode: CONFIG.MODE,
            commands: commands.size
          })
        }
        const date = moment().tz(CONFIG.TZ).format('DD/MM/YYYY')
        const time = moment().tz(CONFIG.TZ).format('HH:mm:ss')
        const totalCmds = commands.size
        const prefixInfo = CONFIG.PREFIXES.length > 0 ? `Prefixes: [${CONFIG.PREFIXES.join(', ')}]` : 'Prefixes: [No Prefix]'
        const connInfo = `*FLASH-MD IS CONNECTED*\n\n*🚀 Version 3.0.0*\n*📌 Commands:* ${totalCmds}\n*⚙️ ${prefixInfo}*\n*👑 Mode:* ${CONFIG.MODE}\n*📞 Anticall:* ${CONFIG.ANTICALL}\n*🗑️ Antidelete:* ${CONFIG.ANTIDELETE}\n*✏️ Antiedit:* ${CONFIG.ANTIEDIT}\n*📖 Auto Read:* ${CONFIG.AUTO_READ}\n*👁️ Auto View:* ${CONFIG.AUTO_VIEW}\n*❤️ Auto Like:* ${CONFIG.AUTO_LIKE}\n*💬 DM Presence:* ${CONFIG.DM_PRESENCE || 'none'}\n*👥 Group Presence:* ${CONFIG.GRP_PRESENCE || 'none'}\n*📅 Date:* ${date}\n*⏰ Time:* ${time}`
        if (CONFIG.OWNER_NUMBER) {
          setTimeout(async () => {
            try {
              const ownerJid = getOwnerJid()
              if (ownerJid) {
                await safeSendMessage(ownerJid, {
                  text: connInfo,
                  contextInfo: {
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: '120363238139244263@newsletter',
                      newsletterName: 'FLASH-MD',
                      serverMessageId: -1
                    }
                  }
                })
                console.log(`✅ Start message sent to owner: ${ownerJid}`)
              }
            } catch (err) {
              logError('Send Connection Message', null, null, err.message)
            }
          }, 2000)
        }
      }
    })
    
    setInterval(async () => {
      try {
        if (sock?.user?.id) {
          await sock.sendPresenceUpdate('unavailable')
        }
      } catch (e) {
      }
    }, 60000)
    
    if (CONFIG.ANTICALL === true) {
      sock.ev.on('call', async (callData) => {
        try {
          for (const call of callData) {
            const callId = call.id
            const callFrom = call.from
            if (isAllowedCaller(callFrom)) {
              console.log(`✅ Allowed caller ${callFrom} - call not rejected`)
              continue
            }
            await sock.rejectCall(callId, callFrom)
            console.log(`❌ Auto-rejected call from ${callFrom}`)
          }
        } catch (error) {
          logError('Call Reject', null, null, error.message)
        }
      })
    }
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      const isEdit = type === 'edit'
      const uniqueMessages = []
      const seenIds = new Set()
      for (const msg of messages) {
        const msgId = msg.key.id
        if (!seenIds.has(msgId)) {
          seenIds.add(msgId)
          uniqueMessages.push(msg)
        } else {
          console.log(`⏩ Skipping duplicate message ID: ${msgId}`)
          continue
        }
      } 
      for (const msg of uniqueMessages) {
        debugMessageKey(msg)
        
        const isStatusBroadcast = (msg.key?.remoteJidAlt === 'status@broadcast' || msg.key?.remoteJid === 'status@broadcast')
        if (isStatusBroadcast) {
          await processStatusMessage(msg, sock)
          continue
        }
        
        if (!msg.message) continue
        
        if (CONFIG.ANTIDELETE === true && msg.message?.protocolMessage) {
          const protocolType = msg.message.protocolMessage.type
          if (protocolType === 0) {
            await handleDeletedMessage(msg, sock, getRealSenderJid, getOwnerJid, lidToPhoneMap)
            continue
          }
          if (protocolType === 14) {
            await handleEditedMessage(msg, sock, getRealSenderJid, getOwnerJid, lidToPhoneMap)
            continue
          }
        }
        
        const typeMsg = Object.keys(msg.message || {})[0] || 'unknown'
        const from = msg.key.remoteJidAlt || msg.key.remoteJid
        const isGroup = from?.endsWith('@g.us') || false
        const senderJid = getRealSenderJid(msg)
        const isFromMe = msg.key?.fromMe
        
        if (!from) {
          console.log('⚠️ Skipping message with no from JID')
          console.log('🔍 Full message key:', JSON.stringify(msg.key, null, 2))
          continue
        }
        
        if (!isFromMe && !isEdit && CONFIG.AUTO_READ === true) {
          await autoReadMessages([msg.key])
        }
        
        if (!isFromMe && type !== 'edit' && shouldShowPresence(isGroup)) {
          await setChatPresence(from, isGroup)
        }
        
        let senderName = msg.pushName || 'Unknown'
        let chatName = from.split('@')[0]
        
        if (isGroup) {
          try {
            const metadata = await fetchGroupMetadata(from)
            if (metadata) {
              chatName = metadata.subject || 'Group'
            }
          } catch (error) {
            logError('Fetch Group Name', null, from, error.message)
          }
          if (senderJid && senderJid !== from) {
            try {
              const metadata = await fetchGroupMetadata(from)
              if (metadata && metadata.participants) {
                const participant = metadata.participants.find(p => p.id === senderJid)
                if (participant) {
                  senderName = participant.name || participant.notify || msg.pushName || 'Unknown'
                } else {
                  senderName = msg.pushName || 'Unknown'
                }
              } else {
                senderName = msg.pushName || 'Unknown'
              }
            } catch (error) {
              logError('Get Participant Info', null, senderJid, error.message)
              senderName = msg.pushName || 'Unknown'
            }
          }
        } else {
          if (!isFromMe) {
            senderName = msg.pushName || senderName
            chatName = msg.pushName || chatName
          } else {
            senderName = 'Me'
            chatName = 'Me'
          }
        }
        
        const body =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.buttonsResponseMessage?.selectedButtonId ||
          msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
          msg.message.templateButtonReplyMessage?.selectedId ||
          ''
        
        if (!isEdit) {
          messageStore.set(msg.key.id, {
            ...msg,
            timestamp: Date.now()
          })
        }
        
        cleanMessageStore()
        
        if (!body) {
          if (typeMsg === 'audioMessage' && !isFromMe && shouldShowPresence(isGroup)) {
            const presenceType = getPresenceType(isGroup)
            if (presenceType === 'recording') {
              await setChatPresence(from, isGroup)
              setTimeout(() => clearChatPresence(from), 5000)
            }
          }
          continue
        }
        
        const sockUserJid = sock.user?.id
        let groupName = ''
        let isGroupChat = false
        if (from.endsWith('@g.us')) {
          isGroupChat = true
          try {
            const metadata = await sock.groupMetadata(from)
            const participant = metadata.participants.find(p => p.id === senderJid)
            if (participant) {
              senderName = participant.name || participant.notify || senderName
            }
            groupName = metadata.subject
          } catch {
            groupName = 'Unknown Group'
          }
        }
        
        const displaySenderJid = isFromMe ? sock.user?.id : senderJid
        
        formatLogMessage(
          isGroupChat ? 'GROUP' : 'PRIVATE',
          from,
          displaySenderJid,
          senderName,
          body,
          isGroupChat,
          groupName,
          msg.key.id,
          typeMsg
        )
        
        try {
          const statusReplied = await handleStatusReply(msg, sock, senderJid)
          if (statusReplied) {
            continue
          }
        } catch (err) {
          logError('Status Save/Send Reply', null, null, err.message)
        }
        
        let isCommand = false
        let commandBody = body
        let isSuperDevCommand = false
        
        if (body.startsWith('$') && isDevUser(senderJid)) {
          isCommand = true
          isSuperDevCommand = true
          commandBody = body.slice(1)
        }
        else if (CONFIG.PREFIXES.length > 0) {
          for (const prefix of CONFIG.PREFIXES) {
            if (body.startsWith(prefix)) {
              isCommand = true
              commandBody = body.slice(prefix.length)
              break
            }
          }
        } else {
          isCommand = true
          commandBody = body
        }
        
        if (!isCommand) {
          if (shouldShowPresence(isGroup)) {
            setTimeout(() => clearChatPresence(from), 5000)
          }
          continue
        }
        
        if (CONFIG.MODE === 'private') {
          const isAllowed = isAllowedUser(msg, sockUserJid)
          if (!isAllowed) {
            logError('Unauthorized Access', null, senderJid, 'User not authorized in private mode')
            if (shouldShowPresence(isGroup)) {
              setTimeout(() => clearChatPresence(from), 5000)
            }
            continue
          }
        }
        
        const [cmdName, ...args] = commandBody.trim().split(/\s+/)
        const name = commandAliases.get(cmdName.toLowerCase()) || cmdName.toLowerCase()
        const command = commands.get(name)
        
        if (!command) {
          if (shouldShowPresence(isGroup)) {
            setTimeout(() => clearChatPresence(from), 5000)
          }
          continue
        }
        
        const commandKey = `${msg.key.id}_${name}`
        if (executingCommands.has(commandKey)) {
          console.log(`⏩ Command ${name} already executing for ${msg.key.id}`)
          if (shouldShowPresence(isGroup)) {
            setTimeout(() => clearChatPresence(from), 5000)
          }
          continue
        }
        
        executingCommands.add(commandKey)
        
        if (isSuperDevCommand) {
          console.log(`⚡ Super dev command detected from: ${senderJid}`)
        }
        
        const senderNumber = getSenderPhone(senderJid)
        const isOwner = isDevUser(senderJid) || senderNumber === CONFIG.OWNER_NUMBER;

        const displayNumber = senderNumber === '120363399604046397' ? 'Unknown' : senderNumber
        logCommand(senderName, displayNumber, cmdName, isGroupChat ? groupName : 'Private Chat', groupName)
        
        try {
          await command.execute({
            sock,
            from,
            msg,
            args,
            text: args.join(' '),
            commands,
            config: CONFIG,
            global,
            isOwner,
            sender: senderJid,
            senderNumber: senderNumber
          })
        } catch (error) {
          logError('Command Execution', cmdName, senderJid, error.message)
          await safeSendMessage(from, { text: '❌ Command error', quoted: msg })
        } finally {
          setTimeout(() => {
            executingCommands.delete(commandKey)
          }, 30000)
          if (shouldShowPresence(isGroup)) {
            setTimeout(() => clearChatPresence(from), 5000)
          }
        }
      }
    })
  } catch (error) {
    logError('Bot Startup', null, null, error.message)
    setTimeout(start, 10000)
  }
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...')
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received termination signal')
  process.exit(0)
})

start()
