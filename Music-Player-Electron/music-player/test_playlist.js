const { createBinaries } = require('./binaries.js');
const { createDownloader } = require('./downloader.js');
const path = require('path');
const os = require('os');

async function test() {
  const binaries = createBinaries({
    resourcesBinDir: path.join(__dirname, 'bin'),
    userBinDir: path.join(os.tmpdir(), 'music-player-bin')
  });
  
  await binaries.prepare();
  
  const d = createDownloader({
    binaries,
    downloadsDir: path.join(os.tmpdir(), 'music-player-dl'),
    publish: (msg) => console.log('PUBLISH:', msg),
    log: (...args) => console.log('LOG:', ...args)
  });
  
  // Actually, I can just call getInfo from yt-dlp to see what yt-dlp outputs
  const url = 'https://www.youtube.com/playlist?list=PLlaN88a7y2_plecYoJcVANTcdc5OkoAqY'; // test playlist
  
  console.log('Running yt-dlp getInfo...');
  const res = await binaries.run([
    ...binaries.commonArgs(),
    '--flat-playlist', '-J', '--no-warnings',
    '--', url
  ]);
  
  console.log('Code:', res.code);
  if (res.stderr) console.log('Stderr:', res.stderr.slice(0, 500));
  try {
    const info = JSON.parse(res.stdout);
    console.log('Type:', info._type);
    console.log('Entries length:', info.entries ? info.entries.length : 'none');
    if (info.entries && info.entries.length > 0) {
      console.log('First entry keys:', Object.keys(info.entries[0]));
      console.log('First entry id:', info.entries[0].id);
      console.log('First entry url:', info.entries[0].url);
    }
  } catch(e) {
    console.log('Parse error', e.message);
  }
}

test();
