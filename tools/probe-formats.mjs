const DEFAULT_INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node tools/probe-formats.mjs <youtube-video-id-or-url>');
  process.exit(1);
}

const videoId = extractVideoId(input);
if (!videoId) {
  console.error(`Invalid YouTube video id or URL: ${input}`);
  process.exit(1);
}

const watchHtml = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
  headers: { 'User-Agent': 'Mozilla/5.0' },
}).then(resp => resp.text());

const ytcfg = Object.assign({}, ...[...watchHtml.matchAll(/ytcfg\.set\((\{.+?\})\);/gs)]
  .map(match => JSON.parse(match[1])));
const apiKey = ytcfg.INNERTUBE_API_KEY || DEFAULT_INNERTUBE_API_KEY;

const clients = [
  ['android', '3', '21.02.35', {
    clientName: 'ANDROID',
    clientVersion: '21.02.35',
    androidSdkVersion: 30,
    userAgent: 'com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip',
    osName: 'Android',
    osVersion: '11',
    hl: 'ja',
    gl: 'JP',
  }],
  ['ios', '5', '21.02.3', {
    clientName: 'IOS',
    clientVersion: '21.02.3',
    deviceMake: 'Apple',
    deviceModel: 'iPhone16,2',
    userAgent: 'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    osName: 'iPhone',
    osVersion: '18.3.2.22D82',
    hl: 'ja',
    gl: 'JP',
  }],
];

for (const [name, clientHeader, clientVersion, client] of clients) {
  const data = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': clientHeader,
      'X-YouTube-Client-Version': clientVersion,
    },
    body: JSON.stringify({
      context: { client },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS',
        },
      },
    }),
  }).then(resp => resp.json());

  const formats = [...(data.streamingData?.formats || []), ...(data.streamingData?.adaptiveFormats || [])];
  console.log(`\n${name}: ${data.playabilityStatus?.status || 'unknown'} formats=${formats.length} url=${formats.filter(fmt => fmt.url).length}`);

  for (const fmt of formats.filter(fmt => fmt.url).slice(0, 16)) {
    const probe = await probeUrl(fmt.url);
    console.log([
      `itag=${fmt.itag}`,
      `quality=${fmt.qualityLabel || fmt.audioQuality || '-'}`,
      `mime=${fmt.mimeType || '-'}`,
      `status=${probe.status}`,
      `type=${probe.contentType || '-'}`,
      `sample=${probe.sample}`,
    ].join(' | '));
  }
}

function extractVideoId(value) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value);
    if (url.pathname === '/watch') return normalizeVideoId(url.searchParams.get('v'));
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
      return normalizeVideoId(parts[1]);
    }
  } catch (_) {}

  return null;
}

function normalizeVideoId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(value) ? value : null;
}

async function probeUrl(url) {
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-127' } });
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return {
      status: resp.status,
      contentType: resp.headers.get('content-type'),
      sample: new TextDecoder('utf-8', { fatal: false })
        .decode(bytes)
        .replace(/[\x00-\x08\x0e-\x1f]/g, '.')
        .slice(0, 80),
    };
  } catch (e) {
    return { status: 'ERR', contentType: '', sample: e.message || String(e) };
  }
}
