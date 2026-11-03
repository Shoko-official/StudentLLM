import type { ProxyOptions } from 'vite';

/** Vite pipes a proxied body and never ends it when the upstream dies midway, which would hang a streamed answer until the provider's own timer. */
export const endResponseWhenUpstreamDies: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyRes', (proxyRes, _req, res) => proxyRes.on('close', () => {
    if (!proxyRes.complete) res.destroy();
  }));
};
