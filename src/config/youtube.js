/*
 * YouTube extraction knobs that tend to change more often than the popup UI.
 * Runtime code is still loaded only from extension-packaged files.
 */
globalThis.OCHA_YTDL_YOUTUBE_CONFIG = Object.freeze({
  defaultInnertubeApiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  defaultWebClientVersion: '2.20260708.00.00',
  rangeChunkSize: 10 << 20,
  potProviderUrl: null,
  potFreeSources: ['android_vr', 'visionos', 'tv', 'tv_downgraded'],
  clientNameHeaders: {
    WEB: '1',
    WEB_EMBEDDED_PLAYER: '56',
    WEB_REMIX: '67',
    ANDROID: '3',
    ANDROID_VR: '28',
    VISIONOS: '101',
    IOS: '5',
    TVHTML5: '7'
  },
  innertubeClientProfiles: [
    {
      // 直URL/pot不要/JSプレーヤー不要(n,sig無し)。2026-08実測: android_vrが約42MBから
      // 403の壁を持つようになった(yt-dlp issue #17348, GVS PO Token要求化)一方、visionosは
      // 同時点で壁なし(150MB地点まで200確認)。そのため最優先はvisionosにしてある。
      key: 'visionos',
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      contextClient: {
        clientName: 'VISIONOS',
        clientVersion: '1.02',
        deviceMake: 'Apple',
        deviceModel: 'RealityDevice17,1',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
        osName: 'visionOS',
        osVersion: '26.5.23O471',
        hl: 'ja',
        gl: 'JP'
      }
    },
    {
      key: 'tv',
      clientName: 'TVHTML5',
      clientVersion: '7.20260707.07.00',
      includeVisitorData: true,
      contextClient: {
        clientName: 'TVHTML5',
        clientVersion: '7.20260707.07.00',
        // See: https://github.com/youtube/cobalt/blob/main/cobalt/browser/user_agent/user_agent_platform_info.cc#L506
        userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
        hl: 'ja',
        gl: 'JP'
      }
    },
    {
      key: 'tv_downgraded',
      clientName: 'TVHTML5',
      clientVersion: '5.20260707',
      includeVisitorData: true,
      contextClient: {
        clientName: 'TVHTML5',
        clientVersion: '5.20260707',
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
      clientVersion: '21.26.364',
      contextClient: {
        clientName: 'ANDROID',
        clientVersion: '21.26.364',
        androidSdkVersion: 30,
        userAgent: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
        osName: 'Android',
        osVersion: '11',
        hl: 'ja',
        gl: 'JP'
      }
    },
    {
      key: 'ios',
      clientName: 'IOS',
      clientVersion: '21.26.4',
      contextClient: {
        clientName: 'IOS',
        clientVersion: '21.26.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
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
    },
    {
      // 2026-08-18: android_vr の直URL機能はサーバ側で無効化された(yt-dlp issue #17456で
      // 世界規模の同時多発403として確定)。この clientVersion(1.65.10)はまだ直URLらしき
      // ものを返すが実際には403になる「死んだ経路」。他の全クライアントが失敗した時の
      // 最終手段としてのみ残す(ユーザー指示、2026-08-18)。詳細 [[tech-potoken]]。
      key: 'android_vr',
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      contextClient: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.65.10',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        osName: 'Android',
        osVersion: '12L',
        hl: 'ja',
        gl: 'JP'
      }
    }
  ]
});
