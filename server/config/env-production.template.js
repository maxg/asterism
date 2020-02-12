module.exports = {
  hostname: '${web_host}',
  oidc: {
    server: 'https://${oidc_host}',
    client: {
      client_id: '${oidc_id}',
      client_secret: '${oidc_secret}',
      redirect_uris: [ 'https://${web_host}/auth' ],
    },
    email_domain: '${oidc_email_domain}',
  },
  web_secret: '${web_secret}',
};
