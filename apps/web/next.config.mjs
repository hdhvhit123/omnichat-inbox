/** @type {import('next').NextConfig} */
const api = process.env.API_INTERNAL_URL || 'http://localhost:4000';
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // socket.io dùng đường dẫn có dấu / ở cuối (/socket.io/?EIO=4…)
  skipTrailingSlashRedirect: true,
  // Khi chạy sau reverse proxy (Caddy), /api và /socket.io được định tuyến thẳng tới API.
  // Rewrite /api giúp chạy cục bộ không cần proxy; WebSocket cục bộ dùng NEXT_PUBLIC_SOCKET_URL.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }];
  },
};
export default nextConfig;
