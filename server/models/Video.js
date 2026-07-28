const mongoose = require('mongoose')

const formatSchema = new mongoose.Schema({
  itag: String,
  qualityLabel: String,
  container: String,
  size: Number,
  mimeType: String,
})

const videoSchema = new mongoose.Schema({
  videoId: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  title: String,
  author: String,
  duration: Number,
  thumbnail: String,
  formats: [formatSchema],
  fetchCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  lastFetchedAt: Date,
  lastDownloadedAt: Date,
  lastDownloadFormat: String,
})

module.exports = mongoose.model('Video', videoSchema)
