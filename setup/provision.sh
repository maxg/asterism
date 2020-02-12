#!/bin/bash

set -eux

instance_id=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)

# Output and tag SSH host key fingerprints
for f in /etc/ssh/ssh_host_*key.pub; do ssh-keygen -l -f "$f"; done |
while read _ hash _ type; do echo "Key=SSH $type,Value=$hash"; done |
xargs -d "\n" aws ec2 create-tags --resources $instance_id --tags

cd /var/$APP

# Create daemon user
adduser --system $APP

# Set permissions
chown -R $ADMIN:$ADMIN /var/$APP
chown -R $APP:$ADMIN /var/$APP/server/courses

# Allow app to bind to well-known ports
apt-get install -y authbind
for port in 80 443; do
  touch /etc/authbind/byport/$port
  chown $APP /etc/authbind/byport/$port
  chmod u+x /etc/authbind/byport/$port
done

# Install AWS EFS mount helper
(
  cd /tmp
  git clone https://github.com/aws/efs-utils
  cd efs-utils
  ./build-deb.sh
  apt-get install -y ./build/amazon-efs-utils*deb
)

# Mount TLS filesystem
sudo tee --append /etc/fstab <<< "$TLS_FS:/ /etc/letsencrypt efs tls,_netdev 0 0"
sudo mount /etc/letsencrypt

# Install Node.js packages
(
  cd server
  sudo -u $ADMIN npm install --production
)

# Daemon
cat > /lib/systemd/system/$APP.service <<EOD
[Unit]
After=network.target

[Service]
User=$APP
ExecStart=/var/$APP/server/bin/$APP

[Install]
WantedBy=multi-user.target
EOD

# Security updates
cat > /etc/apt/apt.conf.d/25auto-upgrades <<EOD
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOD

# Wait for instance to have assigned IP
while [ $(curl -s http://169.254.169.254/latest/meta-data/public-ipv4) != $EIP ]; do sleep 2; done

# Start Certbot
sudo certbot certonly --standalone --non-interactive --agree-tos --email $CONTACT --domains $HOST
(
  cd /etc/letsencrypt
  sudo tee renewal-hooks/post/permit <<EOD
cd /etc/letsencrypt
chmod o+x archive live
chown -R $APP archive/$HOST
EOD
  sudo chmod +x renewal-hooks/post/permit
  sudo renewal-hooks/post/permit
)
sudo systemctl --now enable certbot.timer
ln -s /etc/letsencrypt/live/$HOST /var/$APP/server/config/tls

# Start daemon
sudo systemctl --now enable $APP
