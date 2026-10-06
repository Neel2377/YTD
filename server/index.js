require('dotenv').config()
const { spawn } = require('child_process')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const mongoose = require('mongoose')
const ffmpegPath = require('ffmpeg-static')
const youtubedl = require('youtube-dl-exec')
const Video = require('./models/Video')

const app = express()
const port = process.env.PORT || 5000

app.use(helmet())
app.use(cors())
app.use(morgan('tiny'))
app.use(express.json())
app.use(express.static(path.join(__dirname, '../client/dist')))

const mongoUri = process.env.MONGODB_URI || (process.env.NODE_ENV === 'production' ? '' : 'mongodb://127.0.0.1:27017/ytd')
if (mongoUri && process.env.NODE_ENV !== 'test') {
  mongoose
    .connect(mongoUri)
    .then(() => console.log('Connected to MongoDB:', mongoUri))
    .catch((err) => console.error('MongoDB connection failed:', err))
} else if (!mongoUri && process.env.NODE_ENV === 'production') {
  console.warn('MONGODB_URI is not configured; video history and download tracking are disabled.')
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
  return youtubedl(videoUrl, {
    dumpSingleJson: true,
    skipDownload: true,
    noWarnings: true,
    preferFreeFormats: true,
    jsRuntimes: 'node',
  })
}

const getYtDlpErrorMessage = (error) => {
  const output = String(error.stderr || error.message || '').trim()
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const detail = lines.findLast((line) => /^ERROR:/i.test(line)) || lines.at(-1)
  return (detail || 'The video extractor could not process this link.')
    .replace(/^ERROR:\s*/i, '')
    .slice(0, 300)
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
  if (mongoose.connection.readyState !== 1) return null

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
      returnDocument: 'after',
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  )
}

const trackDownload = async (normalizedUrl, itag) => {
  if (mongoose.connection.readyState !== 1) return null

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
    { returnDocument: 'after' }
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
  const formatsByHeight = new Map()

  ;(infoFormats || []).forEach((format) => {
    const height = Number(format.height || format.qualityLabel?.match(/(\d+)p/)?.[1] || 0)
    const hasVideo = format.vcodec != null
      ? format.vcodec !== 'none'
      : Boolean(format.hasVideo || height || format.width)
    if (!hasVideo || !height || height > 4320 || formatsByHeight.has(height)) return

    formatsByHeight.set(height, format)
  })

  return [...formatsByHeight.keys()]
    .sort((a, b) => b - a)
    .map((height) => {
      const format = formatsByHeight.get(height)
      const sizeBytes = format.filesize || format.filesize_approx || format.contentLength || 0

      return {
        itag: `height:${height}`,
        qualityLabel: `${height}p`,
        container: 'mkv',
        size: sizeBytes ? bytesToMB(Number(sizeBytes)) : null,
        mimeType: 'video/x-matroska',
      }
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
    const detail = getYtDlpErrorMessage(error)
    console.error('Unable to load YouTube metadata:', error.stderr || error.message || error)
    res.status(502).json({ error: `Unable to load video information: ${detail}` })
  }
})

app.get('/api/download', async (req, res) => {
  try {
    const videoUrl = req.query.videoUrl
    const itag = req.query.itag
    const selectedHeight = String(itag || '').match(/^height:(\d{2,4})$/)?.[1]

    if (!videoUrl || !selectedHeight || !isValidYouTubeUrl(videoUrl)) {
      return res.status(400).json({ error: 'Missing or invalid video URL / format.' })
    }

    const normalizedUrl = normalizeYoutubeUrl(videoUrl)
    console.log('Starting download for', normalizedUrl, 'itag=', itag)
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytd-download-'))
    const outputTemplate = path.join(tempDirectory, 'video.%(ext)s')
    const downloadProcess = spawn(
      youtubedl.constants.YOUTUBE_DL_PATH,
      [
        ...youtubedl.args({
          format: `bestvideo[height<=${selectedHeight}]+bestaudio/best[height<=${selectedHeight}]`,
          output: outputTemplate,
          mergeOutputFormat: 'mkv',
          ffmpegLocation: ffmpegPath,
          jsRuntimes: 'node',
          noWarnings: true,
          noProgress: true,
          noPlaylist: true,
          retries: 3,
        }),
        normalizedUrl,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderrOutput = ''
    let clientDisconnected = false
    downloadProcess.stderr.on('data', (chunk) => {
      stderrOutput = (stderrOutput + chunk.toString('utf8')).slice(-8000)
    })
    const stopDownloadOnDisconnect = () => {
      if (!res.writableEnded && downloadProcess.exitCode === null) {
        clientDisconnected = true
        downloadProcess.kill()
      }
    }
    res.once('close', stopDownloadOnDisconnect)

    try {
      const exit = await new Promise((resolve, reject) => {
        downloadProcess.once('error', reject)
        downloadProcess.once('close', (code, signal) => resolve({ code, signal }))
      })

      if (clientDisconnected) {
        await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {})
        return
      }
      if (exit.code !== 0) {
        throw new Error(stderrOutput.trim() || `yt-dlp exited with code ${exit.code} (${exit.signal || 'no signal'})`)
      }

      const outputFiles = await fs.readdir(tempDirectory)
      const downloadPath = path.join(tempDirectory, outputFiles.find((file) => file.startsWith('video.')) || '')
      if (!outputFiles.some((file) => file.startsWith('video.'))) {
        throw new Error('yt-dlp completed without creating a video file')
      }

      const extension = path.extname(downloadPath)
      const filename = `YouTube-${extractVideoId(normalizedUrl)}${extension}`
      trackDownload(normalizedUrl, itag).catch((dbError) => {
        console.warn('Unable to track download in MongoDB:', dbError.message || dbError)
      })

      res.download(downloadPath, filename, (error) => {
        if (error) {
          console.error('Unable to send downloaded file:', error)
          if (!res.headersSent) res.status(500).json({ error: 'Unable to send the downloaded video.' })
        }
        fs.rm(tempDirectory, { recursive: true, force: true }).catch((cleanupError) => {
          console.warn('Unable to remove temporary download:', cleanupError.message || cleanupError)
        })
      })
    } catch (error) {
      await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {})
      if (clientDisconnected) return
      console.error('yt-dlp download failed:', error.message || error)
      if (!res.headersSent) {
        res.status(502).json({ error: `Download failed: ${getYtDlpErrorMessage(error)}` })
      }
    } finally {
      res.removeListener('close', stopDownloadOnDisconnect)
    }
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
