# A minimal password-auth SFTP server.
#
# Built here rather than pulled: the widely-used SFTP images are either amd64
# only (so they emulate on Apple Silicon) or configure auth through a bespoke
# JSON schema. This is twelve lines, multi-arch, and does exactly one thing.
#
# Pinned by digest, for the same reason the workflow actions are: a tag is
# mutable, so `alpine:3.20` alone means the test server is whatever was pushed
# under that tag today. The digest is the *manifest list*, not one platform's
# image, so this is still multi-arch and still builds natively on both
# runners and laptops. Dependabot's docker ecosystem bumps it when Alpine
# ships a patch — without that, a pin is just an old image.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache openssh-server openssh-sftp-server \
  && ssh-keygen -A \
  && adduser -D -u 1000 omnifs \
  && echo 'omnifs:omnifs-dev-secret' | chpasswd \
  && mkdir -p /data \
  && chown omnifs:omnifs /data \
  && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
