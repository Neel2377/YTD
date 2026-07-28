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
    'User-Agent': 'NodeTest',
  },
}

const req = http.request(options, (res) => {
  console.log('status', res.statusCode)
  console.log('headers', res.headers)
  let total = 0
  res.on('data', (chunk) => {
    total += chunk.length
    console.log('chunk', chunk.length)
    if (total >= 1024) {
      console.log('received 1KB, aborting')
      req.abort()
    }
  })
  res.on('end', () => console.log('end', total))
})

req.on('error', (err) => console.error('req error', err.message))
req.end()
