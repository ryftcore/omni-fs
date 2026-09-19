# A minimal password-auth SFTP server.
#
# Built here rather than pulled: the widely-used SFTP images are either amd64
# only (so they emulate on Apple Silicon) or configure auth through a bespoke
# JSON schema. This is twelve lines, multi-arch, and does exactly one thing.
FROM alpine:3.20

RUN apk add --no-cache openssh-server openssh-sftp-server \
  && ssh-keygen -A \
  && adduser -D -u 1000 omnifs \
  && echo 'omnifs:omnifs-dev-secret' | chpasswd \
  && mkdir -p /data \
  && chown omnifs:omnifs /data \
  && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
