# Caddy with the Cloudflare DNS plugin, which the stock image does not have.
#
# A wildcard certificate can only be proven through DNS: Let's Encrypt asks for
# a TXT record under the domain, and the plugin writes it with the Cloudflare
# token. Nothing has to be reachable from the internet for that to work.
#
# Built here, not pulled: there is no official image with the plugin, and the
# community ones are one person's build of a program that holds the token.
# Rebuild to update:  docker compose build --pull && docker compose up -d
ARG CADDY_VERSION=2

FROM caddy:${CADDY_VERSION}-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
