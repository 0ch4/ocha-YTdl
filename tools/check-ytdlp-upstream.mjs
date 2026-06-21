if (!process.argv.includes('--sync-compat')) {
  process.argv.push('--sync-compat');
}

await import('./update-ytdlp-vendor.mjs');
