const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeYoutubeUrl, formatDownloadOptions } = require('../index.js')

test('normalizeYoutubeUrl converts youtu.be links to watch URLs', () => {
  assert.equal(normalizeYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
})

test('formatDownloadOptions converts ytdl-core-style formats into UI-friendly options', () => {
  const formats = formatDownloadOptions([
    { itag: 22, mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"', container: 'mp4', qualityLabel: '720p', height: 720, contentLength: 2000000, hasVideo: true, hasAudio: true },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', container: 'm4a', qualityLabel: 'tiny', audioBitrate: 128000, hasAudio: true },
  ])

  assert.ok(formats.length >= 1)
  assert.equal(formats[0].itag, '22')
  assert.equal(formats[0].qualityLabel, '720p')
  assert.equal(formats[0].container, 'mp4')
})
