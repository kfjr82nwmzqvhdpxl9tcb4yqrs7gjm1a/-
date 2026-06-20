import axios from 'axios'
import { MESSAGES } from '../france/index.js'
import { t, translate, translateAIResponse, getUserLang } from '../france/translator.js'

export const commands = [
{
  name: 'lyrics',
  aliases: ['lyric','songlyrics'],
  description: 'Get song lyrics',
  category: 'Search',

  execute: async ({ sock, from, text, msg, config }) => {

    const botName = config.BOT_NAME || 'Flash-MD'
    const botVersion = config.BOT_VERSION || '3.0.0'

    if (!text) {
      const noQueryMsg = await t(from, 'lyrics', 'noQuery')
      return sock.sendMessage(from,{
        text: noQueryMsg
          .replace('{botName}',botName)
          .replace('{botVersion}',botVersion)
      },{ quoted: msg })
    }

    try {

      const url = `https://api.popcat.xyz/v2/lyrics?song=${encodeURIComponent(text)}`
      const { data } = await axios.get(url)

      if (data.error || !data.lyrics) {
        const notFoundMsg = await t(from, 'lyrics', 'notFound')
        return sock.sendMessage(from,{
          text: notFoundMsg
        },{ quoted: msg })
      }

      const userLang = getUserLang(from)

      const translatedTitle = await translate(data.title, userLang)
      const translatedArtist = await translate(data.artist, userLang)
      
      let lyricsText = data.lyrics || data.message || ''
      
      if (lyricsText.length > 3500) {
        lyricsText = lyricsText.slice(0, 3500) + '...'
      }
      
      const translatedLyrics = await translate(lyricsText, userLang)

      const resultTemplate = await t(from, 'lyrics', 'result')
      const caption = resultTemplate
        .replace('{title}', translatedTitle)
        .replace('{artist}', translatedArtist)
        .replace('{lyrics}', translatedLyrics)
        .replace('{url}', data.url || '')

      const imageUrl = data.image || data.thumbnail || data.albumArt || null
      
      if (imageUrl) {
        await sock.sendMessage(from,{
          image: { url: imageUrl },
          caption
        },{ quoted: msg })
      } else {
        await sock.sendMessage(from,{
          text: caption
        },{ quoted: msg })
      }

    } catch (err) {
      console.error('Lyrics error:', err)
      const errorMsg = await t(from, 'lyrics', 'error')
      sock.sendMessage(from,{
        text: errorMsg
          .replace('{botName}',botName)
          .replace('{botVersion}',botVersion)
      },{ quoted: msg })
    }

  }
}
]
