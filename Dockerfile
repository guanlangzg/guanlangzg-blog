FROM node:24-alpine AS deps

WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline --no-audit && \
    npm cache clean --force && \
    rm -rf /root/.npm /tmp/*

FROM node:24-alpine AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.mjs tsconfig.json postcss.config.mjs tailwind.config.ts vitest.config.ts eslint.config.mjs ./
COPY src ./src
COPY public ./public
COPY content ./content
COPY tests ./tests
COPY scripts ./scripts

# CJK fonts are required for the SVG share-card text rendered by sharp during
# in-container public builds; without fontconfig the og images lose all text.
RUN apk add --no-cache fontconfig font-noto-cjk

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    NEXT_PUBLIC_SITE_URL=https://guanlangzg.github.io

# Build both applications with the same locked dependency set. The synthetic
# export catches public-builder closure errors before an image is released.
RUN npm run lint && \
    npm run typecheck && \
    npm run build && \
    node -e "const fs=require('fs');fs.mkdirSync('/var/lib/guanlan/build/image-probe-input',{recursive:true});fs.writeFileSync('/var/lib/guanlan/build/image-probe-input/probe.json',JSON.stringify({releaseId:'image-probe',site:{title:'观澜志',description:'镜像构建探测'},posts:[{slug:'探测',title:'探测',description:'探测',date:'2026-09-30',tags:[],content:'探测'}],navigation:[]}))" && \
    BLOG_BUILD_ROOT=/var/lib/guanlan/build node scripts/public-site/build.mjs --snapshot /var/lib/guanlan/build/image-probe-input/probe.json --out /var/lib/guanlan/build/image-probe-output && \
    test -f /var/lib/guanlan/build/image-probe-output/image-probe/app/out/index.html && \
    rm -rf /var/lib/guanlan/build/image-probe-input /var/lib/guanlan/build/image-probe-output /app/.g01-public-site-* /app/.next/cache node_modules/.cache /tmp/*

FROM node:24-alpine AS runner

WORKDIR /app
ARG APP_VERSION=unknown
ARG APP_IMAGE_TAG=unknown
ARG APP_REVISION=unknown
ARG APP_BUILD_TIME=unknown

ENV NODE_ENV=production \
    HOME=/home/nextjs \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SITE_URL=https://guanlangzg.github.io \
    BLOG_DATA_ROOT=/var/lib/guanlan/data \
    BLOG_SECRET_ROOT=/var/lib/guanlan/secrets \
    BLOG_BUILD_ROOT=/var/lib/guanlan/build \
    BLOG_NAVIGATION_DOCKER=true \
    BLOG_NAVIGATION_VERSION=${APP_VERSION} \
    BLOG_NAVIGATION_IMAGE_TAG=${APP_IMAGE_TAG} \
    BLOG_NAVIGATION_REVISION=${APP_REVISION} \
    BLOG_NAVIGATION_BUILD_TIME=${APP_BUILD_TIME}

# Keep the standalone management server under its own predictable root. The
# separate public builder project at /app retains shared code and dev build tools.
RUN apk add --no-cache curl su-exec libc6-compat fontconfig font-noto-cjk && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir -p /home/nextjs /tmp /var/lib/guanlan/data /var/lib/guanlan/secrets /var/lib/guanlan/build \
        /app/management/.next/cache /app/management/src/lib /app/management/scripts/admin \
        /app/management/scripts/runtime /app/management/public \
        /app/scripts/public-site \
        /app/management/content/seeds /app/src/lib/public-build \
        /app/src/public-site /app/src/public-site/app /app/src/public-site/app/blog \
        /app/src/public-site/app/blog/[...slug] /app/src/public-site/app/navigation \
        /app/src/public-site/app/search /app/src/public-site/app/search-index.json \
        /app/src/public-site/app/feed.xml /app/src/public-site/app/posts/[slug] \
        /app/src/public-site/components /app/src/public-site/views \
        /app/src/app/components/ui \
        /app/src/app/components/markdown /app/src/app/components/theme \
        /app/src/app/styles /app/src/app/types /app/public /app/content/seeds && \
    chown nextjs:nodejs /app /home/nextjs /tmp /var/lib/guanlan/data /var/lib/guanlan/secrets \
        /var/lib/guanlan/build /app/management /app/management/.next/cache \
        /app/management/src /app/management/src/lib /app/management/scripts \
        /app/management/scripts/admin /app/management/scripts/runtime \
        /app/management/content /app/management/content/seeds /app/management/public \
        /app/scripts /app/scripts/public-site /app/src/lib /app/src/lib/public-build \
        /app/src/public-site /app/src/public-site/app /app/src/public-site/components \
        /app/src/public-site/views /app/src/app/components /app/src/app/components/ui \
        /app/src/app/components/markdown /app/src/app/components/theme \
        /app/src/app/styles /app/src/app/types /app/public /app/content /app/content/seeds && \
    rm -rf /var/cache/apk/* /tmp/*

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone /app/management
COPY --from=builder --chown=nextjs:nodejs /app/.next/static /app/management/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public /app/management/public
COPY --from=builder --chown=nextjs:nodejs /app/content/seeds /app/management/content/seeds
COPY --from=builder --chown=nextjs:nodejs /app/scripts/admin /app/management/scripts/admin
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/atomic-json-writer.ts /app/src/lib/editor-auth-password.ts /app/src/lib/editor-auth-runtime.ts /app/src/lib/editor-auth.ts /app/src/lib/runtime-config.ts /app/src/lib/runtime-environment.ts /app/management/src/lib/
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/package-lock.json /app/management/

COPY --from=builder --chown=nextjs:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/package-lock.json /app/next.config.mjs /app/tsconfig.json /app/
COPY --from=builder --chown=nextjs:nodejs /app/postcss.config.mjs /app/postcss.config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/tailwind.config.ts /app/tailwind.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/public-site /app/scripts/public-site
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/layout.tsx /app/src/public-site/app/globals.css /app/src/public-site/app/page.tsx /app/src/public-site/app/not-found.tsx /app/src/public-site/app/sitemap.ts /app/src/public-site/app/robots.ts /app/src/public-site/app/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/blog/page.tsx /app/src/public-site/app/blog/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/blog/[[]...slug]/page.tsx /app/src/public-site/app/blog/[...slug]/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/navigation/page.tsx /app/src/public-site/app/navigation/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/search/page.tsx /app/src/public-site/app/search/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/search-index.json/route.ts /app/src/public-site/app/search-index.json/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/feed.xml/route.ts /app/src/public-site/app/feed.xml/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/app/posts/[[]slug]/page.tsx /app/src/public-site/app/posts/[slug]/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/components/SiteHeader.tsx /app/src/public-site/components/SearchView.tsx /app/src/public-site/components/ThemeInitScript.tsx /app/src/public-site/components/LegacyRemovedView.tsx /app/src/public-site/components/
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/views /app/src/public-site/views
COPY --from=builder --chown=nextjs:nodejs /app/src/public-site/paths.ts /app/src/public-site/snapshot.ts /app/src/public-site/search-index.ts /app/src/public-site/types.ts /app/src/public-site/
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/public-build/runner.ts /app/src/lib/public-build/
COPY --from=builder --chown=nextjs:nodejs /app/src/app/components/ui/PostCard.tsx /app/src/app/components/ui/PageHero.tsx /app/src/app/components/ui/
COPY --from=builder --chown=nextjs:nodejs /app/src/app/components/markdown/MarkdownContent.tsx /app/src/app/components/markdown/CopyCodeButton.tsx /app/src/app/components/markdown/
COPY --from=builder --chown=nextjs:nodejs /app/src/app/components/theme/ThemeToggle.tsx /app/src/app/components/theme/useTheme.ts /app/src/app/components/theme/
COPY --from=builder --chown=nextjs:nodejs /app/src/app/styles/design-tokens.css /app/src/app/styles/markdown-preview.css /app/src/app/styles/
COPY --from=builder --chown=nextjs:nodejs /app/src/app/types/article.ts /app/src/app/types/
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/article-metadata.ts /app/src/lib/article-quality.ts /app/src/lib/search-query.ts /app/src/lib/url-safety.ts /app/src/lib/utils.ts /app/src/lib/
COPY --from=builder --chown=nextjs:nodejs /app/public /app/public
COPY --from=builder --chown=nextjs:nodejs /app/content/seeds /app/content/seeds
COPY --chmod=755 deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh

WORKDIR /app/management
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000
CMD ["node", "server.js"]
