const http = require('http')
const querystring = require('querystring')

const params = querystring.stringify({
  videoUrl: 'https://youtu.be/enjkcCdAlXc',
  itag: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
})

const options = {
  hostname: 'localhost',
  port: 5000,
  path: `/api/download?${params}`,
  method: 'GET',
  headers: {
    'User-Agent': 'Node.js Test'
  }
}

const req = http.request(options, (res) => {
  console.log('statusCode', res.statusCode)
  console.log('headers', res.headers)
  let received = 0
  res.on('data', (chunk) => {
    received += chunk.length
    if (received >= 1024) {
      console.log('received first chunk', chunk.length)
      req.abort()
    }
  })
  res.on('end', () => {
    console.log('response ended, total bytes', received)
  })
})

req.on('error', (err) => {
  console.error('request error', err)
})

req.end()
