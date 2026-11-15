import { defineConfig } from 'void/config';

export default defineConfig({
  auth: { providers: ['github'] },
  cloudflare: {
    compatibility_date: '2026-07-16',
    compatibility_flags: ['new_module_registry'],
    d1_databases: [
      {
        binding: 'DB',
        database_id: '14903089-ad88-4cce-808a-415dea31d4ac',
        database_name: 'codiff-public',
        migrations_dir: './db/migrations',
      },
    ],
    keep_vars: true,
    migrations: [
      {
        new_sqlite_classes: ['FateLiveDurableObject'],
        tag: 'fate-live-v1',
      },
      {
        deleted_classes: ['FateLiveDurableObject'],
        new_sqlite_classes: ['VoidLiveStreamDurableObject'],
        tag: 'live-v1',
      },
    ],
    name: 'codiff',
    observability: {
      logs: {
        enabled: true,
        invocation_logs: true,
      },
    },
    preview_urls: false,
    r2_buckets: [
      {
        binding: 'WALKTHROUGH_BUCKET',
        bucket_name: 'codiff-public-shares',
      },
    ],
    routes: [
      {
        custom_domain: true,
        pattern: 'codiff.dev',
      },
    ],
    vars: {
      PUBLIC_ORIGIN: 'https://codiff.dev',
    },
    workers_dev: false,
  },
  head: {
    htmlAttrs: { lang: 'en' },
    link: [
      { href: '/icon.png', rel: 'icon' },
      { href: '/apple-touch-icon.png', rel: 'apple-touch-icon' },
    ],
    meta: [
      { charset: 'utf8' },
      { content: 'width=device-width, initial-scale=1.0', name: 'viewport' },
      { content: '#f8f8f6', name: 'theme-color' },
    ],
    title: 'Codiff',
  },
  routing: { typedRoutes: true },
});
