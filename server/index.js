require('dotenv').config()
const path = require('path')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const mongoose = require('mongoose')
const ytdl = require('ytdl-core')
const youtubedl = require('youtube-dl-exec')
const Video = require('./models/Video')

const app = express()
const port = process.env.PORT || 5000

app.use(helmet())
app.use(cors())
app.use(morgan('tiny'))
app.use(express.json())
app.use(express.static(path.join(__dirname, '../client/dist')))

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ytd'
if (process.env.NODE_ENV !== 'test') {
  mongoose
    .connect(mongoUri)
    .then(() => console.log('Connected to MongoDB:', mongoUri))
    .catch((err) => console.error('MongoDB connection failed:', err))
}

const normalizeYoutubeUrl = (url) => {
  if (!url) return ''
  const trimmed = String(url).trim()
  if (!trimmed) return ''

  const buildWatchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`
  const parseUrlOrThrow = (input) => {
    try {
      return new URL(input)
    } catch (err) {
      return new URL(`https://${input}`)
    }
  }

  try {
    const parsed = parseUrlOrThrow(trimmed)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    const path = parsed.pathname || ''

    if (host === 'youtu.be') {
      const videoId = path.slice(1)
      return buildWatchUrl(videoId)
    }

    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      const videoId = parsed.searchParams.get('v')
      if (videoId) {
        return buildWatchUrl(videoId)
      }

      if (path.startsWith('/shorts/')) {
        return buildWatchUrl(path.split('/').pop() || '')
      }

      if (path.startsWith('/embed/')) {
        return buildWatchUrl(path.split('/').pop() || '')
      }

      return parsed.toString()
    }

    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
      return buildWatchUrl(trimmed)
    }

    return trimmed
  } catch (err) {
    return `https://www.youtube.com/watch?v=${trimmed}`
  }
}

const isValidYouTubeUrl = (url) => {
  if (!url) return false
  const trimmed = String(url).trim()
  if (!trimmed) return false
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return true

  try {
    const normalized = normalizeYoutubeUrl(trimmed)
    const parsed = new URL(normalized)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)
  } catch (err) {
    return false
  }
}

const fetchVideoInfo = async (videoUrl) => {
  try {
    const info = await ytdl.getInfo(videoUrl, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      },
    })
    return info
  } catch (error) {
    console.warn('ytdl-core metadata failed, falling back to youtube-dl-exec:', error.message)
    return youtubedl(videoUrl, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noCallHome: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
    })
  }
}

const extractVideoId = (url) => {
  try {
    const parsed = new URL(normalizeYoutubeUrl(url))
    return parsed.searchParams.get('v') || parsed.pathname.slice(1)
  } catch (err) {
    return url
  }
}

