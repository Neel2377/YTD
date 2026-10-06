const youtubedl = require('youtube-dl-exec')

const url = 'https://www.youtube.com/watch?v=enjkcCdAlXc'
const cp = youtubedl.exec(url, { format: 18 }, { stdio: ['ignore', 'pipe', 'pipe'] })

cp.catch((error) => {
  console.log('exec error', error?.message || 'unknown error')
  console.log('stderr', error?.stderr || '')
})

console.log('cp type', Object.prototype.toString.call(cp))
console.log('has stdout', !!cp.stdout, typeof cp.stdout)
console.log('keys', Object.keys(cp))
console.log('stdout keys', cp.stdout ? Object.keys(cp.stdout) : null)
console.log('stderr keys', cp.stderr ? Object.keys(cp.stderr) : null)

