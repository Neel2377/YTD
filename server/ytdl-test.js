const ytdl = require('ytdl-core')
const url = 'https://youtu.be/enjkcCdAlXc?si=pFXg7kvww_gy6GYv'
console.log('validateURL', ytdl.validateURL(url))
console.log('validateID', ytdl.validateID(url))

;(async () => {
  try {
    const info = await ytdl.getInfo(url)
    console.log('title:', info.videoDetails.title)
  } catch (err) {
    console.error('getInfo error:', err && err.message)
    console.error(err)
  }
})()