const saveVideoMetadata = async (normalizedUrl, info, formats) => {
  const videoId = extractVideoId(normalizedUrl)
  const thumbnail = info.thumbnails?.[info.thumbnails.length - 1]?.url || info.thumbnail || ''

  return Video.findOneAndUpdate(
    { videoId },
    {
      $set: {
        videoId,
        url: normalizedUrl,
        title: info.title || info.videoDetails?.title || 'Unknown title',
        author: info.uploader || info.uploader_id || 'Unknown author',
        duration: info.duration || info.videoDetails?.length_seconds || info.videoDetails?.lengthSeconds || null,
        thumbnail,
        formats,
        lastFetchedAt: new Date(),
      },
      $inc: { fetchCount: 1 },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  )
}

const trackDownload = async (normalizedUrl, itag) => {
  const videoId = extractVideoId(normalizedUrl)
  return Video.findOneAndUpdate(
    { videoId },
    {
      $inc: { downloadCount: 1 },
      $set: {
        lastDownloadedAt: new Date(),
        lastDownloadFormat: itag,
      },
    },
    { new: true }
  )
}

const bytesToMB = (bytes) => {
  if (!bytes || typeof bytes !== 'number') return null
  return Math.max(1, Math.round(bytes / 1024 / 1024))
}

const findBestVideoForHeight = (formats, height) => {
  return formats
    .filter((format) => format.format_id && format.vcodec !== 'none' && format.height && format.height <= height)
    .sort((a, b) => (b.height - a.height) || ((b.filesize_approx || 0) - (a.filesize_approx || 0)))[0]
}

const findBestAudioFormat = (formats) => {
  return formats
    .filter((format) => format.format_id && format.acodec !== 'none' && format.vcodec === 'none')
    .sort((a, b) => ((b.abr || 0) - (a.abr || 0)) || ((b.filesize_approx || 0) - (a.filesize_approx || 0)))[0]
}

const formatDownloadOptions = (infoFormats) => {
  const seen = new Set()
  const formats = []

  ;(infoFormats || []).forEach((format) => {
    const itag = format.format_id || format.id || format.itag
    if (!itag || seen.has(String(itag))) return

    const height = Number(format.height || format.qualityLabel?.match(/(\d+)p/)?.[1] || 0)
    const hasVideo = format.vcodec !== 'none' || format.hasVideo || Boolean(height) || Boolean(format.width)
    const hasAudio = format.acodec !== 'none' || format.hasAudio || Boolean(format.audioBitrate)
    if (!hasVideo || (!hasAudio && !height)) return

    const container = format.ext || format.container || 'mp4'
    const mimeType = format.mime_type || format.mimeType || `video/${container}`
    const qualityLabel = format.qualityLabel || format.format || (height ? `${height}p` : 'Unknown quality')
    const sizeBytes = format.filesize_approx || format.contentLength || 0
    const size = sizeBytes ? bytesToMB(Number(sizeBytes)) : null

    seen.add(String(itag))
    formats.push({
      itag: String(itag),
      qualityLabel,
      container,
      size,
      mimeType,
    })
  })

  return formats.sort((a, b) => {
    const aHeight = Number(a.qualityLabel.match(/(\d+)p/)?.[1] || 0)
    const bHeight = Number(b.qualityLabel.match(/(\d+)p/)?.[1] || 0)
    return bHeight - aHeight
  })
}

app.get('/api/metadata', async (req, res) => {
  try {
    const videoUrl = String(req.query.videoUrl || '').trim()

    if (!videoUrl || !isValidYouTubeUrl(videoUrl)) {
      return res.status(400).json({ error: 'Please provide a valid YouTube URL.' })
    }

    const normalizedUrl = normalizeYoutubeUrl(videoUrl)
    const info = await fetchVideoInfo(normalizedUrl)
    const formats = formatDownloadOptions(info.formats || [])

    if (!formats.length) {
      return res.status(500).json({ error: 'Unable to find downloadable formats.' })
    }

    try {
      await saveVideoMetadata(normalizedUrl, info, formats)
    } catch (dbError) {
      console.warn('Unable to save metadata to MongoDB:', dbError.message || dbError)
    }

    res.json({
      title: info.title || info.videoDetails?.title || 'Unknown title',
      author: info.uploader || info.uploader_id || 'Unknown author',
      duration: info.duration || info.videoDetails?.length_seconds || info.videoDetails?.lengthSeconds || null,
      thumbnails: info.thumbnails || (info.thumbnail ? [{ url: info.thumbnail }] : []),
      formats,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Unable to load video information. Please try another YouTube link.' })
  }
})

app.get('/api/download', async (req, res) => {
  try {
    const videoUrl = req.query.videoUrl
    const itag = req.query.itag

    if (!videoUrl || !itag || !isValidYouTubeUrl(videoUrl)) {
      return res.status(400).json({ error: 'Missing or invalid video URL / format.' })
    }

    const normalizedUrl = normalizeYoutubeUrl(videoUrl)
    const safeTitle = (normalizedUrl || 'video')
      .replace(/[^a-z0-9-_\.]/gi, '_')
      .slice(0, 120)
    const extension = 'mp4'
    const mimeType = 'video/mp4'

    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${extension}"`)
    res.setHeader('Content-Type', mimeType)

    console.log('Starting download for', normalizedUrl, 'itag=', itag)
    const info = await ytdl.getInfo(normalizedUrl, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      },
    })
    const selectedFormat = info.formats.find((format) => String(format.itag) === String(itag)) || info.formats[0]
    if (!selectedFormat) {
      throw new Error('No downloadable format found for selected quality')
    }

    const downloadStream = ytdl.downloadFromInfo(info, { format: selectedFormat })
    downloadStream.on('error', (err) => {
      console.error('download stream error', err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed. Please try again.' })
      } else if (!res.writableEnded) {
        res.end()
      }
    })
    downloadStream.on('end', () => {
      if (!res.writableEnded) {
        res.end()
      }
    })
    downloadStream.pipe(res)

    try {
      await trackDownload(normalizedUrl, itag)
    } catch (dbError) {
      console.warn('Unable to track download in MongoDB:', dbError.message || dbError)
    }

    res.on('close', () => {
      if (downloadStream && typeof downloadStream.destroy === 'function') {
        downloadStream.destroy()
      }
    })
  } catch (error) {
    console.error(error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed. Please try again.' })
    }
  }
})

app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'))
})

if (require.main === module) {
  app.listen(port, () => {
    console.log(`YouTube downloader API running on http://localhost:${port}`)
  })
}

module.exports = {
  app,
  normalizeYoutubeUrl,
  isValidYouTubeUrl,
  fetchVideoInfo,
  formatDownloadOptions,
}
