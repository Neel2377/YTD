require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const mongoose = require('mongoose')
const youtubedl = require('youtube-dl-exec')
const Video = require('./models/Video')

const app = express()
const port = process.env.PORT || 5000

app.use(helmet())
app.use(cors())
app.use(morgan('tiny'))
app.use(express.json())

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ytd'
mongoose
  .connect(mongoUri)
  .then(() => console.log('Connected to MongoDB:', mongoUri))
  .catch((err) => console.error('MongoDB connection failed:', err))

const normalizeYoutubeUrl = (url) => {
  if (!url) return ''
  try {
    const parsed = new URL(url.includes('://') ? url : `https://www.youtube.com/watch?v=${url}`)
    const host = parsed.hostname.replace(/^www\./, '')

    if (host === 'youtu.be') {
      return `https://www.youtube.com/watch?v=${parsed.pathname.slice(1)}`
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      return parsed.toString()
    }
  } catch (err) {
    return `https://www.youtube.com/watch?v=${url}`
  }

  return url
}

const isValidYouTubeUrl = (url) => {
  if (!url) return false
  try {
    const normalized = normalizeYoutubeUrl(url)
    const parsed = new URL(normalized)
    const host = parsed.hostname.replace(/^www\./, '')
    return host === 'youtube.com' || host === 'm.youtube.com'
  } catch (err) {
    return false
  }
}

const fetchVideoInfo = async (videoUrl) => {
  return youtubedl(videoUrl, {
    dumpSingleJson: true,
    skipDownload: true,
    noWarnings: true,
    noCallHome: true,
    preferFreeFormats: true,
    youtubeSkipDashManifest: true,
  })
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
  const availableHeights = new Set()

  infoFormats
    .filter((format) => format.format_id && format.height)
    .forEach((format) => {
      if (format.vcodec !== 'none') {
        availableHeights.add(Number(format.height))
      }
    })

  const orderedHeights = [2160, 1440, 1080, 720, 480, 360, 240]
  const bestAudio = findBestAudioFormat(infoFormats)

  orderedHeights.forEach((height) => {
    const hasVideoAtHeight = Array.from(availableHeights).some((h) => h >= height)
    if (!hasVideoAtHeight) return

    const videoFormat = findBestVideoForHeight(infoFormats, height)
    const estimatedSize = videoFormat && bestAudio
      ? bytesToMB((videoFormat.filesize_approx || 0) + (bestAudio.filesize_approx || 0))
      : videoFormat
      ? bytesToMB(videoFormat.filesize_approx)
      : null

    const itag = `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
    if (seen.has(itag)) return
    seen.add(itag)

    formats.push({
      itag,
      qualityLabel: `${height}p`,
      container: 'mp4',
      size: estimatedSize,
      mimeType: videoFormat?.mime_type || 'video/mp4',
    })
  })

  if (!seen.has('best')) {
    const bestVideo = infoFormats
      .filter((format) => format.format_id && format.vcodec !== 'none')
      .sort((a, b) => ((b.height || 0) - (a.height || 0)) || ((b.filesize_approx || 0) - (a.filesize_approx || 0)))[0]

    const bestSize = bestVideo && bestAudio
      ? bytesToMB((bestVideo.filesize_approx || 0) + (bestAudio.filesize_approx || 0))
      : bestVideo
      ? bytesToMB(bestVideo.filesize_approx)
      : null

    formats.push({
      itag: 'best',
      qualityLabel: 'Best available',
      container: 'mp4',
      size: bestSize,
      mimeType: bestVideo?.mime_type || 'video/mp4',
    })
  }

  infoFormats
    .filter((format) => format.format_id && !seen.has(format.format_id))
    .forEach((format) => {
      if (format.vcodec === 'none' || format.acodec === 'none') return
      seen.add(format.format_id)
      formats.push({
        itag: format.format_id,
        qualityLabel: format.format || `${format.height || 'unknown'}p`,
        container: format.ext || 'mp4',
        size: format.filesize_approx ? bytesToMB(format.filesize_approx) : null,
        mimeType: format.mime_type || `video/${format.ext || 'mp4'}`,
      })
    })

  return formats
}

app.get('/api/metadata', async (req, res) => {
  try {
    const videoUrl = req.query.videoUrl

    if (!videoUrl || !isValidYouTubeUrl(videoUrl)) {
      return res.status(400).json({ error: 'Please provide a valid YouTube URL.' })
    }

    const normalizedUrl = normalizeYoutubeUrl(videoUrl)
    const info = await fetchVideoInfo(normalizedUrl)
    const formats = formatDownloadOptions(info.formats || [])

    if (!formats.length) {
      return res.status(500).json({ error: 'Unable to find downloadable formats.' })
    }

    await saveVideoMetadata(normalizedUrl, info, formats)

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
    const downloadProcess = youtubedl.exec(normalizedUrl, {
      format: itag,
      output: '-',
      quiet: true,
      noWarnings: true,
      noCallHome: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      mergeOutputFormat: 'mp4',
    }, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (!downloadProcess || !downloadProcess.stdout) {
      throw new Error('Download stream unavailable')
    }

    downloadProcess.stderr.on('data', (chunk) => console.error('download stderr:', chunk.toString()))
    downloadProcess.stdout.on('error', (err) => console.error('download stdout error', err))
    downloadProcess.stdout.pipe(res)

    downloadProcess.on('close', async (code) => {
      console.log('download process closed', code)
      if (!res.writableEnded) {
        res.end()
      }
    })

    downloadProcess.on('error', (err) => {
      console.error('download process error', err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed. Please try again.' })
      } else if (!res.writableEnded) {
        res.end()
      }
    })

    await trackDownload(normalizedUrl, itag)

    res.on('close', () => {
      if (!downloadProcess.killed) {
        downloadProcess.kill('SIGTERM')
      }
    })
  } catch (error) {
    console.error(error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed. Please try again.' })
    }
  }
})

app.listen(port, () => {
  console.log(`YouTube downloader API running on http://localhost:${port}`)
})
