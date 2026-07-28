const youtubedl = require('youtube-dl-exec');
const url = 'https://www.youtube.com/watch?v=enjkcCdAlXc';
const format = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
console.log('starting');
const proc = youtubedl.raw(url, {
  format,
  output: '-',
  quiet: true,
  noWarnings: true,
  noCallHome: true,
  preferFreeFormats: true,
  youtubeSkipDashManifest: true,
  mergeOutputFormat: 'mp4',
}, { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stderr.on('data', d => { console.error('stderr:', d.toString()); });
proc.stdout.on('data', d => { console.log('stdout chunk', d.length); proc.kill(); });
proc.on('close', code => { console.log('close', code); });
proc.on('error', err => { console.error('proc error', err); });
