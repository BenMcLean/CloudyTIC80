# End-to-end tests

Real-browser tests (Playwright) against a running CloudyTIC80 container. They are the gate in
`.github/workflows/docker-publish.yml`: an image is only pushed if they pass.

Most important: **a cart saved in the TIC-80 console ends up on the server** (and only for its
owner), and is loaded back from the server into a clean browser.

## Run locally

From the repository root:

```sh
docker build -t cloudytic80:test .
mkdir -p cfg && cp tests/webdav-config.test.yml cfg/webdav-config.yml
docker run -d --name ct80test -p 8080:80 -v "$PWD/cfg:/config" cloudytic80:test
cd tests && npm ci && npx playwright install --with-deps chromium && npx playwright test
docker rm -f ct80test
```

`BASE_URL`, `ALICE_PASSWORD`, `BOB_PASSWORD` override the defaults.
