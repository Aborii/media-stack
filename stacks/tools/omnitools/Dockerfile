# OmniTools, built so the browser never fetches anything from outside the mini.
#
# Upstream's image is a static site, but several tools pull their engines from
# public CDNs the first time they run: ffmpeg from unpkg, the PDF engine, fonts,
# OCR files and the code editor from jsDelivr, the background-removal model from
# img.ly, Ghostscript from a Bunny CDN, icons from the Iconify API, and the image
# editor's labels from a translation service that also reports missing ones
# back. Every page also embeds a GitHub star button.
#
# This build keeps the same app and moves all of that onto the mini:
#   patch-source.mjs  edits the source before the build: drops the star button,
#                     turns off the image editor's translation calls, and
#                     bundles the icons the app uses.
#   vendor.mjs        after the build, copies every engine, model, font and
#                     language file into dist/vendor/, points the app at those
#                     copies, and fails the build if any CDN address is left.
#
# To move to a newer release, change OMNITOOLS_REF and OMNITOOLS_COMMIT
# (`git ls-remote https://github.com/iib0011/omni-tools.git refs/tags/<tag>`).
# The commit is checked because a tag can be moved. If upstream moved one of the
# patched spots, the build stops with the name of the patch that no longer fits.
FROM node:20 AS build

ARG OMNITOOLS_REF=v0.7.0
ARG OMNITOOLS_COMMIT=5f8f4c7b92060f904b40fafb0649701921fe7746

WORKDIR /app
RUN git clone --depth 1 --branch "${OMNITOOLS_REF}" https://github.com/iib0011/omni-tools.git . \
 && test "$(git rev-parse HEAD)" = "${OMNITOOLS_COMMIT}" \
 && npm ci --no-audit --no-fund

COPY patch-source.mjs vendor.mjs /offline/
RUN node /offline/patch-source.mjs
RUN npm run build
RUN node /offline/vendor.mjs

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

# Same two tweaks as upstream's own Dockerfile: serve .mjs as JavaScript, and
# send unknown paths to the single-page app.
RUN sed -i 's/application\/javascript.*js;/application\/javascript                js mjs;/' /etc/nginx/mime.types \
 && sed -i 's|index  index.html index.htm;|index  index.html index.htm;\n        try_files $uri $uri/ /index.html;|' /etc/nginx/conf.d/default.conf

EXPOSE 80
