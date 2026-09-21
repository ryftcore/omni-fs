# A minimal FTP/FTPS server with three listeners: plain and explicit TLS on 21,
# implicit TLS on 990, and a TLS-1.0-only listener on 2100 for the legacy
# server the tlsMinVersion setting exists to reach.
#
# Built here rather than pulled, and pinned by digest, for the same reasons
# docker/sftp is: a tag is mutable, so the test server would otherwise be
# whatever was pushed under it today. The digest is the manifest list, not one
# platform's image, so this still builds natively on both runners and laptops.
# Dependabot's docker ecosystem bumps it when Alpine ships a patch.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache vsftpd openssl \
  && adduser -D -u 1001 -h /data omnifs \
  && echo 'omnifs:omnifs-dev-secret' | chpasswd \
  && mkdir -p /data /var/run/vsftpd/empty /etc/vsftpd \
  && chown omnifs:omnifs /data \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
       -subj '/CN=localhost' \
       -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
       -keyout /etc/vsftpd/vsftpd.key \
       -out /etc/vsftpd/vsftpd.crt \
  && chmod 600 /etc/vsftpd/vsftpd.key

COPY vsftpd-common.conf /etc/vsftpd/vsftpd-common.conf
COPY explicit.conf /etc/vsftpd/explicit.conf.part
COPY implicit.conf /etc/vsftpd/implicit.conf.part
COPY legacy.conf /etc/vsftpd/legacy.conf.part
COPY openssl-legacy.cnf /etc/vsftpd/openssl-legacy.cnf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# vsftpd takes one config file and has no include directive, so the shared part
# is concatenated in at build time rather than repeated three times by hand.
RUN for name in explicit implicit legacy; do \
      cat /etc/vsftpd/vsftpd-common.conf "/etc/vsftpd/$name.conf.part" > "/etc/vsftpd/$name.conf"; \
      rm "/etc/vsftpd/$name.conf.part"; \
    done \
  && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 21 990 2100 21000-21032
CMD ["/usr/local/bin/entrypoint.sh"]
