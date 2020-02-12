#!/bin/bash

# Apt Repositories
cat > /etc/apt/sources.list.d/nodesource.list <<< 'deb https://deb.nodesource.com/node_12.x bionic main'
wget -qO - https://deb.nodesource.com/gpgkey/nodesource.gpg.key | apt-key add -
add-apt-repository ppa:certbot/certbot
apt-get update

# Apt packages
apt-get install -y python-pip jq nodejs build-essential certbot git

# AWS CLI
pip install awscli --upgrade

# Time zone
timedatectl set-timezone America/New_York
