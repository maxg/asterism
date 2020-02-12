module.exports = {
  hostname: '10.18.6.212',
  oidc: {
    server: 'https://oidc.example.com',
    client: {
      client_id: 'asterism',
      client_secret: ...,
      redirect_uris: [ 'https://10.18.6.212:4443/auth' ],
    },
    email_domain: 'example.com',
  },
  web_secret: ...,
};
