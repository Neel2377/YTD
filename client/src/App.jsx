import { useState } from 'react'
import axios from 'axios'
import './App.css'

const formatDuration = (seconds) => {
  const sec = Number(seconds || 0)
  const mins = Math.floor(sec / 60)
  const secs = sec % 60
  return `${mins}m ${secs.toString().padStart(2, '0')}s`
}

const isValidYoutubeUrl = (url) => {
  if (!url) return false
  const trimmed = url.trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return true

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    const host = parsed.hostname.replace(/^www\./, '')
    return [
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
    ].includes(host)
  } catch {
    return false
  }
}

const backendOrigin = import.meta.env.DEV ? 'http://localhost:5000' : ''

function App() {
  const [videoUrl, setVideoUrl] = useState('')
  const [metadata, setMetadata] = useState(null)
  const [selectedItag, setSelectedItag] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('idle')

  const fetchMetadata = async (event) => {
    event.preventDefault()
    setError('')
    setMetadata(null)
    setSelectedItag('')

    if (!isValidYoutubeUrl(videoUrl)) {
      setError('Please enter a valid YouTube URL or video ID before fetching metadata.')
      setStatus('error')
      return
    }

    setStatus('loading')

    try {
      const response = await axios.get('/api/metadata', {
        params: { videoUrl },
      })

      setMetadata(response.data)
      setSelectedItag(response.data.formats[0]?.itag ?? '')
      setStatus('ready')
    } catch (err) {
      const message = err.response?.data?.error || 'Unable to load video info. Check the URL and try again.'
      setError(message)
      setStatus('error')
    }
  }

  const handleDownload = () => {
    if (!metadata || !selectedItag) {
      setError('Select a valid quality to download.')
      return
    }

    const url = `${backendOrigin}/api/download?videoUrl=${encodeURIComponent(videoUrl)}&itag=${encodeURIComponent(selectedItag)}`
    window.location.assign(url)
  }

  return (
    <div className="page-shell">
      <div className="app-shell">
        <section className="hero-panel">
          <div className="hero-copy">
            <span className="eyebrow">YouTube Downloader</span>
            <h1>Save YouTube videos in a flash</h1>
            <p>Paste a YouTube link, preview the best formats, and download videos instantly.</p>
          </div>
          <form className="download-form" onSubmit={fetchMetadata}>
            <label htmlFor="videoUrl">Video URL</label>
            <input
              id="videoUrl"
              type="text"
              placeholder="https://www.youtube.com/watch?v=..."
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
            />

            <div className="button-row">
              <button type="submit" className="primary-button" disabled={status === 'loading'}>
                {status === 'loading' ? 'Searching...' : 'Fetch info'}
              </button>
              <span className={`status-pill ${status}`}>{status === 'loading' ? 'Loading' : status === 'ready' ? 'Ready' : status === 'error' ? 'Error' : 'Waiting for URL'}</span>
            </div>
            {error && <div className="notice error">{error}</div>}
          </form>
        </section>

        {metadata && (
          <section className="metadata-panel">
            <div className="metadata-card">
              <img
                className="thumbnail"
                src={metadata.thumbnails[metadata.thumbnails.length - 1]?.url}
                alt={metadata.title}
              />
              <div className="metadata-body">
                <h2>{metadata.title}</h2>
                <p className="meta-text">Channel: {metadata.author}</p>
                <p className="meta-text">Duration: {formatDuration(metadata.duration)}</p>
                <p className="meta-text">Formats available: {metadata.formats.length}</p>
              </div>
            </div>

            <div className="download-panel">
              <div className="download-panel-header">
                <h3>Choose quality</h3>
                <p>Pick your desired resolution and download the video right away.</p>
              </div>
              <label htmlFor="quality">Format</label>
              <select
                id="quality"
                value={selectedItag}
                onChange={(event) => setSelectedItag(event.target.value)}
              >
                {metadata.formats.map((format) => (
                  <option key={format.itag} value={format.itag}>
                    {format.qualityLabel} • {format.container.toUpperCase()} {format.size ? `(${format.size} MB)` : ''}
                  </option>
                ))}
              </select>
              <button className="primary-button secondary" type="button" onClick={handleDownload}>
                Download now
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export default App
