/*
 * YouTube extraction knobs that tend to change more often than the popup UI.
 * Runtime code is still loaded only from extension-packaged files.
 */
globalThis.OCHA_YTDL_YOUTUBE_CONFIG = Object.freeze({
  defaultInnertubeApiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  defaultWebClientVersion: '2.20260114.08.00',
  rangeChunkSize: 10 << 20,
  potProviderUrl: null,
  potFreeSources: ['android_vr', 'tv', 'tv_downgraded'],
  clientNameHeaders: {
    WEB: '1',
    WEB_EMBEDDED_PLAYER: '56',
    WEB_REMIX: '67',
    ANDROID: '3',
    ANDROID_VR: '28',
    IOS: '5',
    TVHTML5: '7'
  },
  innertubeClientProfiles: [
    {
      key: 'tv',
      clientName: 'TVHTML5',
      clientVersion: '7.20260114.12.00',
      includeVisitorData: true,
      contextClient: {
        clientName: 'TVHTML5',
        clientVersion: '7.20260114.12.00',
        hl: 'ja',
        gl: 'JP'
      }
    },
    {
      key: 'tv_downgraded',
      clientName: 'TVHTML5',
      clientVersion: '5.20260114',
      includeVisitorData: true,
      contextClient: {
        clientName: 'TVHTML5',
        clientVersion: '5.20260114',
        userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
        hl: 'ja',
        gl: 'JP'
      }
    },
    {
      key: 'page_web',
      usePageContext: true,
      usePlayerPot: true,
      defaultClientName: 'WEB'
    },
    {
      key: 'android',
      clientName: 'ANDROID',
      clientVersion: '21.02.35',
      contextClient: {
        clientName: 'ANDROID',
        clientVersion: '21.02.35',
        androidSdkVersion: 30,
        userAgent: 'com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip',
        osName: 'Android',
        osVersion: '11',
        hl: 'ja',
        gl: 'JP'
      }
    },
    {
      key: 'ios',
      clientName: 'IOS',
      clientVersion: '21.02.3',
      contextClient: {
        clientName: 'IOS',
        clientVersion: '21.02.3',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        userAgent: 'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        osName: 'iPhone',
        osVersion: '18.3.2.22D82',
        hl: 'ja',
        gl: 'JP'
      }
    },
    {
      key: 'web_safari',
      clientName: 'WEB',
      clientVersionFromPage: true,
      includeVisitorDataFromPage: true,
      usePlayerPot: true,
      contextClient: {
        clientName: 'WEB',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)',
        hl: 'ja',
        gl: 'JP'
      }
    }
  ]
});
