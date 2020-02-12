variable "bucket" {}
variable "key" {}
variable "region" {}
variable "access_key" {}
variable "secret_key" {}

variable "web_host" {}
variable "le_contact" {}
variable "oidc_host" {}
variable "oidc_id" {}
variable "oidc_secret" {}
variable "oidc_email_domain" {}

# terraform init -backend-config=terraform.tfvars
terraform {
  required_version = ">= 0.12"
  backend "s3" {}
}

locals {
  app = var.key
  name = "${local.app}${terraform.workspace == "default" ? "" : "-${terraform.workspace}"}"
}

provider "aws" {
  access_key = var.access_key
  secret_key = var.secret_key
  region = var.region
}

data "external" "app_archive" {
  program = ["sh", "-c", <<EOF
echo '{"tar":"'$(git archive --format=tar.gz master | base64)'"}'
EOF
  ]
  working_dir = ".."
}

resource "aws_s3_bucket_object" "app_archive" {
  bucket = var.bucket
  key = "${local.name}-app-archive.tar.gz"
  content_base64 = data.external.app_archive.result.tar
}

data "aws_ami" "web" {
  most_recent = true
  filter {
    name = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-*-18.04-amd64-server-*"]
  }
  owners = ["099720109477"]
}

resource "aws_vpc" "default" {
  cidr_block = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags = {
    Name = "${local.name}-vpc"
    Terraform = local.name
  }
}

resource "aws_internet_gateway" "default" {
  vpc_id = aws_vpc.default.id
  tags = {
    Name = "${local.name}-gateway"
    Terraform = local.name
  }
}

resource "aws_route" "internet_access" {
  route_table_id = aws_vpc.default.main_route_table_id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.default.id
}

resource "aws_subnet" "a" {
  vpc_id = aws_vpc.default.id
  cidr_block = "10.0.1.0/24"
  availability_zone = "${var.region}a"
  tags = {
    Name = "${local.name}-1"
    Terraform = local.name
  }
}

resource "aws_subnet" "c" {
  vpc_id = aws_vpc.default.id
  cidr_block = "10.0.3.0/24"
  availability_zone = "${var.region}a"
  tags = {
    Name = "${local.name}-3"
    Terraform = local.name
  }
}

resource "aws_security_group" "nfs" {
  name = "${local.name}-security-nfs"
  vpc_id = aws_vpc.default.id
  tags = {
    Terraform = local.name
  }
  
  ingress {
    from_port = 2049
    to_port = 2049
    protocol = "tcp"
    security_groups = [aws_security_group.web.id]
  }
  
  egress {
    from_port = 0
    to_port = 0
    protocol = "-1"
    security_groups = [aws_security_group.web.id]
  }
}

resource "aws_efs_file_system" "tls" {
  tags = {
    Name = "${local.name}-tls"
    Terraform = local.name
  }
}

resource "aws_efs_mount_target" "tls" {
  file_system_id = aws_efs_file_system.tls.id
  subnet_id = aws_subnet.c.id
  security_groups = [aws_security_group.nfs.id]
}

data "aws_ssm_parameter" "admin_cidr_blocks" {
  name = "/${var.bucket}/admin-cidr-blocks"
}

resource "aws_security_group" "web" {
  name = "${local.name}-security-web"
  vpc_id = aws_vpc.default.id
  tags = {
    Terraform = local.name
  }
  
  ingress {
    from_port = 22
    to_port = 22
    protocol = "tcp"
    cidr_blocks = split(",", data.aws_ssm_parameter.admin_cidr_blocks.value)
  }
  
  ingress {
    from_port = 80
    to_port = 80
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  ingress {
    from_port = 443
    to_port = 443
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  egress {
    from_port = 0
    to_port = 0
    protocol = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_key_pair" "app" {
  key_name = local.name
  public_key = file("~/.ssh/aws_${local.app}.pub")
}

resource "aws_instance" "web" {
  instance_type = "t3.micro"
  ami = data.aws_ami.web.id
  vpc_security_group_ids = [aws_security_group.web.id]
  subnet_id = aws_subnet.a.id
  associate_public_ip_address = true
  key_name = aws_key_pair.app.id
  iam_instance_profile = aws_iam_instance_profile.web.name
  root_block_device {
    volume_type = "gp2"
    delete_on_termination = false
  }
  user_data = data.template_cloudinit_config.config_web.rendered
  tags = {
    Name = local.name
    Terraform = local.name
  }
  volume_tags = {
    Name = local.name
    Terraform = local.name
  }
  lifecycle {
    create_before_destroy = true
    ignore_changes = [tags, volume_tags]
  }
}

resource "aws_eip" "web" {
  vpc = true
  tags = {
    Name = local.name
    Terraform = local.name
  }
}

resource "aws_eip_association" "web_address" {
  instance_id = aws_instance.web.id
  allocation_id = aws_eip.web.id
}

data "template_cloudinit_config" "config_web" {
  part {
    content_type = "text/x-shellscript"
    content = file("setup.sh")
  }
  part {
    content_type = "text/cloud-config"
    content = <<-EOF
      write_files:
      - path: /run/${local.app}/env-production.js
        encoding: b64
        content: ${base64encode(data.template_file.env_production.rendered)}
      runcmd:
      - cd /run/${local.app}
      - aws s3 cp s3://${var.bucket}/${aws_s3_bucket_object.app_archive.id} app.tar.gz
      - mkdir /var/${local.app}
      - tar xzf app.tar.gz -C /var/${local.app}
      - mv env-production.js /var/${local.app}/server/config/
      - chmod +x /var/${local.app}/setup/provision.sh
      - ADMIN=ubuntu
        APP=${local.app}
        AWS_DEFAULT_REGION=${var.region}
        EIP=${aws_eip.web.public_ip}
        HOST=${var.web_host}
        CONTACT=${var.le_contact}
        TLS_FS=${aws_efs_file_system.tls.id}
        /var/${local.app}/setup/provision.sh
    EOF
  }
}

resource "random_string" "web_secret" {
  length = 32
}

data "template_file" "env_production" {
  template = file("../server/config/env-production.template.js")
  vars = {
    web_host = var.web_host
    oidc_host = var.oidc_host
    oidc_id = var.oidc_id
    oidc_secret = var.oidc_secret
    oidc_email_domain = var.oidc_email_domain
    web_secret = random_string.web_secret.result
  }
}

data "aws_iam_policy_document" "assume_role_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "web" {
  name = "${local.name}-web-role"
  assume_role_policy = data.aws_iam_policy_document.assume_role_ec2.json
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "web_access" {
  statement {
    actions = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${var.region}:*:instance/*"]
  }
  statement {
    actions = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.bucket}/${local.name}-app-archive.tar.gz"]
  }
}

resource "aws_iam_role_policy" "web" {
  name = "${local.name}-web-access"
  role = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.web_access.json
}

resource "aws_iam_instance_profile" "web" {
  name = "${local.name}-web-profile"
  role = aws_iam_role.web.name
  depends_on = [aws_iam_role_policy.web]
}

output "web-address" { value = aws_eip.web.public_ip }
