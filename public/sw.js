self.addEventListener('install', e => self.skipWaiting())
self.addEventListener('activate', e => self.clients.claim())
self.addEventListener('sync', e => {
  if (e.tag === 'sewadar-sync') {
    e.waitUntil((async () => {
      // client will drain on visibility; SW just wakes it
      const clients = await self.clients.matchAll({ type: 'window' })
      clients.forEach(c => c.postMessage({ type: 'SYNC_QUEUED' }))
    })())
  }
})
